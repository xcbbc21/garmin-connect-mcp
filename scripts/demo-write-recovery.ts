/**
 * Reproducible demonstrations for the three recovery scenarios the delivery
 * requires:
 *
 *   1. a superseded journal record must not shadow a newer one, and a repeat
 *      request must not re-dispatch a write that already happened;
 *   2. a batch that mixes an `unknown` step with a new one must keep per-item
 *      accounting complete, block only the occupied key, and never re-send it;
 *   3. a second process must be able to read the journal a killed process left
 *      behind, reconcile it without writing to Garmin, and resume only what it
 *      can prove was never sent.
 *
 * Every demo drives the real built MCP server as a child process against the
 * out-of-process fake Garmin peer, so the payloads and the write counts are
 * observed rather than composed, and each demo gets its own peer so the call
 * ordinals that arm the faults are per-demo. Run it with:
 *
 *   npm run demo:recovery
 *
 * Each demo prints the evidence it asserts on and exits non-zero on the first
 * failed assertion, so the output is a runnable claim, not a transcript.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { accountKey } from '../src/write-operations/identity'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_FIXTURE = path.join(REPO, 'tests/fixtures/stdio-garmin-http.cjs')
const PEER_FIXTURE = path.join(REPO, 'tests/fixtures/fake-garmin-server.cjs')

const ACCOUNT = 'demo@example.test'
const REGION = 'cn'
const TIMEZONE = 'Asia/Shanghai'

const MON = '2026-09-14'
const TUE = '2026-09-15'
const WED = '2026-09-16'

const EASY_RUN = {
  name: 'Easy run 8 km',
  sport: 'running',
  steps: [
    { type: 'warmup', endCondition: 'time', endValue: 600 },
    { type: 'interval', endCondition: 'distance', endValue: 8000 },
  ],
}

const TEMPO_RUN = {
  name: 'Tempo 3 x 8 min',
  sport: 'running',
  steps: [
    { type: 'warmup', endCondition: 'time', endValue: 900 },
    { type: 'repeat', iterations: 3, steps: [
      { type: 'interval', endCondition: 'time', endValue: 480 },
      { type: 'recovery', endCondition: 'time', endValue: 120 },
    ] },
  ],
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`DEMO ASSERTION FAILED: ${message}`)
}

function sameWorkoutAndDate(post: { workoutId?: unknown; date?: unknown }, workoutId: string, date: string) {
  return String(post.workoutId) === workoutId && post.date === date
}

/** True only when the pid is gone; an EPERM means it still exists for us. */
function pidIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

/** Out-of-process fake Garmin. Faults are armed per POST ordinal. */
class Peer {
  private constructor(readonly url: string, private readonly child: ChildProcess) {}

  static async start(): Promise<Peer> {
    const directory = await mkdtemp(path.join(tmpdir(), 'demo-peer-'))
    const portFile = path.join(directory, 'port')
    const child = spawn(process.execPath, [PEER_FIXTURE, portFile], { stdio: ['ignore', 'ignore', 'pipe'] })
    child.stderr?.on('data', () => undefined)
    const deadline = Date.now() + 20_000
    for (;;) {
      try {
        const port = (await readFile(portFile, 'utf8')).trim()
        if (port) return new Peer(`http://127.0.0.1:${port}`, child)
      } catch { /* the port file is not written yet */ }
      if (Date.now() > deadline) {
        child.kill('SIGKILL')
        throw new Error('fake Garmin peer did not start within 20 s')
      }
      await sleep(25)
    }
  }

  async state(): Promise<any> {
    return await (await fetch(`${this.url}/__state`)).json()
  }

  async fault(mode: string, fromCall = 1): Promise<void> {
    await fetch(`${this.url}/__fault`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode, fromCall }),
    })
  }

  postsFor(state: any, workoutId: string, date: string) {
    return state.posts.filter((post: any) => sameWorkoutAndDate(post, workoutId, date))
  }

  stop() {
    this.child.kill('SIGKILL')
  }
}

interface Harness {
  client: Client
  pid: number | null
  exited: Promise<void>
  kill(): void
  close(): Promise<void>
}

/** Every open child, so a failed assertion can still tear the run down. */
const OPEN_HARNESSES = new Set<Harness>()

async function open(stateDirectory: string, peer: Peer, env: Record<string, string> = {}): Promise<Harness> {
  const client = new Client({ name: 'demo-write-recovery', version: '1' })
  const sessionFile = path.join(stateDirectory, 'session.json')
  await writeFile(sessionFile, JSON.stringify({ fixture: 'demo' }), 'utf8').catch(() => undefined)
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_FIXTURE],
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      FAKE_GARMIN_URL: peer.url,
      GARMIN_STATE_DIR: stateDirectory,
      GARMIN_USERNAME: ACCOUNT,
      GARMIN_REGION: REGION,
      GARMIN_SESSION_TOKEN_FILE: sessionFile,
      FAKE_GARMIN_LOCK_WAIT_MS: '400',
      ...env,
    },
    stderr: 'pipe',
  })
  transport.stderr?.on('data', () => undefined)
  const exited = new Promise<void>(resolve => { transport.onclose = () => resolve() })
  await client.connect(transport)
  const harness: Harness = {
    client,
    pid: transport.pid,
    exited,
    kill: () => {
      if (!transport.pid) return
      try {
        process.kill(transport.pid, 'SIGKILL')
      } catch {
        // The child is already gone; a kill is best effort by design.
      }
    },
    close: async () => {
      OPEN_HARNESSES.delete(harness)
      await client.close().catch(() => undefined)
    },
  }
  OPEN_HARNESSES.add(harness)
  return harness
}

/** Tear down every child still open, so a failure cannot hang the run. */
async function closeAllHarnesses(): Promise<void> {
  for (const harness of [...OPEN_HARNESSES]) {
    harness.kill()
    await harness.close()
  }
  OPEN_HARNESSES.clear()
}

/** Run `fn` against a fresh process and close it afterwards. */
async function withHarness<T>(
  stateDirectory: string,
  peer: Peer,
  env: Record<string, string>,
  fn: (harness: Harness) => Promise<T>,
): Promise<T> {
  const harness = await open(stateDirectory, peer, env)
  try {
    return await fn(harness)
  } finally {
    await harness.close()
  }
}

async function call(harness: Harness, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await harness.client.callTool({ name, arguments: args })
  const text = (result.content as Array<{ text: string }>)[0].text
  let payload: any
  try { payload = JSON.parse(text) } catch { payload = { raw: text } }
  return { isError: Boolean(result.isError), ...payload }
}

function show(label: string, value: unknown) {
  console.log(`\n### ${label}`)
  console.log(JSON.stringify(value, null, 2))
}

function stepOf(receipt: any, date: string) {
  return (receipt?.results ?? []).find((entry: any) => entry.date === date)
}

/** The journal record, read back through the redacting read tool. */
async function readOperation(harness: Harness, operationId: string) {
  const result = await call(harness, 'get_garmin_write_operation', { operationId })
  assert(result.found === true, `operation ${operationId} should be found: ${JSON.stringify(result)}`)
  return result.operation as any
}

function journalStep(operation: any, date: string) {
  return (operation?.steps ?? []).find((step: any) => step.date === date)
}

/** Create a template and return its id, going through the real MCP layer. */
async function createTemplate(harness: Harness, definition: Record<string, unknown>, key: string) {
  const preview = await call(harness, 'create_garmin_workout', { ...definition, idempotencyKey: key })
  assert(preview.requiresConfirmation === true, `create preview for ${key} should require confirmation`)
  const done = await call(harness, 'create_garmin_workout', {
    ...definition,
    idempotencyKey: key,
    confirmed: true,
    confirmationId: preview.confirmationId,
  })
  assert(done.isError === false, `create for ${key} should not be an error: ${JSON.stringify(done)}`)
  return { workoutId: String(done.workoutId), operationId: String(preview.operationId) }
}

async function demoOneHistoryShadowing(peer: Peer) {
  console.log('\n================ DEMO 1: a superseded record must not shadow a newer one ================')
  const stateDirectory = await mkdtemp(path.join(tmpdir(), 'demo-state-'))

  try {
    await withHarness(stateDirectory, peer, {}, async harness => {
      const easy = await createTemplate(harness, EASY_RUN, 'demo-tpl-easy')
      const tempo = await createTemplate(harness, TEMPO_RUN, 'demo-tpl-tempo')
      show('templates created', { easy: easy.workoutId, tempo: tempo.workoutId })

      // Monday is previewed on its own first and never confirmed.
      const single = await call(harness, 'schedule_garmin_workout', {
        workoutId: easy.workoutId, date: MON, timezone: TIMEZONE, idempotencyKey: 'demo-week-plan-a',
      })
      assert(single.requiresConfirmation === true, 'the single-day preview should require confirmation')

      // A widened batch covering the same Monday plus Tuesday supersedes it.
      const batchArgs = {
        timezone: TIMEZONE,
        schedules: [
          { workoutId: easy.workoutId, date: MON },
          { workoutId: tempo.workoutId, date: TUE },
        ],
        idempotencyKey: 'demo-week-plan-b',
      }
      const batch = await call(harness, 'batch_schedule_garmin_workouts', batchArgs)
      assert(batch.requiresConfirmation === true, 'the widened preview should require confirmation')

      const superseded = await readOperation(harness, String(single.operationId))
      const supersededMonday = journalStep(superseded, MON)
      show('the superseded record now holds a stale Monday step', {
        operationId: single.operationId,
        status: supersededMonday?.status,
        errorCode: supersededMonday?.errorCode,
        canResume: supersededMonday?.canResume,
      })
      assert(
        supersededMonday?.status === 'not_attempted',
        `the superseded Monday step should be not_attempted, got ${String(supersededMonday?.status)}`,
      )

      const confirmed = await call(harness, 'batch_schedule_garmin_workouts', {
        ...batchArgs, confirmed: true, confirmationId: batch.confirmationId,
      })
      show('the widened batch was confirmed', {
        success: confirmed.success,
        results: (confirmed.results ?? []).map((entry: any) => ({
          date: entry.date, status: entry.status, workoutScheduleId: entry.workoutScheduleId,
        })),
      })
      assert(confirmed.success === true, 'the widened batch should succeed')

      const newer = await readOperation(harness, String(batch.operationId))
      const newerMonday = journalStep(newer, MON)
      show('the journal now holds, for one business key, a stale step AND a newer receipt', {
        operationId: batch.operationId,
        status: newerMonday?.status,
        evidence: newerMonday?.evidence,
        workoutScheduleId: newerMonday?.workoutScheduleId,
      })
      assert(
        newerMonday?.status === 'succeeded',
        `the newer Monday step should be succeeded, got ${String(newerMonday?.status)}`,
      )

      // A repeat with no idempotencyKey: the journal already holds the outcome.
      // A first-match scan would find the stale `not_attempted` first and offer
      // a brand-new confirmation, re-sending a write that already happened.
      const anonymous = await call(harness, 'schedule_garmin_workout', {
        workoutId: easy.workoutId, date: MON, timezone: TIMEZONE,
      })
      show('asking for Monday again with no idempotencyKey returns', {
        success: anonymous.success,
        requiresConfirmation: anonymous.requiresConfirmation,
        action: anonymous.action,
        status: anonymous.status,
        operationId: anonymous.operationId,
        message: anonymous.message,
      })
      assert(
        anonymous.requiresConfirmation !== true,
        'a repeat for Monday must not be offered as a new confirmation',
      )
      assert(anonymous.action === 'skip_existing', `Monday should be skip_existing, got ${String(anonymous.action)}`)
      assert(anonymous.success === true, 'the durable receipt should report the desired state as satisfied')

      // A repeat under a NEW key is allowed to look again — but the complete
      // fresh read must still find the entry and refuse to arm a second write.
      const renamed = await call(harness, 'schedule_garmin_workout', {
        workoutId: easy.workoutId, date: MON, timezone: TIMEZONE, idempotencyKey: 'demo-week-plan-c',
      })
      show('asking for Monday again under a new idempotencyKey returns', {
        success: renamed.success,
        requiresConfirmation: renamed.requiresConfirmation,
        action: renamed.action,
        status: renamed.status,
        message: renamed.message,
      })
      assert(
        renamed.requiresConfirmation !== true,
        'the fresh read found the entry, so no new confirmation may be issued',
      )
      assert(renamed.action === 'skip_existing', `Monday should still be skip_existing, got ${String(renamed.action)}`)

      const state = await peer.state()
      const mondayPosts = peer.postsFor(state, easy.workoutId, MON)
      show('every POST the fake Garmin received for Monday', mondayPosts)
      assert(mondayPosts.length === 1, `Monday must be written exactly once, saw ${mondayPosts.length} POSTs`)
      assert(
        mondayPosts.filter((post: any) => post.applied).length === 1,
        'exactly one Monday POST should have been applied',
      )
    })
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }

  console.log('\nDEMO 1 OK — the stale not_attempted stayed visible and Monday was written exactly once.')
}

async function demoTwoUnknownMixedBatch(peer: Peer) {
  console.log('\n================ DEMO 2: an unknown step mixed with a new one ================')
  const stateDirectory = await mkdtemp(path.join(tmpdir(), 'demo-state-'))

  try {
    await withHarness(stateDirectory, peer, {}, async harness => {
      const easy = await createTemplate(harness, EASY_RUN, 'demo-tpl-easy')
      const tempo = await createTemplate(harness, TEMPO_RUN, 'demo-tpl-tempo')

      // Arm the peer so Monday's POST is applied and then the response is
      // dropped: from the client's side that is an unknown outcome, not a
      // failure, and the entry is really on the calendar.
      await peer.fault('drop_response', 1)
      const single = await call(harness, 'schedule_garmin_workout', {
        workoutId: easy.workoutId, date: MON, timezone: TIMEZONE, idempotencyKey: 'demo-unknown-a',
      })
      const singleDone = await call(harness, 'schedule_garmin_workout', {
        workoutId: easy.workoutId, date: MON, timezone: TIMEZONE,
        idempotencyKey: 'demo-unknown-a', confirmed: true, confirmationId: single.confirmationId,
      })
      show('confirming Monday against a dropped response returns', {
        isError: singleDone.isError,
        success: singleDone.success,
        status: singleDone.status,
        canResume: singleDone.canResume,
        nextAction: singleDone.nextAction,
        message: singleDone.message,
      })
      assert(singleDone.status === 'unknown', `Monday should be unknown, got ${String(singleDone.status)}`)
      assert(singleDone.success === false, 'an unknown outcome must not be reported as success')
      const operationId = String(singleDone.operationId ?? single.operationId)

      let state = await peer.state()
      show('the fake Garmin applied Monday even though the client never heard back', {
        mondayPosts: peer.postsFor(state, easy.workoutId, MON),
        scheduleApplied: state.scheduleApplied,
      })
      assert(state.scheduleApplied === 1, 'the dropped response should still have applied one entry')

      // A batch that mixes the unknown Monday with a brand-new Tuesday.
      await peer.fault('none')
      const batchArgs = {
        timezone: TIMEZONE,
        schedules: [
          { workoutId: easy.workoutId, date: MON },
          { workoutId: tempo.workoutId, date: TUE },
        ],
        idempotencyKey: 'demo-unknown-batch',
      }
      const batch = await call(harness, 'batch_schedule_garmin_workouts', batchArgs)
      show('the mixed preview arms only the unoccupied key', {
        requiresConfirmation: batch.requiresConfirmation,
        preview: (batch.preview ?? []).map((entry: any) => ({
          date: entry.date, action: entry.action, status: entry.status,
        })),
      })
      assert(batch.requiresConfirmation === true, 'the unoccupied Tuesday entry should still be armed')
      const mondayPreview = (batch.preview ?? []).find((entry: any) => entry.date === MON)
      const tuesdayPreview = (batch.preview ?? []).find((entry: any) => entry.date === TUE)
      assert(mondayPreview?.action === 'blocked', `Monday should preview as blocked, got ${String(mondayPreview?.action)}`)
      assert(tuesdayPreview?.action === 'write', `Tuesday should preview as write, got ${String(tuesdayPreview?.action)}`)

      const batchDone = await call(harness, 'batch_schedule_garmin_workouts', {
        ...batchArgs, confirmed: true, confirmationId: batch.confirmationId,
      })
      show('the mixed batch reports', {
        success: batchDone.success,
        total: batchDone.total,
        successCount: batchDone.successCount,
        unknownCount: batchDone.unknownCount,
        results: (batchDone.results ?? []).map((entry: any) => ({
          date: entry.date, status: entry.status, canResume: entry.canResume, nextAction: entry.nextAction,
        })),
      })

      assert(batchDone.total === 2, `the batch should account for two items, got ${String(batchDone.total)}`)
      assert(batchDone.results?.length === 2, 'every item needs its own result entry')
      assert(batchDone.success === false, 'a batch containing an unknown step must not report success')
      assert(batchDone.unknownCount === 1, `unknownCount should be 1, got ${String(batchDone.unknownCount)}`)

      const monday = stepOf(batchDone, MON)
      const tuesday = stepOf(batchDone, TUE)
      assert(monday?.status === 'unknown', `Monday should stay unknown, got ${String(monday?.status)}`)
      assert(monday?.canResume === false, 'an unknown entry must not advertise itself as resumable')
      assert(tuesday?.status === 'succeeded', `Tuesday should be written, got ${String(tuesday?.status)}`)

      state = await peer.state()
      const mondayPosts = peer.postsFor(state, easy.workoutId, MON)
      const tuesdayPosts = peer.postsFor(state, tempo.workoutId, TUE)
      show('every POST the fake Garmin received', {
        monday: mondayPosts,
        tuesday: tuesdayPosts,
        scheduleApplied: state.scheduleApplied,
      })
      assert(mondayPosts.length === 1, `the unknown Monday must not be re-sent, saw ${mondayPosts.length} POSTs`)
      assert(tuesdayPosts.length === 1, `Tuesday should be written once, saw ${tuesdayPosts.length} POSTs`)
      assert(state.scheduleApplied === 2, `two entries should exist on Garmin, got ${String(state.scheduleApplied)}`)

      const original = await readOperation(harness, operationId)
      const originalMonday = journalStep(original, MON)
      show('the original unknown record is not silently rewritten by the later batch', {
        operationId,
        status: originalMonday?.status,
        errorCode: originalMonday?.errorCode,
        evidence: originalMonday?.evidence,
        canResume: originalMonday?.canResume,
      })
      assert(
        originalMonday?.status === 'unknown',
        'a later batch must not resolve the unknown step it merely referenced',
      )
      assert(
        originalMonday?.canResume === false,
        'an unresolved outcome must not become resumable because a later batch mentioned it',
      )
    })
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }

  console.log('\nDEMO 2 OK — per-item accounting stayed complete and the unknown Monday was never re-sent.')
}

async function demoThreeCrossProcessRecovery(peer: Peer) {
  console.log('\n================ DEMO 3: a second process reconciles without re-sending ================')
  const stateDirectory = await mkdtemp(path.join(tmpdir(), 'demo-state-'))
  let first: Harness | undefined
  let second: Harness | undefined

  try {
    // The template is created by a process that then exits cleanly, so nothing
    // in this demo depends on the crashed process having created it.
    const easy = await withHarness(stateDirectory, peer, {}, async harness =>
      await createTemplate(harness, EASY_RUN, 'demo-tpl-easy'))

    // Three entries. The peer will apply the second and drop its response, and
    // the child is armed to die on that transport error, so the journal is left
    // with one succeeded, one in-flight and one never-started entry.
    first = await open(stateDirectory, peer, { FAKE_GARMIN_EXIT_ON_SCHEDULE_ERROR: '1' })
    const firstPid = first.pid
    assert(typeof firstPid === 'number', 'the first harness should expose its pid')

    const batchArgs = {
      timezone: TIMEZONE,
      schedules: [
        { workoutId: easy.workoutId, date: MON },
        { workoutId: easy.workoutId, date: TUE },
        { workoutId: easy.workoutId, date: WED },
      ],
      idempotencyKey: 'demo-crash-batch',
    }
    const preview = await call(first, 'batch_schedule_garmin_workouts', batchArgs)
    assert(preview.requiresConfirmation === true, 'the batch preview should require confirmation')
    await peer.fault('drop_response', 2)

    const pending = first.client.callTool({
      name: 'batch_schedule_garmin_workouts',
      arguments: { ...batchArgs, confirmed: true, confirmationId: preview.confirmationId },
    }).catch(() => undefined)
    await Promise.race([first.exited, sleep(20_000)])
    await pending

    const afterCrash = await peer.state()
    show(`the MCP child pid ${firstPid} killed itself on the dropped second response`, {
      schedulePosts: afterCrash.schedulePosts,
      scheduleApplied: afterCrash.scheduleApplied,
      posts: afterCrash.posts.map((post: any) => ({
        call: post.call, date: post.date, applied: post.applied, outcome: post.outcome,
      })),
    })
    assert(afterCrash.scheduleApplied === 2, `the peer should have applied two entries, got ${afterCrash.scheduleApplied}`)
    first.kill()

    // The documented offline step: confirm the owner is gone, then move only
    // the exact lock directory to an isolated backup location.
    const lockDirectory = path.join(stateDirectory, accountKey(ACCOUNT, REGION as never), 'write.lock')
    const owner = JSON.parse(await readFile(path.join(lockDirectory, 'owner.json'), 'utf8'))
    show('the hard kill left a lock whose owner is gone', {
      ownerPid: owner.pid,
      firstPid,
      ownerTokenPresent: typeof owner.ownerToken === 'string',
      startedAt: owner.startedAt,
      ownerIsGone: pidIsGone(Number(owner.pid)),
    })
    assert(Number(owner.pid) === firstPid, 'the lock owner should be the process that was killed')
    assert(pidIsGone(Number(owner.pid)), 'the lock owner must really be gone before it is moved aside')

    const lockBackup = await mkdtemp(path.join(tmpdir(), 'demo-lock-backup-'))
    await rename(lockDirectory, path.join(lockBackup, 'write.lock'))
    show('the lock directory was moved aside, and the journal was left untouched', {
      lockRemoved: await readFile(path.join(lockDirectory, 'owner.json'), 'utf8').then(() => false, () => true),
      lockBackup,
      journalStillThere: await readFile(
        path.join(stateDirectory, accountKey(ACCOUNT, REGION as never), 'operations.json'), 'utf8',
      ).then(() => true, () => false),
    })

    // A genuinely different process takes over the same state directory.
    const recovery = await open(stateDirectory, peer)
    second = recovery
    console.log(`\n### recovery child pid ${recovery.pid}, distinct from the crashed ${firstPid}`)
    assert(recovery.pid !== firstPid, 'the recovery process must be a different process')

    const operationId = String(preview.operationId)
    const recovered = await readOperation(recovery, operationId)
    show('the new process reads the journal the crashed one left behind', {
      statuses: (recovered.steps ?? []).map((step: any) => ({
        date: step.date, status: step.status, errorCode: step.errorCode, canResume: step.canResume,
      })),
      previewRevision: recovered.previewRevision,
    })

    const reconciled = await call(recovery, 'reconcile_garmin_write_operation', { operationId })
    show('reconcile consults Garmin and records evidence only', {
      wroteToGarmin: reconciled.wroteToGarmin,
      readsIssued: reconciled.readsIssued,
      observations: (reconciled.observations ?? []).map((observation: any) => ({
        date: observation.date,
        observation: observation.observation,
        unresolved: observation.unresolved,
        resumable: observation.resumable,
        desiredStateSatisfied: observation.desiredStateSatisfied,
      })),
      manualReviewRequired: reconciled.manualReviewRequired,
      nextAction: reconciled.nextAction,
    })
    assert(reconciled.wroteToGarmin === false, 'reconcile must never write to Garmin')
    const tuesdayObservation = (reconciled.observations ?? []).find((entry: any) => entry.date === TUE)
    assert(
      tuesdayObservation?.resumable === false,
      'the entry whose write reached Garmin must not be armed by a resume',
    )
    assert(
      tuesdayObservation?.unresolved === true,
      'the entry whose write reached Garmin stays unresolved after the read',
    )

    const afterReconcile = await readOperation(recovery, operationId)
    show('reconcile recorded the observation without rewriting a status', {
      statuses: (afterReconcile.steps ?? []).map((step: any) => ({
        date: step.date, status: step.status, evidence: step.evidence, canResume: step.canResume,
      })),
    })
    assert(
      journalStep(afterReconcile, TUE)?.status === 'unknown',
      'the unsettled step must still be unknown after reconcile',
    )
    assert(
      journalStep(afterReconcile, WED)?.status === 'prepared',
      'the never-dispatched entry should still be prepared, which is what makes it resumable',
    )

    // The dropped response that killed the first process was a transient
    // transport fault and the outage is over before anybody resumes — nobody
    // re-arms a write while the wire is still broken. The read above already ran
    // with the fault in place, which is why it proves reconcile only reads.
    await peer.fault('none')
    console.log('\n### the response fault is cleared before the resume — the outage is over')

    const beforeResume = await peer.state()
    const resumePreview = await call(recovery, 'resume_garmin_write_operation', { operationId })
    show('resume offers only what it can prove was never sent', {
      requiresConfirmation: resumePreview.requiresConfirmation,
      candidates: (resumePreview.candidates ?? []).map((candidate: any) => candidate.date),
      refusals: (resumePreview.refusals ?? []).map((refusal: any) => ({
        code: refusal.code, detail: refusal.detail,
      })),
      preview: (resumePreview.preview ?? []).map((step: any) => ({
        date: step.date, action: step.action, status: step.status,
      })),
    })
    const candidateDates = (resumePreview.candidates ?? []).map((candidate: any) => candidate.date)
    assert(candidateDates.includes(WED), 'the never-sent Wednesday entry should be a resume candidate')
    assert(!candidateDates.includes(TUE), 'the entry with an unknown outcome must not be re-armable')
    assert(!candidateDates.includes(MON), 'the succeeded entry must not be re-armable')
    assert(
      resumePreview.requiresConfirmation === true,
      'a resume that can arm the never-sent entry needs a fresh approval',
    )

    const resumed = await call(recovery, 'resume_garmin_write_operation', {
      operationId, confirmed: true, confirmationId: resumePreview.confirmationId,
    })
    show('the confirmed resume reports', {
      success: resumed.success,
      total: resumed.total,
      unknownCount: resumed.unknownCount,
      notAttemptedCount: resumed.notAttemptedCount,
      results: (resumed.results ?? []).map((entry: any) => ({
        date: entry.date, status: entry.status, desiredStateSatisfied: entry.desiredStateSatisfied,
      })),
      message: resumed.message,
    })
    assert(
      !(resumed.results ?? []).some((entry: any) => entry.date === TUE && entry.status !== 'unknown'),
      'the resume must not have rewritten the unknown entry',
    )

    const finalState = await peer.state()
    const unknownDates = (afterReconcile.steps ?? [])
      .filter((step: any) => step.status === 'unknown')
      .map((step: any) => step.date)
    show('final Garmin state, and the POST count for every date that was ever involved', {
      schedulePosts: finalState.schedulePosts,
      scheduleApplied: finalState.scheduleApplied,
      unknownDates,
      postsPerDate: [MON, TUE, WED].map((date: string) => ({
        date,
        posts: peer.postsFor(finalState, easy.workoutId, date).length,
      })),
    })

    for (const date of [MON, TUE, WED]) {
      const posts = peer.postsFor(finalState, easy.workoutId, date)
      assert(posts.length === 1, `${date} must have been sent exactly once, saw ${posts.length} POSTs`)
    }
    assert(
      finalState.schedulePosts === beforeResume.schedulePosts + 1,
      'a resume must add exactly the entry that had never been sent, and nothing else',
    )
    assert(
      finalState.scheduleApplied === beforeResume.scheduleApplied + 1,
      'exactly one new entry should now be on the calendar',
    )
    for (const date of unknownDates) {
      assert(
        peer.postsFor(finalState, easy.workoutId, date).length === 1,
        `${date} had an unknown outcome and must not have been re-sent`,
      )
    }

    const finalOperation = await readOperation(recovery, operationId)
    show('the journal after resume', {
      statuses: (finalOperation.steps ?? []).map((step: any) => ({
        date: step.date, status: step.status, workoutScheduleId: step.workoutScheduleId,
      })),
    })
    assert(
      journalStep(finalOperation, WED)?.status === 'succeeded',
      'the resumed entry should now hold a real receipt',
    )
    assert(
      journalStep(finalOperation, TUE)?.status === 'unknown',
      'the unknown entry must survive the resume unchanged',
    )
  } finally {
    first?.kill()
    await second?.close()
    await rm(stateDirectory, { recursive: true, force: true })
  }

  console.log('\nDEMO 3 OK — the second process recovered the record, re-sent nothing, and wrote only the entry it never sent.')
}

/** Each demo gets its own peer so `fromCall` ordinals are per-demo. */
async function withPeer(fn: (peer: Peer) => Promise<void>): Promise<void> {
  const peer = await Peer.start()
  console.log(`\n# fake Garmin peer=${peer.url}`)
  try {
    await fn(peer)
  } finally {
    peer.stop()
  }
}

async function main() {
  await withPeer(demoOneHistoryShadowing)
  await withPeer(demoTwoUnknownMixedBatch)
  await withPeer(demoThreeCrossProcessRecovery)
  console.log('\nALL THREE DEMOS OK')
}

main().catch(async error => {
  console.error('\nDEMO FAILED')
  console.error(error)
  await closeAllHarnesses()
  process.exitCode = 1
})

/**
 * C8 — write recovery across real MCP processes.
 *
 * Every other write test in this repository runs the service in-process, where
 * "the process died" can only be simulated. These cases run the built stdio
 * entry point as a real child process against a real, separately-running Garmin
 * peer, so the three things a recovery claim rests on are checkable facts
 * rather than assertions about a mock:
 *
 *   1. What the peer actually received and applied, read from the peer's own
 *      process (`GET /__state`). Killing the MCP child cannot erase it, and an
 *      in-process stub could not have preserved it either.
 *   2. What the local journal durably held at the moment of death. Deaths are
 *      SIGKILL, so no shutdown hook, exit handler or buffered write runs
 *      afterwards; the file on disk is the truth.
 *   3. That a second, independent process recovers from that journal and does
 *      not send the write again.
 *
 * A crash leaves the account write lock on disk, and the lock deliberately
 * refuses to preempt a possibly-live owner. The residue is therefore asserted to
 * block, and the documented offline step (removing the stale lock directory) is
 * performed explicitly before the recovery is allowed to proceed — so the cases
 * below also show that the lock is not the only guard: with the lock gone, the
 * journal still refuses to send.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { accountKey } from '../src/write-operations/identity'

const ACCOUNT_NAME = 'fixture@example.test'
const REGION = 'cn'
const TZ = 'Asia/Shanghai'
const STATE_FIXTURE = path.join(__dirname, 'fixtures/stdio-garmin-http.cjs')
const PEER_FIXTURE = path.join(__dirname, 'fixtures/fake-garmin-server.cjs')

/** Long enough for two child processes plus a peer under a loaded CI box. */
const CASE_TIMEOUT_MS = 60_000

interface Post {
  call: number
  kind: string
  workoutId?: string
  date?: string
  workoutScheduleId?: string | null
  applied: boolean
  outcome: string
}

interface PeerState {
  pid: number
  schedulePosts: number
  scheduleApplied: number
  unschedulePosts: number
  createPosts: number
  calendarReads: number
  posts: Post[]
  entries: Array<{ date: string; workoutId: string | null; workoutScheduleId: string | null }>
}

interface ToolResult {
  isError: boolean
  payload: Record<string, any>
  text: string
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * The Garmin peer, owned by this test process and by no MCP child.
 *
 * `state()` is always read back over HTTP from the peer's own memory. Nothing
 * here is derived from what an MCP process reported, which is the point: the
 * peer's tally is the independent record of how many writes really went out.
 */
class FakeGarmin {
  private constructor(
    readonly url: string,
    private readonly child: ChildProcess,
    private readonly directory: string,
  ) {}

  static async start(): Promise<FakeGarmin> {
    const directory = await mkdtemp(path.join(tmpdir(), 'fake-garmin-'))
    const portFile = path.join(directory, 'port')
    const child = spawn(process.execPath, [PEER_FIXTURE, portFile], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    child.stderr?.on('data', () => undefined)
    const deadline = Date.now() + 20_000
    for (;;) {
      try {
        const port = (await readFile(portFile, 'utf8')).trim()
        if (port) return new FakeGarmin(`http://127.0.0.1:${port}`, child, directory)
      } catch {
        // Not listening yet.
      }
      if (Date.now() > deadline) {
        child.kill('SIGKILL')
        throw new Error('fake Garmin did not start within 20s')
      }
      await sleep(25)
    }
  }

  async state(): Promise<PeerState> {
    const response = await fetch(`${this.url}/__state`)
    return await response.json() as PeerState
  }

  /** Arm the schedule fault so that call `fromCall` and later misbehave. */
  async fault(mode: string, fromCall = 1): Promise<void> {
    const response = await fetch(`${this.url}/__fault`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode, fromCall }),
    })
    if (!response.ok) throw new Error(`arming the peer fault failed: ${response.status}`)
  }

  async stop(): Promise<void> {
    this.child.kill('SIGKILL')
    await rm(this.directory, { recursive: true, force: true })
  }
}

interface Harness {
  client: Client
  pid: number | null
  errors: Error[]
  stderrText(): string
  /** Resolves when the child process is gone, however it went. */
  exited: Promise<void>
  /** SIGKILL: no shutdown hooks, no exit handler, no flush. */
  kill(): void
  close(): Promise<void>
}

async function openMcp(options: {
  stateDirectory: string
  peer: FakeGarmin
  sessionFile: string
  env?: Record<string, string>
}): Promise<Harness> {
  const client = new Client({ name: 'recovery-client', version: '1' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [STATE_FIXTURE],
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      FAKE_GARMIN_URL: options.peer.url,
      GARMIN_STATE_DIR: options.stateDirectory,
      GARMIN_USERNAME: ACCOUNT_NAME,
      GARMIN_REGION: REGION,
      GARMIN_SESSION_TOKEN_FILE: options.sessionFile,
      // Only the wait budget is shortened; the lock itself is unchanged.
      FAKE_GARMIN_LOCK_WAIT_MS: '400',
      ...(options.env ?? {}),
    },
    stderr: 'pipe',
  })
  let stderrText = ''
  transport.stderr?.on('data', chunk => { stderrText += String(chunk) })
  const errors: Error[] = []
  client.onerror = error => errors.push(error)
  const exited = new Promise<void>(resolve => { transport.onclose = () => resolve() })
  await client.connect(transport)
  return {
    client,
    pid: transport.pid,
    errors,
    stderrText: () => stderrText,
    exited,
    kill: () => { if (transport.pid) process.kill(transport.pid, 'SIGKILL') },
    close: async () => { await client.close().catch(() => undefined) },
  }
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const result = await client.callTool({ name, arguments: args })
  const text = (result.content as Array<{ text: string }>)[0].text
  let payload: Record<string, any>
  try {
    payload = JSON.parse(text)
  } catch {
    // A schema rejection never reaches the handler, so the SDK answers with a
    // protocol error string. It is still the answer to assert on.
    payload = { message: text }
  }
  return { isError: Boolean(result.isError), payload, text }
}

function lockDirectory(stateDirectory: string): string {
  return path.join(stateDirectory, accountKey(ACCOUNT_NAME, REGION as never), 'write.lock')
}

async function lockExists(stateDirectory: string): Promise<boolean> {
  try {
    return (await stat(lockDirectory(stateDirectory))).isDirectory()
  } catch {
    return false
  }
}

/**
 * The documented offline step for a lock whose owner is gone.
 *
 * Removing it is an operator action taken *outside* the running code, which is
 * exactly why the cases below re-check the journal afterwards: losing the lock
 * must not be the same thing as being allowed to write.
 */
async function clearStaleLock(stateDirectory: string): Promise<void> {
  await rm(lockDirectory(stateDirectory), { recursive: true, force: true })
}

describe('write recovery across stdio processes', () => {
  let peer: FakeGarmin
  let stateDirectory: string
  const open: Harness[] = []

  async function connect(env?: Record<string, string>, session = 'session.json'): Promise<Harness> {
    const sessionFile = path.join(stateDirectory, session)
    await writeFile(sessionFile, JSON.stringify({ fixture: session }), 'utf8').catch(() => undefined)
    const harness = await openMcp({ stateDirectory, peer, sessionFile, env })
    open.push(harness)
    return harness
  }

  beforeEach(async () => {
    peer = await FakeGarmin.start()
    stateDirectory = await mkdtemp(path.join(tmpdir(), 'garmin-c8-state-'))
  })

  afterEach(async () => {
    await Promise.all(open.splice(0).map(harness => harness.close()))
    await peer.stop()
    await rm(stateDirectory, { recursive: true, force: true })
  })

  it('recovers a lost response in a second process and never re-sends the POST', async () => {
    const request = { workoutId: '42', date: '2099-09-15', timezone: TZ }
    const first = await connect()
    const preview = await callTool(first.client, 'schedule_garmin_workout', request)
    expect(preview.payload.requiresConfirmation).toBe(true)

    // The peer applies the write and then kills the socket: the dispatch
    // happened, the answer did not arrive.
    await peer.fault('drop_response')
    const confirmed = await callTool(first.client, 'schedule_garmin_workout', {
      ...request,
      confirmed: true,
      confirmationId: preview.payload.confirmationId,
    })
    expect(confirmed.isError).not.toBe(true)
    expect(confirmed.payload).toMatchObject({
      status: 'unknown',
      manualReviewRequired: true,
      canResume: false,
      nextAction: 'reconcile_garmin_write_operation',
    })

    const afterAttempt = await peer.state()
    expect(afterAttempt.schedulePosts).toBe(1)
    expect(afterAttempt.entries).toHaveLength(1)
    const landedScheduleId = afterAttempt.entries[0].workoutScheduleId
    const operationId = confirmed.payload.operationId as string

    // Crash, then restart. Nothing about the recovery is carried in memory.
    first.kill()
    await first.exited
    const second = await connect(undefined, 'session-2.json')
    expect(second.pid).not.toBe(first.pid)
    expect(await peer.state()).toMatchObject({ pid: afterAttempt.pid })

    const detail = await callTool(second.client, 'get_garmin_write_operation', { operationId })
    expect(detail.isError).not.toBe(true)
    expect(detail.payload.found).toBe(true)
    expect(detail.payload.operation).toMatchObject({
      status: 'unknown',
      canResume: false,
      manualReviewRequired: true,
      nextAction: 'reconcile_garmin_write_operation',
    })

    // The journal outlived the process that wrote it, and the calendar read
    // goes to the peer rather than to any state this process holds.
    const calendar = await callTool(second.client, 'get_garmin_calendar', {
      startDate: request.date,
      endDate: request.date,
    })
    expect(calendar.payload).toMatchObject({ complete: true })
    expect(calendar.payload.entries).toMatchObject([
      { date: request.date, workoutId: request.workoutId, workoutScheduleId: landedScheduleId },
    ])

    const report = await callTool(second.client, 'reconcile_garmin_write_operation', { operationId })
    expect(report.isError).not.toBe(true)
    expect(report.payload).toMatchObject({
      wroteToGarmin: false,
      manualReviewRequired: true,
      nextAction: 'reconcile_garmin_write_operation',
      observations: [{
        observation: 'observed_present',
        status: 'unknown',
        unresolved: true,
        desiredStateSatisfied: true,
        matchCount: 1,
        matchedScheduleIds: [landedScheduleId],
      }],
    })
    expect(report.payload.nextActionDetail).toContain('never re-send the write')

    // A brand-new idempotency key is a caller claiming "this is a new
    // operation", not a licence to write over an unresolved one.
    const freshKey = await callTool(second.client, 'schedule_garmin_workout', {
      ...request,
      idempotencyKey: 'brand-new-key',
    })
    expect(freshKey.isError).not.toBe(true)
    expect(freshKey.payload.requiresConfirmation).not.toBe(true)

    const after = await peer.state()
    expect(after.schedulePosts).toBe(1)
    expect(after.entries).toHaveLength(1)
    expect(after.posts.filter(post => post.outcome === 'ok')).toHaveLength(0)
    expect(second.errors).toEqual([])
  }, CASE_TIMEOUT_MS)

  it('accumulates POSTs in one peer across two independent processes', async () => {
    const firstTarget = { workoutId: '101', date: '2099-10-01', timezone: TZ }
    const secondTarget = { workoutId: '102', date: '2099-10-02', timezone: TZ }

    const alpha = await connect(undefined, 'alpha-session.json')
    const beta = await connect(undefined, 'beta-session.json')

    // The handle has to be kept alongside the receipt: the execute response
    // answers with the outcome only, and a confirmationId is minted by a
    // preview. Replaying the receipt as if it were a handle is refused, which
    // the next paragraph pins down.
    async function scheduleOne(
      harness: Harness,
      target: Record<string, string>,
    ): Promise<{ handle: string; receipt: ToolResult }> {
      const preview = await callTool(harness.client, 'schedule_garmin_workout', target)
      expect(preview.payload.requiresConfirmation).toBe(true)
      const receipt = await callTool(harness.client, 'schedule_garmin_workout', {
        ...target,
        confirmed: true,
        confirmationId: preview.payload.confirmationId,
      })
      return { handle: preview.payload.confirmationId as string, receipt }
    }

    const first = await scheduleOne(alpha, firstTarget)

    // A second process, the same account journal and the same peer. Its write
    // must be counted by the peer alongside the first, which is only observable
    // because the peer outlives both children.
    const second = await scheduleOne(beta, secondTarget)
    const afterBoth = await peer.state()
    expect(afterBoth.schedulePosts).toBe(2)
    expect(afterBoth.pid).not.toBe(alpha.pid)
    expect(afterBoth.pid).not.toBe(beta.pid)
    expect([first.receipt.payload.workoutScheduleId, second.receipt.payload.workoutScheduleId])
      .toEqual(['1', '2'])
    expect(afterBoth.entries.map(entry => entry.workoutId).sort()).toEqual(['101', '102'])

    // Replaying the first process's confirmation handle from the second process
    // is answered from the journal, not by a third dispatch.
    const replay = await callTool(beta.client, 'schedule_garmin_workout', {
      ...firstTarget,
      confirmed: true,
      confirmationId: first.handle,
    })
    expect(replay.isError).not.toBe(true)
    expect(replay.payload).toMatchObject({
      status: 'succeeded',
      desiredStateSatisfied: true,
      workoutScheduleId: first.receipt.payload.workoutScheduleId,
    })

    // An execute response carries no handle, so passing it back is a malformed
    // confirmation and is refused before anything is dispatched.
    const misused = await callTool(beta.client, 'schedule_garmin_workout', {
      ...firstTarget,
      confirmed: true,
      confirmationId: first.receipt.payload.confirmationId,
    })
    expect(misused.isError).toBe(true)
    expect((await peer.state()).schedulePosts).toBe(2)

    // A fresh preview for the same target is deduplicated in the other process.
    const deduped = await callTool(beta.client, 'schedule_garmin_workout', firstTarget)
    expect(deduped.payload).toMatchObject({ requiresConfirmation: false, action: 'skip_existing' })

    const after = await peer.state()
    expect(after.schedulePosts).toBe(2)
    expect(after.entries).toHaveLength(2)
    expect(alpha.errors).toEqual([])
    expect(beta.errors).toEqual([])
  }, CASE_TIMEOUT_MS)

  it('serializes a same-target confirm raced by two processes into exactly one POST', async () => {
    const target = { workoutId: '201', date: '2099-11-01', timezone: TZ }
    const alpha = await connect(undefined, 'alpha-session.json')
    const beta = await connect(undefined, 'beta-session.json')

    // Both processes preview the same target before either dispatches. The
    // business key is the same one, so both previews bind to a single operation
    // and the second preview advances its revision.
    const [alphaPreview, betaPreview] = await Promise.all([
      callTool(alpha.client, 'schedule_garmin_workout', target),
      callTool(beta.client, 'schedule_garmin_workout', target),
    ])
    expect(alphaPreview.payload.requiresConfirmation).toBe(true)
    expect(betaPreview.payload.requiresConfirmation).toBe(true)
    expect(alphaPreview.payload.operationId).toBe(betaPreview.payload.operationId)

    const [alphaResult, betaResult] = await Promise.all([
      callTool(alpha.client, 'schedule_garmin_workout', {
        ...target, confirmed: true, confirmationId: alphaPreview.payload.confirmationId,
      }),
      callTool(beta.client, 'schedule_garmin_workout', {
        ...target, confirmed: true, confirmationId: betaPreview.payload.confirmationId,
      }),
    ])

    // Only the handle minted by the latest preview may write. The other one is
    // refused locally — a second preview of the same business key re-decided the
    // target and moved the revision, and that refusal is why a second POST is
    // impossible here rather than merely unlikely.
    //
    // Which process previewed second is a race between two OS processes, so the
    // sides are identified by their revision rather than assumed.
    const attempts = [
      { revision: alphaPreview.payload.confirmationId as string, result: alphaResult },
      { revision: betaPreview.payload.confirmationId as string, result: betaResult },
    ].map(attempt => ({ ...attempt, revision: attempt.revision.slice(attempt.revision.lastIndexOf(':') + 1) }))
    expect(attempts.map(attempt => attempt.revision).sort()).toEqual(['0', '1'])

    const winner = attempts.find(attempt => attempt.revision === '1')!.result
    const loser = attempts.find(attempt => attempt.revision === '0')!.result
    expect(loser.isError).toBe(true)
    expect(loser.payload.errorCode).toBe('CONFIRMATION_STALE')
    expect(loser.payload.message).toContain('No Garmin write was sent')
    expect(winner.isError).not.toBe(true)
    expect(winner.payload).toMatchObject({
      status: 'succeeded',
      desiredStateSatisfied: true,
      workoutScheduleId: '1',
    })

    const after = await peer.state()
    expect(after.schedulePosts).toBe(1)
    expect(after.entries).toHaveLength(1)
    expect(alpha.errors).toEqual([])
    expect(beta.errors).toEqual([])
  }, CASE_TIMEOUT_MS)

  it('a process killed before its first dispatch sends nothing and leaves the target blocked', async () => {
    const request = { workoutId: '301', date: '2099-12-01', timezone: TZ }
    const first = await connect({ FAKE_GARMIN_EXIT_BEFORE_SCHEDULE_N: '1' })
    const preview = await callTool(first.client, 'schedule_garmin_workout', request)
    const operationId = preview.payload.operationId as string

    // The confirm dies inside the client, before the request leaves.
    await first.client.callTool({
      name: 'schedule_garmin_workout',
      arguments: {
        ...request, confirmed: true, confirmationId: preview.payload.confirmationId,
      },
    }).catch(() => undefined)
    await first.exited

    expect((await peer.state()).schedulePosts).toBe(0)
    // Killed while holding the lock, so the residue is on disk.
    expect(await lockExists(stateDirectory)).toBe(true)

    const second = await connect(undefined, 'session-2.json')
    const detail = await callTool(second.client, 'get_garmin_write_operation', { operationId })
    expect(detail.payload.operation).toMatchObject({
      status: 'unknown',
      canResume: false,
      manualReviewRequired: true,
      nextAction: 'reconcile_garmin_write_operation',
    })
    // The pre-dispatch marker is durable: the step was journaled before the
    // dispatch, so a death before the dispatch still leaves an unresolved step.
    expect(detail.payload.operation.steps).toMatchObject([
      { status: 'in_flight', canResume: false, manualReviewRequired: true },
    ])

    // Safe branch 1: the lock residue blocks every new attempt.
    const blockedByLock = await callTool(second.client, 'schedule_garmin_workout', {
      ...request, idempotencyKey: 'after-crash-1',
    })
    expect(blockedByLock.isError).toBe(true)
    expect(blockedByLock.payload.errorCode).toBe('OPERATION_BUSY')
    expect(blockedByLock.payload.message).toContain('No Garmin write was sent')
    expect((await peer.state()).schedulePosts).toBe(0)

    // Safe branch 2: after the documented offline step, the *journal* is what
    // still refuses — losing the lock is not permission to write.
    await clearStaleLock(stateDirectory)
    expect(await lockExists(stateDirectory)).toBe(false)

    const afterOffline = await callTool(second.client, 'schedule_garmin_workout', {
      ...request, idempotencyKey: 'after-crash-2',
    })
    expect(afterOffline.isError).not.toBe(true)
    expect(afterOffline.payload.requiresConfirmation).not.toBe(true)

    // A resume cannot arm a step whose outcome is unknown, so it sends nothing.
    const resume = await callTool(second.client, 'resume_garmin_write_operation', { operationId })
    expect(resume.isError).not.toBe(true)
    expect(resume.payload).toMatchObject({
      success: false,
      requiresConfirmation: false,
      candidates: [],
      refusals: [{ code: 'WRITE_OUTCOME_UNKNOWN' }],
    })
    // With nothing arming, the answer is a verdict per step rather than an
    // approval request: `steps`, and no confirmation handle at all.
    expect(resume.payload.confirmationId).toBeUndefined()
    expect(resume.payload.steps).toMatchObject([
      { action: 'blocked', status: 'unknown', workoutId: '301', errorCode: 'WRITE_OUTCOME_UNKNOWN' },
    ])

    // And the read path says "read again", never "send it again".
    const report = await callTool(second.client, 'reconcile_garmin_write_operation', { operationId })
    expect(report.payload).toMatchObject({
      // `wroteToGarmin` describes this call: reconcile reads and updates the
      // local recovery record, so it never reports a write of its own.
      wroteToGarmin: false,
      manualReviewRequired: true,
      nextAction: 'reconcile_garmin_write_operation',
      observations: [{
        // The observation carries the conclusion this read supports, which is
        // "still unknown", not the step's prior on-disk marker.
        observation: 'observed_absent',
        status: 'unknown',
        unresolved: true,
        resumable: false,
        matchCount: 0,
        matchedScheduleIds: [],
      }],
    })
    expect(report.payload.nextActionDetail).toContain('never re-send the write')

    expect((await peer.state()).schedulePosts).toBe(0)
    expect(second.errors).toEqual([])
  }, CASE_TIMEOUT_MS)

  it('recovers a dispatch whose process died before the response was reported', async () => {
    const request = { workoutId: '401', date: '2100-01-05', timezone: TZ }
    const first = await connect({ FAKE_GARMIN_EXIT_ON_SCHEDULE_ERROR: '1' })
    await peer.fault('drop_response')

    const preview = await callTool(first.client, 'schedule_garmin_workout', request)
    const operationId = preview.payload.operationId as string
    await first.client.callTool({
      name: 'schedule_garmin_workout',
      arguments: {
        ...request, confirmed: true, confirmationId: preview.payload.confirmationId,
      },
    }).catch(() => undefined)
    await first.exited

    const afterAttempt = await peer.state()
    expect(afterAttempt.schedulePosts).toBe(1)
    expect(afterAttempt.entries).toHaveLength(1)
    expect(await lockExists(stateDirectory)).toBe(true)
    await clearStaleLock(stateDirectory)

    const second = await connect(undefined, 'session-2.json')
    const detail = await callTool(second.client, 'get_garmin_write_operation', { operationId })
    expect(detail.payload.operation).toMatchObject({
      status: 'unknown', canResume: false, manualReviewRequired: true,
    })

    const report = await callTool(second.client, 'reconcile_garmin_write_operation', { operationId })
    expect(report.payload).toMatchObject({
      wroteToGarmin: false,
      nextAction: 'reconcile_garmin_write_operation',
      observations: [{
        observation: 'observed_present',
        status: 'unknown',
        unresolved: true,
        resumable: false,
        matchCount: 1,
      }],
    })
    expect(report.payload.nextActionDetail).toContain('never re-send the write')
    // The write landed exactly once and nothing was sent again to find out.
    expect((await peer.state()).schedulePosts).toBe(1)
    expect(second.errors).toEqual([])
  }, CASE_TIMEOUT_MS)

  it('recovers a process killed after the provider answered but before the receipt was saved', async () => {
    const request = { workoutId: '501', date: '2100-02-05', timezone: TZ }
    const first = await connect({ FAKE_GARMIN_EXIT_AFTER_SCHEDULE_RESPONSE_N: '1' })
    const preview = await callTool(first.client, 'schedule_garmin_workout', request)
    const operationId = preview.payload.operationId as string
    await first.client.callTool({
      name: 'schedule_garmin_workout',
      arguments: {
        ...request, confirmed: true, confirmationId: preview.payload.confirmationId,
      },
    }).catch(() => undefined)
    await first.exited

    // The peer answered and applied the write.
    const afterAttempt = await peer.state()
    expect(afterAttempt.schedulePosts).toBe(1)
    expect(afterAttempt.scheduleApplied).toBe(1)
    expect(afterAttempt.entries).toHaveLength(1)
    await clearStaleLock(stateDirectory)

    const second = await connect(undefined, 'session-2.json')
    const detail = await callTool(second.client, 'get_garmin_write_operation', { operationId })
    // The receipt existed only in the dead process's memory. The durable journal
    // kept the pre-dispatch marker, so this must NOT be reported as succeeded.
    expect(detail.payload.operation).toMatchObject({
      status: 'unknown', canResume: false, manualReviewRequired: true,
    })
    expect(detail.payload.operation.steps).toMatchObject([
      {
        // The step keeps the pre-dispatch marker and no evidence, so the
        // operation-level `desiredStateSatisfied: false` is what the receipt
        // reports; the step itself has no answer to give.
        status: 'in_flight',
        evidence: 'none',
        receiptStatus: 'in_flight',
        canResume: false,
        manualReviewRequired: true,
      },
    ])
    expect(detail.payload.operation.desiredStateSatisfied).toBe(false)
    expect(detail.payload.operation.steps[0].desiredStateSatisfied).toBeUndefined()

    const report = await callTool(second.client, 'reconcile_garmin_write_operation', { operationId })
    expect(report.payload).toMatchObject({
      wroteToGarmin: false,
      nextAction: 'reconcile_garmin_write_operation',
      observations: [{ observation: 'observed_present', unresolved: true }],
    })
    expect((await peer.state()).schedulePosts).toBe(1)
    expect(second.errors).toEqual([])
  }, CASE_TIMEOUT_MS)

  it('resumes only the entries a mid-batch crash left provably unsent', async () => {
    const schedules = [
      { workoutId: '601', date: '2100-03-01' },
      { workoutId: '602', date: '2100-03-02' },
      { workoutId: '603', date: '2100-03-03' },
    ]
    const first = await connect({ FAKE_GARMIN_EXIT_ON_SCHEDULE_ERROR: '1' })
    // The second entry reaches the peer, is applied, and its response is lost;
    // the process then kills itself instead of reporting the uncertainty.
    await peer.fault('drop_response', 2)

    const request = { schedules, timezone: TZ }
    const preview = await callTool(first.client, 'batch_schedule_garmin_workouts', request)
    const operationId = preview.payload.operationId as string
    await first.client.callTool({
      name: 'batch_schedule_garmin_workouts',
      arguments: {
        ...request, confirmed: true, confirmationId: preview.payload.confirmationId,
      },
    }).catch(() => undefined)
    await first.exited

    const afterCrash = await peer.state()
    expect(afterCrash.schedulePosts).toBe(2)
    expect(afterCrash.entries.map(entry => entry.workoutId)).toEqual(['601', '602'])
    await clearStaleLock(stateDirectory)

    const second = await connect(undefined, 'session-2.json')
    const detail = await callTool(second.client, 'get_garmin_write_operation', { operationId })
    // One landed, one is unresolved, one provably never left.
    expect(detail.payload.operation.steps).toMatchObject([
      { workoutId: '601', status: 'succeeded', canResume: false },
      { workoutId: '602', status: 'in_flight', canResume: false, manualReviewRequired: true },
      { workoutId: '603', status: 'prepared', canResume: true },
    ])

    const report = await callTool(second.client, 'reconcile_garmin_write_operation', { operationId })
    expect(report.payload).toMatchObject({ wroteToGarmin: false })
    // Only steps that might have been dispatched are read at the peer, so the
    // entry that provably never left is absent here — it is not "observed
    // absent" from a calendar read, it is known unsent from the journal.
    expect(report.payload.observations).toMatchObject([
      {
        workoutId: '601', observation: 'observed_present', status: 'succeeded',
        desiredStateSatisfied: true, unresolved: false, matchCount: 1,
      },
      {
        workoutId: '602', observation: 'observed_present', status: 'unknown',
        unresolved: true, resumable: false, matchCount: 1, workoutScheduleId: null,
      },
    ])
    expect(report.payload.candidates).toMatchObject([
      { workoutId: '603', date: '2100-03-03', reason: 'never_dispatched' },
    ])
    expect(report.payload.refusals).toMatchObject([
      { code: 'WRITE_OUTCOME_UNKNOWN' },
    ])
    expect(report.payload.nextActionDetail).toContain('never re-send the write')
    expect((await peer.state()).schedulePosts).toBe(2)

    // A lost response is what made the second entry unknown, not a broken peer.
    // Disarming it before the resume keeps the resumed dispatch an ordinary one,
    // so "exactly one new POST" is asserted against a peer that answers.
    await peer.fault('none')

    // Resume arms only the entry proven never to have been sent.
    const resumePreview = await callTool(second.client, 'resume_garmin_write_operation', { operationId })
    expect(resumePreview.payload.requiresConfirmation).toBe(true)
    expect(resumePreview.payload.candidates.map(
      (candidate: { workoutId: string }) => candidate.workoutId,
    )).toEqual(['603'])
    expect(resumePreview.payload.preview).toMatchObject([
      { workoutId: '601', action: 'skip_existing', status: 'succeeded' },
      { workoutId: '602', action: 'blocked', status: 'unknown', errorCode: 'WRITE_OUTCOME_UNKNOWN' },
      { workoutId: '603', action: 'write', status: 'prepared' },
    ])
    expect(resumePreview.payload.refusals).toMatchObject([
      { code: 'WRITE_OUTCOME_UNKNOWN' },
    ])

    const resumed = await callTool(second.client, 'resume_garmin_write_operation', {
      operationId,
      confirmed: true,
      confirmationId: resumePreview.payload.confirmationId,
    })
    expect(resumed.isError).not.toBe(true)
    // The execution reports every step of the operation, so the unanswered one
    // keeps the whole call from claiming success.
    expect(resumed.payload).toMatchObject({
      success: false,
      resumed: true,
      total: 3,
      unknownCount: 1,
      notAttemptedCount: 0,
    })
    expect(resumed.payload.results).toMatchObject([
      // Updated by the reconcile above, but the entry was already accounted for
      // by its durable receipt rather than re-sent.
      { workoutId: '601', status: 'succeeded', evidence: 'observed_present', workoutScheduleId: '1' },
      // The reconcile *did* see this one on the calendar. Even so it is not
      // called satisfied: only a response from the write itself may settle an
      // attempt whose dispatch outcome was never learned.
      {
        workoutId: '602', status: 'unknown', evidence: 'observed_present',
        desiredStateSatisfied: false, canResume: false, manualReviewRequired: true,
        errorCode: 'WRITE_OUTCOME_UNKNOWN', nextAction: 'reconcile_garmin_write_operation',
      },
      // The only step that was actually dispatched, and it carries the peer's
      // own answer rather than an inference.
      { workoutId: '603', status: 'succeeded', evidence: 'response', workoutScheduleId: '3' },
    ])

    const afterResume = await peer.state()
    // Exactly three POSTs for three entries: the two that landed are never
    // re-sent, and the one that never left is sent once.
    expect(afterResume.schedulePosts).toBe(3)
    expect(afterResume.posts.map(post => `${post.workoutId}@${post.date}`)).toEqual([
      '601@2100-03-01', '602@2100-03-02', '603@2100-03-03',
    ])
    expect(afterResume.entries.map(entry => entry.workoutId)).toEqual(['601', '602', '603'])
    expect(second.errors).toEqual([])
  }, CASE_TIMEOUT_MS)
})

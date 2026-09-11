/**
 * Reconcile / resume recovery tests (C7).
 *
 * The contract under test is the one the delivery spec states in four lines:
 *
 *   - a timeout leaves the step `unknown`, and an unknown outcome is *never*
 *     re-sent — not on a later read that finds the target, not on one that does
 *     not, not on a partial read, and not when several candidates exist;
 *   - `reconcile` reads and records observations. It cannot send: the only
 *     dependency it is given is a reader, and a reader has no write method;
 *   - `resume` derives its candidates from the journal. It takes no payload, so
 *     no caller can move a write to another day or swap the template;
 *   - a create that was accepted reuses its recorded id; one whose id was lost
 *     is `manualReviewRequired`; an unschedule is only ever called absent on
 *     evidence for that exact id.
 *
 * The user-facing requirement behind all of this: "恢复不能自动多一次 POST".
 * Every test therefore asserts on the POST counter as well as on the reply, and
 * the counter is a mock that no read path can reach.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { GarminToolService, type GarminDataClient } from '../src/tool-service'
import { GarminWriteError, WRITE_ERROR_CODES } from '../src/write-operations/errors'
import { FakeCalendar } from './fixtures/calendar/fake-calendar'

const TIMEZONE = 'Asia/Shanghai'
const DATE = '2026-09-15'
const OTHER_DATE = '2026-09-17'
const WORKOUT = 'easy-42'

function freshState(): string {
  return mkdtempSync(join(tmpdir(), 'garmin-recovery-'))
}

/** A dropped socket: the request may have reached Garmin. */
function timeoutError(): Error {
  return new Error('ETIMEDOUT: the request may have been applied')
}

/** Garmin answered and rejected it: provably never applied, batch continues. */
function rejectedError(): Error {
  return new GarminWriteError(
    WRITE_ERROR_CODES.WRITE_NOT_APPLIED,
    'not_applied',
    'Garmin rejected this entry before applying it',
  )
}

interface Posts {
  addWorkout: jest.Mock
  scheduleWorkout: jest.Mock
  unscheduleWorkout: jest.Mock
  /** Total POSTs of any kind. Reads cannot increment this. */
  total: () => number
}

function makePosts(): Posts {
  let created = 0
  const addWorkout = jest.fn(async () => {
    created += 1
    return { workoutId: `w-${created}`, workoutName: 'Easy run' }
  })
  const scheduleWorkout = jest.fn(async (workoutId: string, date: string) => {
    return { workoutScheduleId: `sid-${workoutId}-${date}` }
  })
  const unscheduleWorkout = jest.fn(async () => {
    return undefined
  })
  return {
    addWorkout,
    scheduleWorkout,
    unscheduleWorkout,
    // Derived from the recorded invocations rather than from a hand-kept tally:
    // `mockResolvedValueOnce` / `mockRejectedValueOnce` replace the base
    // implementation for one call, so a tally kept inside it would silently
    // under-count exactly the dispatches these tests are about. The call log
    // cannot be bypassed.
    total: () =>
      addWorkout.mock.calls.length + scheduleWorkout.mock.calls.length + unscheduleWorkout.mock.calls.length,
  }
}

function makeService(
  stateDirectory: string,
  posts: Posts,
  calendar: FakeCalendar,
): GarminToolService {
  const data: Partial<GarminDataClient> = {
    getWorkoutDetail: jest.fn().mockResolvedValue({ workoutId: WORKOUT, workoutName: 'Easy run' }),
    addWorkout: posts.addWorkout,
    scheduleWorkout: posts.scheduleWorkout,
    unscheduleWorkout: posts.unscheduleWorkout,
  }
  return new GarminToolService(data as GarminDataClient, {
    activityDetail: 'compact',
    fitDownloadDir: '',
    accountUsername: 'runner@example.test',
    accountRegion: 'global',
    stateDirectory,
    calendarReader: calendar,
  })
}

interface Harness {
  service: GarminToolService
  calendar: FakeCalendar
  posts: Posts
  state: string
}

function harness(calendar = new FakeCalendar(), state = freshState()): Harness {
  const posts = makePosts()
  return { service: makeService(state, posts, calendar), calendar, posts, state }
}

function scheduleArgs(over: Record<string, unknown> = {}) {
  return { workoutId: WORKOUT, date: DATE, timezone: TIMEZONE, ...over }
}

/**
 * Preview then confirm one schedule, and return the confirm receipt.
 *
 * `fail` (when given) decides how the single dispatch fails. The failure is
 * armed on the *counter* mock rather than swapped in as a fresh `jest.fn`, so
 * the POST tally these tests assert on keeps counting the attempt that really
 * was sent — otherwise "no extra POST" would be vacuously true.
 */
async function confirmSchedule(
  service: GarminToolService,
  posts: Posts,
  fail?: Error,
  over: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const preview = await service.scheduleWorkout(scheduleArgs(over) as never)
  expect(preview.requiresConfirmation).toBe(true)
  if (fail) posts.scheduleWorkout.mockRejectedValueOnce(fail)
  const receipt = await service.scheduleWorkout({
    ...scheduleArgs(over),
    confirmed: true,
    confirmationId: preview.confirmationId,
  } as never)
  return { ...receipt, operationId: preview.operationId as string }
}


// The tool surface returns open records; these narrow them for assertion only.
interface StepObservation {
  observation: string
  status: string
  matchCount?: number
  matchedScheduleIds?: Array<string | null>
  evidence?: string
  unresolved?: boolean
  resumable?: boolean
  desiredStateSatisfied?: boolean
  complete?: boolean
}

interface ReconcileReport {
  readsIssued: number
  maxReads: number
  observations: StepObservation[]
  unreadable?: Array<{ stepId?: string; kind?: string; code: string; detail?: string }>
  failures?: unknown[]
  candidates: Array<{ workoutId?: string; date?: string; reason?: string }>
  refusals: Array<{ code: string; kind?: string }>
  manualReviewRequired: boolean
  nextAction: string
  nextActionDetail?: string
  message?: string
  wroteToGarmin: boolean
}

interface ResumeResult {
  requiresConfirmation: boolean
  confirmationId?: string
  operationId: string
  previewRevision?: number
  candidates: Array<{ workoutId?: string; date?: string; reason?: string }>
  refusals: Array<{ code: string; kind?: string }>
  preview?: Array<{ workoutId?: string; date?: string; status?: string }>
  resumed?: boolean
  total?: number
  unknownCount?: number
  notAttemptedCount?: number
  steps?: Array<{ workoutId?: string; date?: string; status?: string }>
  results?: Array<{ workoutId?: string; date?: string; status?: string }>
}

async function reconcile(service: GarminToolService, operationId: string): Promise<ReconcileReport> {
  return await service.reconcileWriteOperation({ operationId }) as unknown as ReconcileReport
}

async function resumeOperation(
  service: GarminToolService,
  args: { operationId: string; confirmed?: boolean; confirmationId?: string },
): Promise<ResumeResult> {
  return await service.resumeWriteOperation(args) as unknown as ResumeResult
}

// ---------------------------------------------------------------------------

describe('C7: an unknown outcome is never re-sent by a later read', () => {
  it('a timed-out schedule stays unknown when the calendar is still empty', async () => {
    const { service, calendar, posts } = harness()

    const receipt = await confirmSchedule(service, posts, timeoutError())
    expect(receipt).toMatchObject({ status: 'unknown', success: false, manualReviewRequired: true })
    expect(receipt.nextAction).toBe('reconcile_garmin_write_operation')
    expect(posts.scheduleWorkout).toHaveBeenCalledTimes(1)
    const afterAttempt = posts.total()

    const report = await reconcile(service, receipt.operationId as string)

    expect(report.readsIssued).toBe(1)
    expect(report.wroteToGarmin).toBe(false)
    expect(report.manualReviewRequired).toBe(true)
    expect(report.nextAction).toBe('reconcile_garmin_write_operation')
    expect(report.candidates).toEqual([])
    expect(report.observations).toMatchObject([
      {
        // A complete read that did not show it. "Not seen" is not "did not
        // apply", so the attempt stays unresolved.
        observation: 'observed_absent',
        status: 'unknown',
        unresolved: true,
        resumable: false,
        desiredStateSatisfied: false,
        complete: true,
      },
    ])
    // Three reads in total: the preview's, the confirmation's own re-read inside
    // the lock, and the reconcile's. A POST-less failure still owes its read.
    expect(calendar.requestsIssued).toBe(3)
    expect(posts.total()).toBe(afterAttempt)
  })

  it('stays unknown when the entry shows up once, and keeps the sighting as evidence only', async () => {
    const { service, calendar, posts } = harness()
    const receipt = await confirmSchedule(service, posts, timeoutError())
    const afterAttempt = posts.total()

    // The write did land; the response was lost. Exactly the case a blind retry
    // would duplicate.
    calendar.add({ date: DATE, workoutId: WORKOUT, workoutScheduleId: 'sid-landed' })

    const report = await reconcile(service, receipt.operationId as string)

    expect(report.observations).toMatchObject([
      {
        observation: 'observed_present',
        matchCount: 1,
        matchedScheduleIds: ['sid-landed'],
        evidence: 'observed_present',
        desiredStateSatisfied: true,
        // The *desired state* holds; the *attempt* is still unexplained. Both
        // facts are reported, and neither is spent as a receipt.
        status: 'unknown',
        unresolved: true,
        resumable: false,
      },
    ])
    expect(report.manualReviewRequired).toBe(true)
    expect(report.nextAction).toBe('reconcile_garmin_write_operation')
    expect(posts.total()).toBe(afterAttempt)
  })

  it('reports both candidates as duplicate_existing and deletes neither', async () => {
    const { service, calendar, posts } = harness()
    const receipt = await confirmSchedule(service, posts, timeoutError())
    const afterAttempt = posts.total()

    calendar.add({ date: DATE, workoutId: WORKOUT, workoutScheduleId: 'sid-a' })
    calendar.add({ date: DATE, workoutId: WORKOUT, workoutScheduleId: 'sid-b' })

    const report = await reconcile(service, receipt.operationId as string)

    expect(report.observations).toMatchObject([
      {
        observation: 'duplicate_existing',
        matchCount: 2,
        matchedScheduleIds: ['sid-a', 'sid-b'],
        resumable: false,
      },
    ])
    expect(report.manualReviewRequired).toBe(true)
    expect(posts.total()).toBe(afterAttempt)
    // Nothing was removed to make the target addressable again: both entries
    // survive the read that reported them, and the range read was a read.
    expect(calendar.reads[calendar.reads.length - 1]).toMatchObject({ startDate: DATE, endDate: DATE })
    expect(calendar.removeByScheduleId('sid-a')).toBe(1)
  })

  it('does not treat a same-named but different workout as the missing entry', async () => {
    const { service, calendar, posts } = harness()
    const receipt = await confirmSchedule(service, posts, timeoutError())
    const afterAttempt = posts.total()

    calendar.add({
      date: DATE,
      workoutId: 'someone-elses-workout',
      workoutScheduleId: 'sid-other',
      title: 'Easy run',
    })

    const report = await reconcile(service, receipt.operationId as string)

    expect(report.observations).toMatchObject([
      { observation: 'observed_absent', matchCount: 0, matchedScheduleIds: [] },
    ])
    expect(posts.total()).toBe(afterAttempt)
  })

  it('draws no conclusion from a partial read and records the failure', async () => {
    const partial = harness()
    const partialReceipt = await confirmSchedule(partial.service, partial.posts, timeoutError())
    const partialPosts = partial.posts.total()

    partial.calendar.setIncomplete({ startDate: DATE, endDate: DATE, timezone: TIMEZONE })
    const partialReport = await reconcile(partial.service, partialReceipt.operationId as string)

    expect(partialReport.observations).toMatchObject([
      { observation: 'undetermined', complete: false, evidence: 'none', resumable: false },
    ])
    expect(partialReport.manualReviewRequired).toBe(true)
    expect(partial.posts.total()).toBe(partialPosts)

    // A read that cannot be taken at all is reported as a failure. The read was
    // still *issued* — it reached the provider and the provider failed — so it
    // counts against the budget and the caller may reasonably try again later.
    const broken = harness()
    const brokenReceipt = await confirmSchedule(broken.service, broken.posts, timeoutError())
    const brokenPosts = broken.posts.total()
    broken.calendar.fail(new Error('502 from the calendar gateway'))

    const brokenReport = await reconcile(broken.service, brokenReceipt.operationId as string)

    expect(brokenReport.readsIssued).toBe(1)
    expect(brokenReport.failures).toHaveLength(1)
    expect(brokenReport.manualReviewRequired).toBe(true)
    // A configured reader that failed is not the same as no reader at all: the
    // first is worth another read, the second never will be.
    expect(brokenReport.nextAction).toBe('reconcile_garmin_write_operation')
    // The guidance must be "read again", never "send again". Checked as an
    // instruction to call a write tool rather than as a substring, because the
    // correct wording contains the words "never re-send the write".
    expect(JSON.stringify(brokenReport)).not.toMatch(
      /call (?:schedule|create|unschedule)_garmin_workout/i,
    )
    expect(brokenReport.nextActionDetail).toMatch(/never re-send the write/i)
    expect(brokenReport.message).toMatch(/never re-send the write/i)
    expect(broken.posts.total()).toBe(brokenPosts)
  })

  it('refuses a fresh preview for a key an unknown attempt still occupies', async () => {
    const { service, posts } = harness()
    const receipt = await confirmSchedule(service, posts, timeoutError())
    const afterAttempt = posts.total()

    // A caller-declared new operation for the same target. The unknown step is
    // unresolved, so the answer is "no", not "try again". A refusal is reported
    // as a top-level verdict — there is nothing to confirm.
    const again = await service.scheduleWorkout(scheduleArgs({ idempotencyKey: 'second-try' }) as never)

    expect(again).toMatchObject({
      requiresConfirmation: false,
      success: false,
      action: 'blocked',
      status: 'unknown',
      errorCode: WRITE_ERROR_CODES.WRITE_OUTCOME_UNKNOWN,
    })
    expect(posts.total()).toBe(afterAttempt)

    // And a resume cannot arm it either: unknown outcomes are never candidates.
    const resume = await resumeOperation(service, { operationId: receipt.operationId as string })
    expect(resume).toMatchObject({ requiresConfirmation: false, candidates: [] })
    expect(resume.refusals).toMatchObject([
      { code: WRITE_ERROR_CODES.WRITE_OUTCOME_UNKNOWN },
    ])
    expect(posts.total()).toBe(afterAttempt)
  })
})

// ---------------------------------------------------------------------------

describe('C7: reconcile is read-only by construction', () => {
  it('hands the reconciler a reader that has no write method on it', () => {
    const reader = new FakeCalendar()
    for (const name of ['schedule', 'unschedule', 'addWorkout', 'createWorkout', 'delete']) {
      expect((reader as unknown as Record<string, unknown>)[name]).toBeUndefined()
    }
    // The reader's whole surface is the read plus the fixture's own controls.
    expect(typeof reader.getCalendarRange).toBe('function')
  })

  it('contains no dispatch call in the reconcile module', () => {
    const raw = readFileSync(join(__dirname, '..', 'src', 'write-operations', 'reconcile.ts'), 'utf8')
    // Comments are prose, not reachability: strip them so a doc sentence that
    // mentions the word "writer" is not mistaken for a transport call.
    const source = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
    // A hidden re-send would have to appear as one of these. The module builds a
    // plan and takes reads; it never reaches for a write transport.
    for (const call of ['.schedule(', '.unschedule(', '.addWorkout(', 'transport', 'fetch(', 'request(']) {
      expect(source).not.toContain(call)
    }
    // The one capability it is handed is a read.
    expect(source).toContain('getCalendarRange')
  })

  it('never changes a step status, and never touches a POST, across every observation kind', async () => {
    const states: Array<[string, (calendar: FakeCalendar) => void]> = [
      ['empty', () => undefined],
      ['present', calendar => calendar.add({ date: DATE, workoutId: WORKOUT, workoutScheduleId: 'sid-1' })],
      ['duplicate', calendar => {
        calendar.add({ date: DATE, workoutId: WORKOUT, workoutScheduleId: 'sid-1' })
        calendar.add({ date: DATE, workoutId: WORKOUT, workoutScheduleId: 'sid-2' })
      }],
      ['incomplete', calendar => calendar.setIncomplete({ startDate: DATE, endDate: DATE, timezone: TIMEZONE })],
    ]

    for (const [label, arrange] of states) {
      const { service, calendar, posts } = harness()
      const receipt = await confirmSchedule(service, posts, timeoutError())
      const afterAttempt = posts.total()
      arrange(calendar)

      const report = await reconcile(service, receipt.operationId as string)

      expect(`${label}:${report.observations?.[0]?.status}`).toBe(`${label}:unknown`)
      expect(`${label}:${posts.total()}`).toBe(`${label}:${afterAttempt}`)
      expect(report.readsIssued).toBeLessThanOrEqual(report.maxReads)
    }
  })
})

// ---------------------------------------------------------------------------

describe('C7: resume re-arms only what the journal proves never applied', () => {
  /** One batch: a succeeds, b is provably rejected, c times out. */
  async function mixedBatch() {
    const h = harness()
    const preview = await h.service.batchScheduleWorkouts({
      timezone: TIMEZONE,
      schedules: [
        { workoutId: 'a', date: DATE },
        { workoutId: 'b', date: OTHER_DATE },
        { workoutId: 'c', date: '2026-09-19' },
      ],
    } as never)
    expect(preview.requiresConfirmation).toBe(true)

    h.posts.scheduleWorkout
      .mockResolvedValueOnce({ workoutScheduleId: 'sid-a' })
      .mockRejectedValueOnce(rejectedError())
      .mockRejectedValueOnce(timeoutError())

    const execution = await h.service.batchScheduleWorkouts({
      timezone: TIMEZONE,
      schedules: [
        { workoutId: 'a', date: DATE },
        { workoutId: 'b', date: OTHER_DATE },
        { workoutId: 'c', date: '2026-09-19' },
      ],
      confirmed: true,
      confirmationId: preview.confirmationId,
    } as never)

    return { h, preview, execution }
  }

  it('keeps the unknown entry out of the candidates and refuses it', async () => {
    const { h, preview } = await mixedBatch()

    const resume = await resumeOperation(h.service, { operationId: preview.operationId as string })

    expect(resume.requiresConfirmation).toBe(true)
    expect(resume.candidates).toMatchObject([
      { workoutId: 'b', date: OTHER_DATE, reason: 'proven_not_applied' },
    ])
    expect(resume.refusals).toMatchObject([
      { code: WRITE_ERROR_CODES.WRITE_OUTCOME_UNKNOWN },
    ])
    // The approval view lists every step with its verdict, so a human can see
    // which entry will be armed *and* why the others will not be.
    expect(resume.preview).toMatchObject([
      { workoutId: 'a', date: DATE, action: 'skip_existing', status: 'succeeded' },
      { workoutId: 'b', date: OTHER_DATE, action: 'write', status: 'prepared' },
      {
        workoutId: 'c',
        date: '2026-09-19',
        action: 'blocked',
        status: 'unknown',
        errorCode: WRITE_ERROR_CODES.WRITE_OUTCOME_UNKNOWN,
      },
    ])
    // Arming is not sending.
    expect(h.posts.scheduleWorkout).toHaveBeenCalledTimes(3)
  })

  it('re-arms exactly the proven step on confirmation and never the unknown one', async () => {
    const { h, preview } = await mixedBatch()
    const beforeResume = h.posts.total()

    const resume = await resumeOperation(h.service, { operationId: preview.operationId as string })
    h.posts.scheduleWorkout.mockResolvedValueOnce({ workoutScheduleId: 'sid-b' })

    const resumed = await resumeOperation(h.service, {
      operationId: preview.operationId as string,
      confirmed: true,
      confirmationId: resume.confirmationId,
    })

    // Exactly one new POST for the one safe entry - and it carried the
    // journaled day and template, not anything the caller passed.
    expect(h.posts.total()).toBe(beforeResume + 1)
    expect(h.posts.scheduleWorkout).toHaveBeenLastCalledWith('b', OTHER_DATE)
    expect(resumed).toMatchObject({ resumed: true, total: 3 })
    expect(resumed.results).toMatchObject([
      { workoutId: 'a', status: 'succeeded' },
      { workoutId: 'b', status: 'succeeded' },
      { workoutId: 'c', status: 'unknown' },
    ])
  })

  it('ignores a payload the caller tries to substitute, and the journal still wins', async () => {
    const { h, preview } = await mixedBatch()

    const resume = await resumeOperation(h.service, { operationId: preview.operationId as string })
    h.posts.scheduleWorkout.mockResolvedValueOnce({ workoutScheduleId: 'sid-b' })

    // There is no payload parameter on the tool. A caller who smuggles one in
    // must not be able to move the write to another day or template.
    const resumed = await resumeOperation(h.service, {
      operationId: preview.operationId as string,
      confirmed: true,
      confirmationId: resume.confirmationId,
      workoutId: 'someone-else',
      date: '2030-01-01',
      schedules: [{ workoutId: 'someone-else', date: '2030-01-01' }],
    } as never)

    expect(h.posts.scheduleWorkout).toHaveBeenLastCalledWith('b', OTHER_DATE)
    expect(h.posts.addWorkout).not.toHaveBeenCalled()
    expect(JSON.stringify(resumed)).not.toContain('2030-01-01')
    expect(JSON.stringify(resumed)).not.toContain('someone-else')
    // The armed step is the journaled one. The unknown step is still reported,
    // so the approval view stays complete.
    expect(resumed.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ workoutId: 'a', date: DATE }),
        expect.objectContaining({ workoutId: 'b', date: OTHER_DATE, status: 'succeeded' }),
      ]),
    )
    expect(resumed.results).toHaveLength(3)
  })

  it('re-arms nothing when every remaining entry is unresolved', async () => {
    const h = harness()
    const preview = await h.service.scheduleWorkout(scheduleArgs() as never)
    h.posts.scheduleWorkout.mockRejectedValueOnce(timeoutError())
    await h.service.scheduleWorkout({
      ...scheduleArgs(),
      confirmed: true,
      confirmationId: preview.confirmationId,
    } as never)
    const afterAttempt = h.posts.total()

    const resume = await resumeOperation(h.service, { operationId: preview.operationId as string })

    expect(resume).toMatchObject({ requiresConfirmation: false, candidates: [] })
    expect(resume.refusals).toMatchObject([{ code: WRITE_ERROR_CODES.WRITE_OUTCOME_UNKNOWN }])
    expect(h.posts.total()).toBe(afterAttempt)

    // Confirming a resume that arms nothing is still not a send. The preview
    // already said there was nothing to approve, so the only handle that could
    // exist is the one it just minted; using it must dispatch zero steps.
    const forced = await resumeOperation(h.service, {
      operationId: preview.operationId as string,
      confirmed: true,
      confirmationId: String(
        h.service['issueConfirmation'](preview.operationId as string, resume.previewRevision ?? 0),
      ),
    }).catch((error: Error) => ({ refused: error.message }))

    expect(h.posts.total()).toBe(afterAttempt)
    if (!('refused' in forced)) {
      // `total` counts the steps the reply reports, not the dispatches it
      // caused, so the proof that confirming changed nothing is that the one
      // remaining step is still unresolved and the POST counter never moved.
      expect(forced.results).toHaveLength(1)
      expect(forced.results).toMatchObject([{ status: 'unknown' }])
      expect(forced.unknownCount).toBe(1)
    } else expect(forced.refused).toMatch(/confirmation/i)
  })
})

// ---------------------------------------------------------------------------

describe('C7: create and unschedule recovery use recorded ids only', () => {
  const definition = {
    name: 'Easy run',
    sport: 'running',
    steps: [{ type: 'warmup', endCondition: 'time', endValue: 600 }],
  }

  it('reuses the id of a create that was accepted, without creating it again', async () => {
    const state = freshState()
    const calendar = new FakeCalendar()
    const first = harness(calendar, state)
    const preview = await first.service.createWorkout({ ...definition } as never)
    expect(preview.requiresConfirmation).toBe(true)
    const created = await first.service.createWorkout({
      ...definition,
      confirmed: true,
      confirmationId: preview.confirmationId,
    } as never)
    expect(created).toMatchObject({ success: true, workoutId: 'w-1' })
    expect(first.posts.addWorkout).toHaveBeenCalledTimes(1)

    // A restart with the same state: the recorded id is the answer, and the
    // definition is never posted a second time.
    const second = makeService(state, first.posts, calendar)
    const again = await second.createWorkout({ ...definition } as never)
    expect(again).toMatchObject({ success: true, alreadyCreated: true, workoutId: 'w-1' })
    expect(first.posts.addWorkout).toHaveBeenCalledTimes(1)
  })

  it('marks a create whose response was lost as manualReviewRequired and never re-creates it', async () => {
    const { service, posts } = harness()
    const preview = await service.createWorkout({ ...definition } as never)
    posts.addWorkout.mockRejectedValueOnce(timeoutError())

    const execution = await service.createWorkout({
      ...definition,
      confirmed: true,
      confirmationId: preview.confirmationId,
    } as never)
    expect(execution).toMatchObject({ success: false, blocked: true })
    expect(posts.addWorkout).toHaveBeenCalledTimes(1)

    const report = await reconcile(service, preview.operationId as string)
    expect(report.manualReviewRequired).toBe(true)
    expect(report.candidates).toEqual([])
    expect(report.nextAction).toBe('reconcile_garmin_write_operation')

    const resume = await resumeOperation(service, { operationId: preview.operationId as string })
    expect(resume).toMatchObject({ requiresConfirmation: false, candidates: [] })
    expect(resume.refusals).toMatchObject([{ code: WRITE_ERROR_CODES.WRITE_OUTCOME_UNKNOWN }])
    expect(posts.addWorkout).toHaveBeenCalledTimes(1)
  })

  it('never calls a schedule-id-only absence proof "already removed"', async () => {
    const h = harness()
    const target = 'sid-exact'
    const preview = await h.service.unscheduleWorkout({ workoutScheduleId: target } as never)
    expect(preview.requiresConfirmation).toBe(true)
    h.posts.unscheduleWorkout.mockRejectedValueOnce(timeoutError())
    await h.service.unscheduleWorkout({
      workoutScheduleId: target,
      confirmed: true,
      confirmationId: preview.confirmationId,
    } as never)
    const afterAttempt = h.posts.total()

    // A different entry on the same day is not this one.
    h.calendar.add({ date: DATE, workoutId: WORKOUT, workoutScheduleId: 'sid-something-else' })
    const elsewhere = await reconcile(h.service, preview.operationId as string)

    // And an empty calendar is not proof either. A schedule id alone gives the
    // planner no day to read, and this adapter has no verified by-id read, so
    // the step is refused as unreadable rather than concluded either way.
    h.calendar.clear()
    const absent = await reconcile(h.service, preview.operationId as string)

    for (const report of [elsewhere, absent]) {
      expect(report.observations).toEqual([])
      expect(report.unreadable).toMatchObject([
        { kind: 'unschedule', code: WRITE_ERROR_CODES.SCHEDULE_LOOKUP_UNSUPPORTED },
      ])
      expect(report.readsIssued).toBe(0)
      expect(report.manualReviewRequired).toBe(true)
    }
    expect(h.posts.total()).toBe(afterAttempt)
    expect(h.posts.unscheduleWorkout).toHaveBeenCalledTimes(1)
  })

  it('does not resolve an unschedule as satisfied from a mere range read', async () => {
    const h = harness()
    const target = 'sid-exact'
    const preview = await h.service.unscheduleWorkout({ workoutScheduleId: target } as never)
    h.posts.unscheduleWorkout.mockRejectedValueOnce(timeoutError())
    await h.service.unscheduleWorkout({
      workoutScheduleId: target,
      confirmed: true,
      confirmationId: preview.confirmationId,
    } as never)
    const afterAttempt = h.posts.total()

    h.calendar.clear()
    const report = await reconcile(h.service, preview.operationId as string)

    // Refused as unreadable rather than resolved as "already absent": no read
    // here can certify that this schedule instance no longer exists anywhere.
    expect(report.observations).toEqual([])
    expect(report.unreadable).toMatchObject([
      { kind: 'unschedule', code: WRITE_ERROR_CODES.SCHEDULE_LOOKUP_UNSUPPORTED },
    ])
    expect(report.manualReviewRequired).toBe(true)
    expect(h.posts.unscheduleWorkout).toHaveBeenCalledTimes(1)
    expect(h.posts.total()).toBe(afterAttempt)
  })
})

// ---------------------------------------------------------------------------

describe('C7: a durable success is not made permanent by the journal alone', () => {
  it('answers a repeat with the recorded receipt, and lets a declared new key re-preview after a manual deletion', async () => {
    const { service, calendar, posts } = harness()
    const receipt = await confirmSchedule(service, posts)
    expect(receipt).toMatchObject({ status: 'succeeded', success: true })
    expect(posts.scheduleWorkout).toHaveBeenCalledTimes(1)

    // The owner deleted the entry in the Garmin app. The journal does not know yet.
    calendar.removeByWorkoutAndDate(WORKOUT, DATE)

    // An anonymous repeat is answered from the receipt: no new read, no write.
    const anonymous = await service.scheduleWorkout(scheduleArgs() as never)
    expect(anonymous).toMatchObject({ requiresConfirmation: false, action: 'skip_existing' })
    expect(posts.scheduleWorkout).toHaveBeenCalledTimes(1)

    // A caller that declares a new operation gets a fresh, complete read, and
    // the read is what falsifies the old receipt.
    const declared = await service.scheduleWorkout(scheduleArgs({ idempotencyKey: 'after-deletion' }) as never)
    expect(declared.requiresConfirmation).toBe(true)

    const replacement = await service.scheduleWorkout({
      ...scheduleArgs({ idempotencyKey: 'after-deletion' }),
      confirmed: true,
      confirmationId: declared.confirmationId,
    } as never)
    expect(replacement).toMatchObject({ status: 'succeeded', success: true })
    expect(posts.scheduleWorkout).toHaveBeenCalledTimes(2)

    // The old receipt is still on disk: falsified, not rewritten. It keeps its
    // `succeeded` status even though the calendar no longer matches it.
    const operation = await service.getWriteOperation(receipt.operationId as string) as {
      steps: Array<{ status: string; supersedes?: { operationId: string }; workoutScheduleId?: string | null }>
    }
    expect(operation.steps).toMatchObject([{ status: 'succeeded' }])
    expect(operation.steps[0].supersedes).toBeUndefined()

    // The replacement records *why* the old receipt is no longer terminal. That
    // record is a note, not an authority: it is what makes the supersession
    // auditable without deleting the history it supersedes.
    const replacementOperation = await service.getWriteOperation(declared.operationId as string) as {
      steps: Array<{ status: string; supersedes?: { operationId: string; stepId?: string; observedAt?: string } }>
    }
    expect(replacementOperation.steps[0]).toMatchObject({ status: 'succeeded' })
    expect(replacementOperation.steps[0].supersedes).toMatchObject({
      operationId: receipt.operationId,
    })
  })

  it('does not let a falsified receipt be replaced when the day cannot be read', async () => {
    const { service, calendar, posts } = harness()
    await confirmSchedule(service, posts)
    const afterFirst = posts.total()
    calendar.setIncomplete({ startDate: DATE, endDate: DATE, timezone: TIMEZONE })

    const blocked = await service.scheduleWorkout(scheduleArgs({ idempotencyKey: 'blind-replace' }) as never)

    // Refused outright: with the day unreadable there is no evidence that would
    // justify superseding the old receipt, so there is nothing to approve.
    expect(blocked).toMatchObject({
      requiresConfirmation: false,
      success: false,
      action: 'blocked',
      status: 'not_attempted',
      errorCode: WRITE_ERROR_CODES.CALENDAR_INCOMPLETE,
    })
    expect(posts.total()).toBe(afterFirst)
  })
})

// ---------------------------------------------------------------------------

describe('C7: a decision is re-read before the approval is honoured', () => {
  it('turns a previewed write into a skip when the entry appears before confirmation', async () => {
    const h = harness()
    const preview = await h.service.scheduleWorkout(scheduleArgs() as never)
    expect(preview.requiresConfirmation).toBe(true)
    expect(preview.preview).toMatchObject({ action: 'write', status: 'prepared' })

    // Somebody added the same workout to the same day in the Garmin app between
    // the preview and the confirm. The approval covered "add it"; a fresh read
    // shows it is already there, so the entry is skipped instead of duplicated.
    h.calendar.add({ workoutId: WORKOUT, date: DATE, workoutScheduleId: 'sid-outside' })

    const confirmed = await h.service.scheduleWorkout({
      ...scheduleArgs(),
      confirmed: true,
      confirmationId: preview.confirmationId,
    } as never)

    expect(h.posts.total()).toBe(0)
    expect(confirmed).toMatchObject({
      status: 'skipped',
      success: true,
      desiredStateSatisfied: true,
      evidence: 'observed_present',
      workoutScheduleId: 'sid-outside',
      date: DATE,
    })
  })

  it('refuses a skip whose entry was deleted after the preview, and widens nothing', async () => {
    const h = harness()
    // `a` is already on its day, `b` is not, so only `b` may be armed. The
    // single approval therefore covers one write and one "leave it alone".
    h.calendar.add({ workoutId: 'a', date: DATE, workoutScheduleId: 'sid-a' })
    const schedules = [
      { workoutId: 'a', date: DATE },
      { workoutId: 'b', date: OTHER_DATE },
    ]

    const preview = await h.service.batchScheduleWorkouts({ timezone: TIMEZONE, schedules } as never)
    expect(preview.requiresConfirmation).toBe(true)
    expect(preview.preview).toMatchObject([
      { workoutId: 'a', date: DATE, action: 'skip_existing', status: 'skipped' },
      { workoutId: 'b', date: OTHER_DATE, action: 'write', status: 'prepared' },
    ])

    // The already-present entry is deleted before the approval is used. The
    // old approval said "leave `a` alone", so honouring it now would post a
    // write nobody approved: it must go back to needing a new preview.
    h.calendar.removeByScheduleId('sid-a')
    h.posts.scheduleWorkout.mockResolvedValueOnce({ workoutScheduleId: 'sid-b' })

    const confirmed = await h.service.batchScheduleWorkouts({
      timezone: TIMEZONE,
      schedules,
      confirmed: true,
      confirmationId: preview.confirmationId,
    } as never)
    const results = (confirmed as { results: Array<Record<string, unknown>> }).results

    expect(results.find(result => result.workoutId === 'a')).toMatchObject({
      status: 'not_attempted',
      success: false,
      errorCode: WRITE_ERROR_CODES.CONFIRMATION_STALE,
    })
    // The stale entry never became a POST, and the entry that really was
    // approved was dispatched exactly once — the refusal does not spill over.
    expect(h.posts.scheduleWorkout).not.toHaveBeenCalledWith('a', DATE)
    expect(h.posts.scheduleWorkout).toHaveBeenCalledTimes(1)
    expect(h.posts.scheduleWorkout).toHaveBeenLastCalledWith('b', OTHER_DATE)
    expect(results.find(result => result.workoutId === 'b')).toMatchObject({ status: 'succeeded' })
  })

  it('leaves a skip alone when the day cannot be read at confirmation time', async () => {
    const h = harness()
    h.calendar.add({ workoutId: 'a', date: DATE, workoutScheduleId: 'sid-a' })
    const schedules = [
      { workoutId: 'a', date: DATE },
      { workoutId: 'b', date: OTHER_DATE },
    ]
    const preview = await h.service.batchScheduleWorkouts({ timezone: TIMEZONE, schedules } as never)

    // An unreadable calendar is not evidence of absence. The approved decision
    // was "do not write", and that decision stands: the skip is reported as a
    // skip, never upgraded into a write.
    h.calendar.setIncomplete({ startDate: DATE, endDate: DATE, timezone: TIMEZONE })
    const confirmed = await h.service.batchScheduleWorkouts({
      timezone: TIMEZONE,
      schedules,
      confirmed: true,
      confirmationId: preview.confirmationId,
    } as never)
    const results = (confirmed as { results: Array<Record<string, unknown>> }).results

    expect(results.find(result => result.workoutId === 'a')).toMatchObject({ status: 'skipped' })
    expect(h.posts.scheduleWorkout).not.toHaveBeenCalledWith('a', DATE)
  })
})

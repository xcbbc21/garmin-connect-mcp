/**
 * Batch stop semantics (C5).
 *
 * The delivery contract lists exactly which conditions stop the remaining
 * entries of a batch and leave them `not_attempted`:
 *
 *   - the caller cancelled locally (process shutdown / AbortSignal)
 *   - the confirmation expired
 *   - the journal could not be written
 *   - the account lock was taken away
 *   - the credential lost its authority, or the identity changed
 *
 * Everything else — an entry-local rejection, a timeout, a 5xx, a socket reset
 * — is recorded against the entry that produced it and the batch CONTINUES,
 * because the caller asked for every entry to be attempted and because each
 * dispatch is durably journaled `in_flight` before it is sent.
 *
 * These tests drive the real `batch_schedule_garmin_workouts` path with an
 * injected store, lock and clock, so the stop decision is executed exactly as
 * it is in production.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GarminToolService, type GarminDataClient } from '../src/tool-service'
import {
  GarminWriteError,
  GarminWriteTransportError,
  WRITE_ERROR_CODES,
} from '../src/write-operations/errors'
import { accountKey } from '../src/write-operations/identity'
import { FileAccountLock, type AccountLock } from '../src/write-operations/lock'
import type { OperationStore } from '../src/write-operations/store'
import { emptyOperationDocument, type OperationDocument } from '../src/write-operations/types'

const ACCOUNT = accountKey('runner@example.test', 'cn')
const TIMEZONE = 'Asia/Shanghai'
const DATES = ['2026-10-01', '2026-10-02', '2026-10-03']
const IDS = ['w-a', 'w-b', 'w-c']

function freshState(): string {
  return mkdtempSync(join(tmpdir(), 'garmin-c5-batch-'))
}

/** Deep-cloning in-memory journal with an injectable save failure. */
class ScriptedStore implements OperationStore {
  private document: OperationDocument
  saves = 0
  /** Fail from this 1-based save index onwards. */
  failSaveAt = Number.POSITIVE_INFINITY

  constructor(account: string) {
    this.document = emptyOperationDocument(account)
  }

  async read(): Promise<OperationDocument> {
    return JSON.parse(JSON.stringify(this.document)) as OperationDocument
  }

  async save(document: OperationDocument): Promise<void> {
    this.saves += 1
    if (this.saves >= this.failSaveAt) {
      throw new GarminWriteError(
        WRITE_ERROR_CODES.STATE_UNAVAILABLE,
        'not_applied',
        'injected save failure',
      )
    }
    this.document = JSON.parse(JSON.stringify(document)) as OperationDocument
  }

  snapshot(): OperationDocument {
    return JSON.parse(JSON.stringify(this.document)) as OperationDocument
  }
}

/**
 * Real file lock (so mutual exclusion is genuine) plus a controllable
 * ownership answer, so "the lock was taken away between entries" can be
 * reproduced without a second process.
 */
class ControllableLock implements AccountLock {
  owned = true
  constructor(private readonly inner: AccountLock) {}
  runExclusive<T>(task: () => Promise<T>): Promise<T> {
    return this.inner.runExclusive(task)
  }
  async verifyOwned(): Promise<boolean> {
    return this.owned
  }
}

interface Harness {
  service: GarminToolService
  store: ScriptedStore
  lock: ControllableLock
  writer: jest.Mock
}

function makeHarness(options: {
  schedule: jest.Mock
  now?: () => Date
  signal?: AbortSignal
}): Harness {
  const store = new ScriptedStore(ACCOUNT)
  const lock = new ControllableLock(new FileAccountLock(freshState(), ACCOUNT))
  const writer = options.schedule
  const data: Partial<GarminDataClient> = {
    getWorkoutDetail: jest.fn().mockResolvedValue({ workoutName: 'Easy run' }),
    addWorkout: jest.fn().mockResolvedValue({ workoutId: 'created-1' }),
    scheduleWorkout: writer,
    unscheduleWorkout: jest.fn().mockResolvedValue(undefined),
  }
  const service = new GarminToolService(data as GarminDataClient, {
    activityDetail: 'compact',
    fitDownloadDir: '',
    accountUsername: 'runner@example.test',
    accountRegion: 'cn',
    operationStore: store,
    accountLock: lock,
    now: options.now,
    shutdownSignal: options.signal,
    newOperationId: () => 'op-batch-1',
    newStepId: (() => { let n = 0; return () => `step-${++n}` })(),
  })
  return { service, store, lock, writer }
}

/** Preview then confirm a 3-entry batch. */
async function runBatch(harness: Harness) {
  const schedules = IDS.map((workoutId, index) => ({ workoutId, date: DATES[index] }))
  const preview = await harness.service.batchScheduleWorkouts({
    schedules,
    timezone: TIMEZONE,
  } as never) as { confirmationId: string }
  return await harness.service.batchScheduleWorkouts({
    schedules,
    timezone: TIMEZONE,
    confirmed: true,
    confirmationId: preview.confirmationId,
  } as never) as {
    success: boolean
    operationId: string
    total: number
    successCount: number
    unknownCount: number
    notAttemptedCount: number
    definiteFailureCount: number
    results: Array<Record<string, unknown>>
  }
}

function ok(writer: jest.Mock): jest.Mock {
  return writer.mockImplementation(
    async (workoutId: string, date: string) => ({ workoutScheduleId: `sid-${workoutId}-${date}` }),
  )
}

describe('C5: batch stop conditions are the documented closed set', () => {
  it('a local cancel keeps the in-flight entry’s real outcome and stops the rest', async () => {
    const controller = new AbortController()
    const schedule = jest.fn().mockImplementationOnce(async (workoutId: string, date: string) => {
      // The process starts shutting down while this request is on the wire.
      controller.abort()
      return { workoutScheduleId: `sid-${workoutId}-${date}` }
    })
    // Implementations 2 and 3 must never run.
    const harness = makeHarness({ schedule, signal: controller.signal })
    const result = await runBatch(harness)

    // A local cancel is NOT proof that Garmin rolled anything back.
    expect(result.results[0]).toMatchObject({
      status: 'succeeded',
      success: true,
      desiredStateSatisfied: true,
      workoutId: IDS[0],
    })
    expect(result.results[1]).toMatchObject({
      status: 'not_attempted',
      success: false,
      errorCode: 'WRITE_NOT_APPLIED',
    })
    expect(result.results[2]).toMatchObject({ status: 'not_attempted', success: false })
    expect(result.results[1].nextAction).toContain('aborted')
    expect(harness.writer).toHaveBeenCalledTimes(1)

    expect(result).toMatchObject({
      success: false,
      total: 3,
      successCount: 1,
      notAttemptedCount: 2,
      unknownCount: 0,
      definiteFailureCount: 0,
    })
  })

  it('a signal aborted before the batch starts dispatches nothing at all', async () => {
    const controller = new AbortController()
    controller.abort()
    const harness = makeHarness({ schedule: ok(jest.fn()), signal: controller.signal })
    const result = await runBatch(harness)

    expect(harness.writer).not.toHaveBeenCalled()
    expect(result).toMatchObject({ notAttemptedCount: 3, successCount: 0, unknownCount: 0 })
    expect(result.results.map(entry => entry.status)).toEqual([
      'not_attempted', 'not_attempted', 'not_attempted',
    ])
  })

  it('losing the account lock between entries stops the batch at the next entry', async () => {
    const lockRef: { current?: ControllableLock } = {}
    const schedule = jest.fn().mockImplementationOnce(async (workoutId: string, date: string) => {
      // Another process (or an operator following the offline recovery steps)
      // removed the lock directory while this batch was running.
      if (lockRef.current) lockRef.current.owned = false
      return { workoutScheduleId: `sid-${workoutId}-${date}` }
    })
    const harness = makeHarness({ schedule })
    lockRef.current = harness.lock
    const result = await runBatch(harness)

    expect(result.results[0]).toMatchObject({ status: 'succeeded' })
    expect(result.results[1]).toMatchObject({
      status: 'not_attempted',
      errorCode: 'OPERATION_BUSY',
      canResume: true,
      manualReviewRequired: false,
    })
    expect(result.results[2]).toMatchObject({ status: 'not_attempted', errorCode: 'OPERATION_BUSY' })
    expect(result.results[1].nextAction).toContain('lock_lost')
    expect(harness.writer).toHaveBeenCalledTimes(1)
  })

  it('a confirmation that expires mid-batch refuses the remaining dispatches', async () => {
    let clock = Date.parse('2026-09-10T00:00:00.000Z')
    const schedule = jest.fn().mockImplementationOnce(async (workoutId: string, date: string) => {
      // The batch outlives the 10 minute confirmation TTL.
      clock = Date.parse('2026-09-10T01:00:00.000Z')
      return { workoutScheduleId: `sid-${workoutId}-${date}` }
    })
    const harness = makeHarness({ schedule, now: () => new Date(clock) })
    const result = await runBatch(harness)

    expect(result.results[0]).toMatchObject({ status: 'succeeded' })
    expect(result.results[1]).toMatchObject({
      status: 'not_attempted',
      errorCode: 'CONFIRMATION_STALE',
      canResume: true,
      manualReviewRequired: false,
    })
    expect(result.results[2]).toMatchObject({ status: 'not_attempted', errorCode: 'CONFIRMATION_STALE' })
    expect(harness.writer).toHaveBeenCalledTimes(1)

    // The blocker named in the remaining entries' guidance is a real step in
    // the durable journal, not a made-up pointer.
    const operation = await harness.service.getWriteOperation(result.operationId) as {
      steps: Array<{ stepId: string; status: string }>
    }
    const blockerStepId = operation.steps[1].stepId
    expect(operation.steps[1].status).toBe('not_attempted')
    expect(result.results[2].nextAction).toContain(blockerStepId)
    expect(result.results[2].nextAction).toContain('expired')
  })

  it('a journal write failure before dispatch sends nothing and stops the batch', async () => {
    const harness = makeHarness({ schedule: ok(jest.fn()) })
    // Save 1 = preview. 2 and 3 = entry 1 pre/post dispatch. 4 = entry 2
    // pre-dispatch, which is the one that fails.
    harness.store.failSaveAt = 4
    const result = await runBatch(harness)

    expect(result.results[0]).toMatchObject({ status: 'succeeded' })
    expect(result.results[1]).toMatchObject({
      status: 'failed',
      success: false,
      errorCode: 'STATE_UNAVAILABLE',
      canResume: false,
      manualReviewRequired: false,
      desiredStateSatisfied: false,
    })
    expect(result.results[2]).toMatchObject({ status: 'not_attempted', errorCode: 'STATE_UNAVAILABLE' })
    expect(result.results[1].nextAction).toContain('provably was not sent')
    expect(harness.writer).toHaveBeenCalledTimes(1)

    // Nothing claimed an attempt for the entry that could not be journaled.
    const persisted = harness.store.snapshot()
    const steps = persisted.operations[result.operationId].steps
    expect(steps[1]).toMatchObject({ status: 'prepared', attempt: 0 })
    expect(steps[2]).toMatchObject({ status: 'prepared', attempt: 0 })
  })

  it('a credential that loses authority mid-batch stops the rest and parks the blocker for reconcile', async () => {
    const schedule = jest
      .fn()
      .mockImplementationOnce(async (workoutId: string, date: string) => ({
        workoutScheduleId: `sid-${workoutId}-${date}`,
      }))
      .mockImplementationOnce(async () => {
        throw new GarminWriteTransportError(
          'unknown',
          WRITE_ERROR_CODES.WRITE_AUTH_EXPIRED,
          'Garmin Calendar returned 401 after the request was built',
        )
      })
    const harness = makeHarness({ schedule })
    const result = await runBatch(harness)

    expect(result.results[0]).toMatchObject({ status: 'succeeded' })
    expect(result.results[1]).toMatchObject({
      status: 'unknown',
      success: false,
      errorCode: 'WRITE_AUTH_EXPIRED',
      canResume: false,
      manualReviewRequired: true,
      nextAction: 'reconcile_garmin_write_operation',
    })
    expect(result.results[2]).toMatchObject({
      status: 'not_attempted',
      errorCode: 'WRITE_AUTH_EXPIRED',
      canResume: true,
      manualReviewRequired: false,
    })
    // A halted entry owns no calendar object: it must not report the blocker's
    // entry, evidence or calendar id as its own.
    expect(result.results[2]).toMatchObject({
      workoutScheduleId: null,
      evidence: 'none',
      desiredStateSatisfied: false,
    })
    expect(harness.writer).toHaveBeenCalledTimes(2)

    expect(result).toMatchObject({
      unknownCount: 1,
      notAttemptedCount: 1,
      definiteFailureCount: 0,
      successCount: 1,
    })
  })

  it('an entry-local transport failure does NOT stop the batch', async () => {
    const schedule = jest
      .fn()
      .mockImplementationOnce(async (workoutId: string, date: string) => ({
        workoutScheduleId: `sid-${workoutId}-${date}`,
      }))
      .mockImplementationOnce(async () => {
        throw new GarminWriteTransportError(
          'unknown',
          WRITE_ERROR_CODES.WRITE_OUTCOME_UNKNOWN,
          'timed out after dispatch',
        )
      })
      .mockImplementationOnce(async (workoutId: string, date: string) => ({
        workoutScheduleId: `sid-${workoutId}-${date}`,
      }))
    const harness = makeHarness({ schedule })
    const result = await runBatch(harness)

    expect(result.results.map(entry => entry.status)).toEqual(['succeeded', 'unknown', 'succeeded'])
    expect(harness.writer).toHaveBeenCalledTimes(3)

    // The caller asked for every entry, and the timeout is already durably
    // journaled, so continuing loses nothing.
    expect(result).toMatchObject({
      successCount: 2,
      unknownCount: 1,
      notAttemptedCount: 0,
      definiteFailureCount: 0,
    })
    expect(result.results[1].nextAction).toBe('reconcile_garmin_write_operation')
  })
})

/**
 * Transport-level write semantics (C5).
 *
 * These drive the real `GarminClient` calendar transport and the real
 * `GarminToolService`, so the following contract is executed rather than
 * described:
 *
 *   - a timeout is `unknown`, never `not_applied`, and the late promise that
 *     the old `Promise.race` abandoned is still handled (no unhandled
 *     rejection);
 *   - a late result never upgrades the durable record, and never causes a
 *     second POST;
 *   - the recovery handle (`operationId`) survives a timed-out write;
 *   - the account-lock budget bounds BOTH the in-process queue and the
 *     on-disk lock, and an externally held lock is never preempted;
 *   - an identity change mid-batch stops the rest of the batch instead of
 *     continuing to write as an account the caller did not approve.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GarminConnect } from 'garmin-connect'
import { GarminClient } from '../src/client'
import type { Config } from '../src/config'
import { GarminToolService, type GarminDataClient } from '../src/tool-service'
import { GarminWriteIdentityChangedError } from '../src/write-operations/errors'
import { FileAccountLock } from '../src/write-operations/lock'
import { accountKey } from '../src/write-operations/identity'

jest.mock('garmin-connect', () => ({
  GarminConnect: jest.fn().mockImplementation(() => ({
    client: {
      client: {
        defaults: {},
        interceptors: {
          request: { clear: jest.fn(), use: jest.fn() },
          response: { clear: jest.fn(), use: jest.fn() },
        },
        request: jest.fn(),
      },
    },
    login: jest.fn().mockResolvedValue(undefined),
    loadToken: jest.fn(),
    exportToken: jest.fn(),
    addWorkout: jest.fn(),
    // The real client reads the workout before a calendar write; without this
    // the transport double would fail before it ever reached the POST.
    getWorkoutDetail: jest.fn().mockResolvedValue({ workoutName: 'Easy run' }),
  })),
}))

const ACCOUNT = accountKey('runner@example.test', 'global')
const TIMEZONE = 'Asia/Shanghai'
const WORKOUT = 'w-transport'
const DATE = '2026-10-05'

/** The Axios double the client actually dispatches through. */
function transport(): jest.Mock {
  const constructor = GarminConnect as unknown as jest.Mock
  const garmin = constructor.mock.results.at(-1)?.value as {
    client: { client: { request: jest.Mock } }
  }
  return garmin.client.client.request
}

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    username: 'runner@example.test',
    password: 'password-value',
    sessionToken: '',
    sessionTokenFile: '',
    region: 'global',
    cacheTtl: 0,
    logLevel: 'error',
    activityDetail: 'compact',
    fitDownloadDir: '/tmp/garmin-write-transport-test',
    ...overrides,
  }
}

function makeHarness(options: { requestTimeoutMs: number; client?: GarminDataClient }) {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'garmin-transport-'))
  const client = options.client
    ?? new GarminClient(baseConfig({ requestTimeoutMs: options.requestTimeoutMs }), {
      logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    })
  const service = new GarminToolService(client as GarminDataClient, {
    activityDetail: 'compact',
    fitDownloadDir: '',
    accountUsername: 'runner@example.test',
    accountRegion: 'global',
    stateDirectory,
  })
  return { service, client, stateDirectory }
}

async function confirm(service: GarminToolService) {
  const request = { workoutId: WORKOUT, date: DATE, timezone: TIMEZONE }
  const preview = await service.scheduleWorkout(request as never)
  return await service.scheduleWorkout({
    ...request,
    confirmed: true,
    confirmationId: preview.confirmationId,
  } as never)
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Collect unhandled rejections for the duration of a test.
 *
 * `Promise.race` used to leave the losing promise unobserved. It does attach a
 * handler, but the requirement is that this is *proved*, not assumed, so each
 * test asserts the collector stayed empty.
 */
const unhandled: unknown[] = []
const collectUnhandled = (reason: unknown) => { unhandled.push(reason) }

beforeEach(() => {
  unhandled.length = 0
  process.on('unhandledRejection', collectUnhandled)
})

afterEach(() => {
  process.off('unhandledRejection', collectUnhandled)
})

describe('C5: a timed-out write is unknown and leaves no unhandled rejection', () => {
  it('keeps the operationId when the request fails after the deadline', async () => {
    const harness = makeHarness({ requestTimeoutMs: 40 })
    transport().mockImplementation(
      () => new Promise((_resolve, reject) => {
        // Rejects well after the deadline already won the race.
        setTimeout(() => reject(new Error('socket reset after the deadline')), 120)
      }),
    )

    const result = await confirm(harness.service)

    expect(result).toMatchObject({
      success: false,
      status: 'unknown',
      desiredStateSatisfied: false,
      canResume: false,
      manualReviewRequired: true,
      nextAction: 'reconcile_garmin_write_operation',
    })
    expect(typeof result.operationId).toBe('string')
    expect((result.operationId as string).length).toBeGreaterThan(0)
    expect(result).not.toHaveProperty('confirmationId')
    expect(transport()).toHaveBeenCalledTimes(1)

    // Let the abandoned promise settle, then prove nothing escaped.
    await delay(200)
    expect(unhandled).toEqual([])
  })

  it('does not upgrade the record or re-send when the request succeeds after the deadline', async () => {
    const harness = makeHarness({ requestTimeoutMs: 40 })
    transport().mockImplementation(
      () => new Promise(resolve => {
        setTimeout(() => resolve({ data: { workoutScheduleId: 'sid-late' } }), 120)
      }),
    )

    const result = await confirm(harness.service)
    expect(result).toMatchObject({
      success: false,
      status: 'unknown',
      manualReviewRequired: true,
    })

    // The late success must not be adopted as evidence anywhere.
    await delay(200)
    expect(unhandled).toEqual([])
    expect(transport()).toHaveBeenCalledTimes(1)

    // Re-previewing the same target is blocked by the unresolved attempt
    // instead of offering a second POST.
    const again = await harness.service.scheduleWorkout({
      workoutId: WORKOUT,
      date: DATE,
      timezone: TIMEZONE,
    } as never)
    expect(again).toMatchObject({ requiresConfirmation: false, success: false })
    expect(transport()).toHaveBeenCalledTimes(1)
  })

  it('classifies a plain transport reset as unknown rather than not applied', async () => {
    const harness = makeHarness({ requestTimeoutMs: 5_000 })
    transport().mockRejectedValue(new Error('ECONNRESET'))

    const result = await confirm(harness.service)
    expect(result).toMatchObject({
      success: false,
      status: 'unknown',
      manualReviewRequired: true,
      nextAction: 'reconcile_garmin_write_operation',
    })
    expect(result.errorCode).toBe('WRITE_OUTCOME_UNKNOWN')
    await delay(0)
    expect(unhandled).toEqual([])
  })
})

describe('C5: the account lock budget is shared and never preempts a holder', () => {
  it('abandons the in-process queue when the shared budget expires', async () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), 'garmin-lock-queue-'))
    const lock = new FileAccountLock(stateDirectory, ACCOUNT, undefined, {
      waitTimeoutMs: 80,
      pollIntervalMs: 5,
    })

    let releaseHolder: () => void = () => {}
    let ranQueuedTask = false
    const holder = lock.runExclusive(async () => {
      await new Promise<void>(resolve => { releaseHolder = resolve })
    })
    // Let the holder actually acquire the on-disk lock.
    await delay(20)

    const startedAt = Date.now()
    await expect(
      lock.runExclusive(async () => { ranQueuedTask = true }),
    ).rejects.toMatchObject({ code: 'OPERATION_BUSY' })
    const waited = Date.now() - startedAt

    // The holder is still inside its critical section (it needs an explicit
    // release), so anything below that proves the wait was bounded by the
    // budget instead of by the holder.
    expect(waited).toBeLessThan(500)
    expect(waited).toBeGreaterThanOrEqual(50)
    expect(ranQueuedTask).toBe(false)

    releaseHolder()
    await holder

    // The abandoned queue slot must not wedge the lock for later callers.
    await expect(lock.runExclusive(async () => 'after')).resolves.toBe('after')
  })

  it('allows a queued caller that fits inside the budget', async () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), 'garmin-lock-fast-'))
    const lock = new FileAccountLock(stateDirectory, ACCOUNT, undefined, {
      waitTimeoutMs: 2_000,
      pollIntervalMs: 5,
    })

    const first = lock.runExclusive(async () => {
      await delay(20)
      return 'first'
    })
    const second = lock.runExclusive(async () => 'second')

    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second'])
  })

  it('reports OPERATION_BUSY for a lock held by another process without removing it', async () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), 'garmin-lock-foreign-'))
    const lock = new FileAccountLock(stateDirectory, ACCOUNT, undefined, {
      waitTimeoutMs: 60,
      pollIntervalMs: 5,
    })

    // Another process holds the lock: the directory exists and records a token
    // this instance did not mint.
    mkdirSync(lock.path, { recursive: true })
    writeFileSync(
      join(lock.path, 'owner.json'),
      JSON.stringify({ ownerToken: 'other-process', pid: 4242, startedAt: new Date().toISOString() }),
    )

    let ran = false
    const startedAt = Date.now()
    await expect(lock.runExclusive(async () => { ran = true }))
      .rejects.toMatchObject({ code: 'OPERATION_BUSY' })
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(ran).toBe(false)

    // No TTL preemption: the foreign lock survives untouched.
    await expect(lock.verifyOwned()).resolves.toBe(false)
    await expect(lock.readOwner()).resolves.toMatchObject({ ownerToken: 'other-process' })
  })
})

describe('C5: an identity change stops the batch instead of writing as the new account', () => {
  function batchClient(schedule: jest.Mock): GarminDataClient {
    return {
      getWorkoutDetail: jest.fn().mockResolvedValue({ workoutName: 'Easy run' }),
      addWorkout: jest.fn().mockResolvedValue({ workoutId: 'created-1' }),
      scheduleWorkout: schedule,
      unscheduleWorkout: jest.fn().mockResolvedValue(undefined),
    } as unknown as GarminDataClient
  }

  it('parks the in-flight entry and leaves the rest not_attempted', async () => {
    const schedule = jest
      .fn()
      .mockImplementationOnce(async (workoutId: string, date: string) => ({
        workoutScheduleId: `sid-${workoutId}-${date}`,
      }))
      .mockImplementationOnce(async () => {
        throw new GarminWriteIdentityChangedError(
          'Garmin authentication changed during calendar update; outcome is unknown',
        )
      })
    const harness = makeHarness({ requestTimeoutMs: 5_000, client: batchClient(schedule) })
    const schedules = [
      { workoutId: 'w-a', date: '2026-10-01' },
      { workoutId: 'w-b', date: '2026-10-02' },
      { workoutId: 'w-c', date: '2026-10-03' },
    ]

    const preview = await harness.service.batchScheduleWorkouts({
      schedules, timezone: TIMEZONE,
    } as never) as { confirmationId: string }
    const result = await harness.service.batchScheduleWorkouts({
      schedules, timezone: TIMEZONE, confirmed: true, confirmationId: preview.confirmationId,
    } as never) as {
      successCount: number
      unknownCount: number
      notAttemptedCount: number
      results: Array<Record<string, unknown>>
    }

    expect(result.results[0]).toMatchObject({ status: 'succeeded', success: true })
    expect(result.results[1]).toMatchObject({
      status: 'unknown',
      success: false,
      errorCode: 'WRITE_OUTCOME_UNKNOWN',
      canResume: false,
      manualReviewRequired: true,
      nextAction: 'reconcile_garmin_write_operation',
    })
    // The rest of the batch is NOT sent under the new identity.
    expect(result.results[2]).toMatchObject({
      status: 'not_attempted',
      success: false,
      canResume: true,
      manualReviewRequired: false,
      workoutScheduleId: null,
      evidence: 'none',
    })
    expect(schedule).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ successCount: 1, unknownCount: 1, notAttemptedCount: 1 })
  })
})

/**
 * Unschedule recovery tests (C5).
 *
 * `unschedule_garmin_workout` removes one Garmin Calendar entry. A removal is
 * as non-idempotent as a schedule, so it goes through the same coordinator:
 * the step is journaled `in_flight` before the single dispatch, re-confirms
 * replay the durable receipt, a restart never re-dispatches, and the three
 * failure classes stay distinguishable:
 *
 *   - the login was never valid  -> `failed` / WRITE_NOT_APPLIED (retryable)
 *   - the request was dispatched -> `unknown` (blocked until reconciled)
 *   - the confirmation expired   -> `not_attempted` / CONFIRMATION_STALE
 *
 * These are contract tests: they assert the durable journal on disk, not only
 * the returned tool payload.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GarminToolService, type GarminDataClient } from '../src/tool-service'
import {
  GarminWriteIdentityChangedError,
  GarminWriteTransportError,
  WRITE_ERROR_CODES,
} from '../src/write-operations/errors'
import { GarminAuthenticationRequiredError } from '../src/utils/errors'

const ACCOUNT = 'runner@example.test'
const REGION = 'cn'
const SCHEDULE_ID = 'sid-abc-123'

function freshState(): string {
  return mkdtempSync(join(tmpdir(), 'garmin-c5-unsched-'))
}

interface Harness {
  service: GarminToolService
  unscheduleWorkout: jest.Mock
  stateDirectory: string
}

function makeService(
  stateDirectory: string,
  unscheduleWorkout: jest.Mock,
  now?: () => Date,
): Harness {
  const data: Partial<GarminDataClient> = {
    getWorkoutDetail: jest.fn().mockResolvedValue({ workoutName: 'Easy run' }),
    addWorkout: jest.fn().mockResolvedValue({ workoutId: 'w-1' }),
    scheduleWorkout: jest.fn().mockResolvedValue({ workoutScheduleId: SCHEDULE_ID }),
    unscheduleWorkout,
  }
  const service = new GarminToolService(data as GarminDataClient, {
    activityDetail: 'compact',
    fitDownloadDir: '',
    accountUsername: ACCOUNT,
    accountRegion: REGION,
    stateDirectory,
    now,
  })
  return { service, unscheduleWorkout, stateDirectory }
}

/** Preview then confirm one unschedule, returning both payloads. */
async function confirmUnschedule(service: GarminToolService, workoutScheduleId = SCHEDULE_ID) {
  const preview = await service.unscheduleWorkout({ workoutScheduleId } as never)
  const result = await service.unscheduleWorkout({
    workoutScheduleId,
    confirmed: true,
    confirmationId: (preview as { confirmationId: string }).confirmationId,
  } as never)
  return { preview, result }
}

describe('C5: unschedule is journaled, deduped and honest about failure', () => {
  it('journals before dispatch, then replays the durable receipt after a restart', async () => {
    const state = freshState()
    const counters = makeService(state, jest.fn().mockResolvedValue(undefined))
    const { preview, result } = await confirmUnschedule(counters.service)
    const confirmationId = (preview as { confirmationId: string }).confirmationId
    expect(result).toMatchObject({ success: true, workoutScheduleId: SCHEDULE_ID })
    expect(counters.unscheduleWorkout).toHaveBeenCalledTimes(1)
    expect(counters.unscheduleWorkout).toHaveBeenCalledWith(SCHEDULE_ID)

    // Restart: a brand-new service with a FRESH mock reads the same on-disk
    // journal. Neither the durable confirmation handle nor a plain preview may
    // produce a second removal.
    const after = makeService(state, jest.fn().mockResolvedValue(undefined))
    const replay = await after.service.unscheduleWorkout({
      workoutScheduleId: SCHEDULE_ID,
      confirmed: true,
      confirmationId,
    } as never)
    expect(replay).toMatchObject({ success: true, workoutScheduleId: SCHEDULE_ID })

    const preview2 = await after.service.unscheduleWorkout({ workoutScheduleId: SCHEDULE_ID } as never)
    expect(preview2).toMatchObject({ success: true, alreadyRemoved: true })
    expect(preview2).not.toHaveProperty('confirmationId')
    expect(after.unscheduleWorkout).not.toHaveBeenCalled()
  })

  it('a re-confirmed unschedule in the same process never dispatches twice', async () => {
    const state = freshState()
    const harness = makeService(state, jest.fn().mockResolvedValue(undefined))
    const preview = await harness.service.unscheduleWorkout({ workoutScheduleId: SCHEDULE_ID } as never)
    const confirmationId = (preview as { confirmationId: string }).confirmationId
    for (let i = 0; i < 4; i++) {
      const replay = await harness.service.unscheduleWorkout({
        workoutScheduleId: SCHEDULE_ID,
        confirmed: true,
        confirmationId,
      } as never)
      expect(replay).toMatchObject({ success: true })
    }
    expect(harness.unscheduleWorkout).toHaveBeenCalledTimes(1)
  })

  it('records a not-dispatched credential failure as failed/WRITE_NOT_APPLIED and allows a fresh preview', async () => {
    const state = freshState()
    const unschedule = jest
      .fn()
      .mockRejectedValueOnce(new GarminAuthenticationRequiredError('missing'))
      .mockResolvedValueOnce(undefined)
    const harness = makeService(state, unschedule)

    const { result } = await confirmUnschedule(harness.service)
    expect(result).toMatchObject({
      success: false,
      blocked: false,
      errorCode: 'WRITE_NOT_APPLIED',
      operationId: expect.any(String),
    })

    // The journal must say `failed`, never `unknown`: the connection gate runs
    // before the request is built, so nothing reached Garmin.
    const operation = await harness.service.getWriteOperation(
      (result as { operationId: string }).operationId,
    ) as { steps: Array<Record<string, unknown>> }
    expect(operation.steps[0]).toMatchObject({
      kind: 'unschedule',
      status: 'failed',
      evidence: 'none',
      errorCode: 'WRITE_NOT_APPLIED',
    })
    expect(operation.steps[0].attempts).toEqual([
      expect.objectContaining({ attempt: 1, outcome: 'failed', errorCode: 'WRITE_NOT_APPLIED' }),
    ])

    // A proven non-application is retryable through a fresh preview.
    const retry = await harness.service.unscheduleWorkout({ workoutScheduleId: SCHEDULE_ID } as never)
    expect(retry).toMatchObject({ requiresConfirmation: true })
    const retried = await harness.service.unscheduleWorkout({
      workoutScheduleId: SCHEDULE_ID,
      confirmed: true,
      confirmationId: (retry as { confirmationId: string }).confirmationId,
    } as never)
    expect(retried).toMatchObject({ success: true })
    expect(unschedule).toHaveBeenCalledTimes(2)
  })

  it('keeps a dispatched-and-lost unschedule unknown, blocks a retry and points at reconcile', async () => {
    const state = freshState()
    const unschedule = jest
      .fn()
      .mockRejectedValueOnce(
        new GarminWriteTransportError(
          'unknown',
          WRITE_ERROR_CODES.WRITE_OUTCOME_UNKNOWN,
          'socket hang up after dispatch',
        ),
      )
      .mockResolvedValueOnce(undefined)
    const harness = makeService(state, unschedule)

    const { result } = await confirmUnschedule(harness.service)
    expect(result).toMatchObject({
      success: false,
      blocked: true,
      errorCode: 'WRITE_OUTCOME_UNKNOWN',
    })

    // A retry must not be offered: the removal may already have happened.
    const again = await harness.service.unscheduleWorkout({ workoutScheduleId: SCHEDULE_ID } as never)
    expect(again).toMatchObject({
      success: false,
      blocked: true,
      errorCode: 'WRITE_OUTCOME_UNKNOWN',
    })
    expect(again).not.toHaveProperty('confirmationId')
    expect(unschedule).toHaveBeenCalledTimes(1)
  })

  it('treats an identity change after dispatch as unknown, not as a retryable failure', async () => {
    const state = freshState()
    const unschedule = jest.fn().mockRejectedValueOnce(
      new GarminWriteIdentityChangedError('the authenticated Garmin account changed during an unschedule'),
    )
    const harness = makeService(state, unschedule)

    const { result } = await confirmUnschedule(harness.service)
    expect(result).toMatchObject({ success: false, blocked: true, errorCode: 'WRITE_OUTCOME_UNKNOWN' })
    const operation = await harness.service.getWriteOperation(
      (result as { operationId: string }).operationId,
    ) as { steps: Array<Record<string, unknown>> }
    expect(operation.steps[0]).toMatchObject({ status: 'unknown', evidence: 'none' })
  })

  it('refuses to dispatch an unschedule whose confirmation expired, without calling Garmin', async () => {
    const state = freshState()
    let clock = Date.parse('2026-09-10T00:00:00.000Z')
    const unschedule = jest.fn().mockResolvedValue(undefined)
    const harness = makeService(state, unschedule, () => new Date(clock))

    const preview = await harness.service.unscheduleWorkout({ workoutScheduleId: SCHEDULE_ID } as never)
    expect(preview).toMatchObject({ requiresConfirmation: true })

    // Past the 10 minute confirmation TTL.
    clock = Date.parse('2026-09-10T01:00:00.000Z')
    const expired = await harness.service.unscheduleWorkout({
      workoutScheduleId: SCHEDULE_ID,
      confirmed: true,
      confirmationId: (preview as { confirmationId: string }).confirmationId,
    } as never)

    expect(expired).toMatchObject({
      success: false,
      blocked: false,
      errorCode: 'CONFIRMATION_STALE',
    })
    expect(unschedule).not.toHaveBeenCalled()

    const operation = await harness.service.getWriteOperation(
      (expired as { operationId: string }).operationId,
    ) as { steps: Array<Record<string, unknown>> }
    expect(operation.steps[0]).toMatchObject({
      status: 'not_attempted',
      evidence: 'none',
      errorCode: 'CONFIRMATION_STALE',
      attempt: 0,
    })
  })

  it('a superseded confirmation handle cannot dispatch an unschedule', async () => {
    const state = freshState()
    const harness = makeService(state, jest.fn().mockResolvedValue(undefined))
    const first = await harness.service.unscheduleWorkout({ workoutScheduleId: SCHEDULE_ID } as never)
    const staleHandle = (first as { confirmationId: string }).confirmationId

    // A second preview advances the revision and invalidates the old handle.
    const second = await harness.service.unscheduleWorkout({ workoutScheduleId: SCHEDULE_ID } as never)
    expect(second).toMatchObject({ requiresConfirmation: true })
    expect((second as { confirmationId: string }).confirmationId).not.toBe(staleHandle)

    await expect(harness.service.unscheduleWorkout({
      workoutScheduleId: SCHEDULE_ID,
      confirmed: true,
      confirmationId: staleHandle,
    } as never)).rejects.toMatchObject({ code: 'CONFIRMATION_STALE' })
    expect(harness.unscheduleWorkout).not.toHaveBeenCalled()
  })
})

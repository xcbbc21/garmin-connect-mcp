/**
 * Confirmation lifecycle tests (C3 / F3 / F5).
 *
 * A confirmation must be a durable, immutable handle, not process memory:
 *
 *   F3  a preview that was never confirmed may be re-previewed under the same
 *       idempotency key; the operation is reused, the preview revision advances
 *       and the *previous* handle stops working — in this process and in a later
 *       one.
 *   TTL an expired revision may not dispatch a new write, but a re-preview
 *       immediately restores the ability, and nothing is silently retried.
 *   F1  a different key or a different payload must never rewrite the request,
 *       steps or bindings of an existing key.
 *   F5  the persisted document must hold only the hash of the caller's
 *       idempotency key, never the plaintext, and the canonical request must
 *       exclude caller control fields.
 *   rearm work that the journal proves was never sent may be armed again by a
 *       new confirmation; `unknown` / `in_flight` work never may.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GarminToolService, type GarminDataClient } from '../src/tool-service'
import { FakeCalendar } from './fixtures/calendar/fake-calendar'
import { accountKey, idempotencyKeyHash, requestHash } from '../src/write-operations/identity'
import { GarminWriteTransportError } from '../src/write-operations/errors'
import { readOperationDocument } from './helpers/write-state'

const ACCOUNT = accountKey('runner@example.test', 'cn')
const TIMEZONE = 'Asia/Shanghai'
const START = new Date('2026-09-11T09:00:00.000Z')

function freshState(): string {
  return mkdtempSync(join(tmpdir(), 'garmin-confirmation-'))
}

function makeService(stateDirectory: string, writer: jest.Mock, clock?: { now: Date }) {
  const data: Partial<GarminDataClient> = {
    getWorkoutDetail: jest.fn().mockResolvedValue({ workoutName: 'Easy run' }),
    scheduleWorkout: writer,
    unscheduleWorkout: jest.fn().mockResolvedValue(undefined),
    addWorkout: jest.fn().mockResolvedValue({ workoutId: 'created-1' }),
  }
  const service = new GarminToolService(data as GarminDataClient, {
    activityDetail: 'compact',
    fitDownloadDir: '',
    accountUsername: 'runner@example.test',
    accountRegion: 'cn',
    stateDirectory,
    // Explicit precondition: the account can read its calendar and the day is
    // empty. A missing read capability would refuse the write instead.
    calendarReader: new FakeCalendar(),
    ...(clock ? { now: () => clock.now } : {}),
  })
  return { data, service }
}

/** Two independent service instances sharing one state directory. */
function makeInstances(stateDirectory: string, writer: jest.Mock) {
  const first = makeService(stateDirectory, writer)
  const second = makeService(stateDirectory, writer)
  return { first: first.service, second: second.service }
}

function confirmationIdOf(result: unknown): string {
  const id = (result as { confirmationId?: unknown }).confirmationId
  if (typeof id !== 'string') throw new Error('preview did not issue a confirmationId')
  return id
}

const KEY_REQUEST = {
  workoutId: 'w1', date: '2026-09-20', timezone: TIMEZONE, idempotencyKey: 'key-1',
}

describe('F3: re-previewing a never-confirmed step under the same key', () => {
  it('reuses the operation, advances the revision and disables the old handle', async () => {
    const state = freshState()
    const writer = jest.fn().mockResolvedValue({ workoutScheduleId: 'sid-1' })
    const { service } = makeService(state, writer)

    const first = await service.scheduleWorkout(KEY_REQUEST as never)
    expect(first).toMatchObject({ requiresConfirmation: true, operationId: expect.any(String) })

    // The user never confirmed. A second preview with the same payload/key must
    // re-issue a confirmation rather than declaring the target blocked.
    const second = await service.scheduleWorkout(KEY_REQUEST as never)
    expect(second).toMatchObject({ requiresConfirmation: true })
    expect((second as { operationId: string }).operationId)
      .toBe((first as { operationId: string }).operationId)
    expect(confirmationIdOf(second)).not.toBe(confirmationIdOf(first))

    // The superseded handle must be refused, and refusing must not dispatch.
    await expect(service.scheduleWorkout({
      ...KEY_REQUEST, confirmed: true, confirmationId: confirmationIdOf(first),
    } as never)).rejects.toMatchObject({ code: 'CONFIRMATION_STALE' })
    expect(writer).not.toHaveBeenCalled()

    // The fresh handle works, exactly once.
    const result = await service.scheduleWorkout({
      ...KEY_REQUEST, confirmed: true, confirmationId: confirmationIdOf(second),
    } as never)
    expect(result).toMatchObject({ success: true, status: 'succeeded' })
    expect(writer).toHaveBeenCalledTimes(1)
  })

  it('holds across service instances, and across a restart after the write', async () => {
    const state = freshState()
    const writer = jest.fn().mockResolvedValue({ workoutScheduleId: 'sid-2' })
    const { first, second } = makeInstances(state, writer)

    const preview = await first.scheduleWorkout(KEY_REQUEST as never)
    const stale = confirmationIdOf(preview)

    // A different process re-previews the same key: same operation, new handle.
    const reissued = await second.scheduleWorkout(KEY_REQUEST as never)
    expect((reissued as { operationId: string }).operationId)
      .toBe((preview as { operationId: string }).operationId)
    expect(confirmationIdOf(reissued)).not.toBe(stale)

    await expect(second.scheduleWorkout({
      ...KEY_REQUEST, confirmed: true, confirmationId: stale,
    } as never)).rejects.toMatchObject({ code: 'CONFIRMATION_STALE' })

    const confirmed = await first.scheduleWorkout({
      ...KEY_REQUEST, confirmed: true, confirmationId: confirmationIdOf(reissued),
    } as never)
    expect(confirmed).toMatchObject({ success: true, status: 'succeeded' })
    expect(writer).toHaveBeenCalledTimes(1)

    // A third instance must read the durable receipt rather than re-dispatch.
    const third = makeService(state, writer).service
    const replay = await third.scheduleWorkout({
      ...KEY_REQUEST, confirmed: true, confirmationId: confirmationIdOf(reissued),
    } as never)
    expect(replay).toMatchObject({ success: true, status: 'succeeded' })
    expect(writer).toHaveBeenCalledTimes(1)
  })

  it('refuses a confirmation that names an operation the journal does not hold', async () => {
    const state = freshState()
    const writer = jest.fn()
    const { service } = makeService(state, writer)
    await expect(service.scheduleWorkout({
      ...KEY_REQUEST, confirmed: true, confirmationId: 'does-not-exist:0',
    } as never)).rejects.toMatchObject({ code: 'OPERATION_NOT_FOUND' })
    expect(writer).not.toHaveBeenCalled()
  })
})

describe('confirmation expiry', () => {
  it('refuses to dispatch an expired revision, then a re-preview restores it', async () => {
    const state = freshState()
    const writer = jest.fn().mockResolvedValue({ workoutScheduleId: 'sid-3' })
    const clock = { now: START }
    const { service } = makeService(state, writer, clock)

    const preview = await service.scheduleWorkout(KEY_REQUEST as never)
    const handle = confirmationIdOf(preview)

    // Past the 10 minute authorization window.
    clock.now = new Date(START.getTime() + 11 * 60 * 1000)

    const expired = await service.scheduleWorkout({
      ...KEY_REQUEST, confirmed: true, confirmationId: handle,
    } as never)
    expect(expired).toMatchObject({ status: 'not_attempted', errorCode: 'CONFIRMATION_STALE' })
    expect(writer).not.toHaveBeenCalled()

    // Re-previewing under the same key issues a live handle, and the target is
    // still writable: expiry must not have poisoned the step.
    const refreshed = await service.scheduleWorkout(KEY_REQUEST as never)
    expect(refreshed).toMatchObject({ requiresConfirmation: true })
    const done = await service.scheduleWorkout({
      ...KEY_REQUEST, confirmed: true, confirmationId: confirmationIdOf(refreshed),
    } as never)
    expect(done).toMatchObject({ success: true, status: 'succeeded' })
    expect(writer).toHaveBeenCalledTimes(1)
  })

  it('keeps returning the durable receipt for a step that already succeeded', async () => {
    const state = freshState()
    const writer = jest.fn().mockResolvedValue({ workoutScheduleId: 'sid-4' })
    const clock = { now: START }
    const { service } = makeService(state, writer, clock)

    const preview = await service.scheduleWorkout(KEY_REQUEST as never)
    const handle = confirmationIdOf(preview)
    await service.scheduleWorkout({
      ...KEY_REQUEST, confirmed: true, confirmationId: handle,
    } as never)

    clock.now = new Date(START.getTime() + 60 * 60 * 1000)
    const replay = await service.scheduleWorkout({
      ...KEY_REQUEST, confirmed: true, confirmationId: handle,
    } as never)
    expect(replay).toMatchObject({ success: true, status: 'succeeded' })
    expect(writer).toHaveBeenCalledTimes(1)
  })
})

describe('immutability of an existing key', () => {
  it('conflicts when the same key is used with a different payload', async () => {
    const state = freshState()
    const writer = jest.fn().mockResolvedValue({ workoutScheduleId: 'sid-5' })
    const { service } = makeService(state, writer)

    const first = await service.scheduleWorkout({
      workoutId: 'w1', date: '2026-09-21', timezone: TIMEZONE, idempotencyKey: 'key-2',
    } as never)
    expect(first).toMatchObject({ requiresConfirmation: true })

    await expect(service.scheduleWorkout({
      workoutId: 'w1', date: '2026-09-22', timezone: TIMEZONE, idempotencyKey: 'key-2',
    } as never)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
  })

  it('a new key does not rewrite the first key\'s request, steps or binding', async () => {
    const state = freshState()
    const writer = jest.fn().mockResolvedValue({ workoutScheduleId: 'sid-6' })
    const { service } = makeService(state, writer)

    const firstPreview = await service.scheduleWorkout({
      workoutId: 'w1', date: '2026-09-21', timezone: TIMEZONE, idempotencyKey: 'key-a',
    } as never)
    const firstOperationId = (firstPreview as { operationId: string }).operationId

    // A different key for a *different* target: a new operation, untouched.
    const secondPreview = await service.scheduleWorkout({
      workoutId: 'w2', date: '2026-09-23', timezone: TIMEZONE, idempotencyKey: 'key-b',
    } as never)
    expect((secondPreview as { operationId: string }).operationId).not.toBe(firstOperationId)

    const document = readOperationDocument(state, ACCOUNT)
    const first = document.operations[firstOperationId]
    const second = document.operations[
      (secondPreview as { operationId: string }).operationId
    ]

    expect(first.request).toEqual({
      operation: 'schedule', workoutId: 'w1', date: '2026-09-21', timezone: TIMEZONE,
    })
    expect(second.request).toEqual({
      operation: 'schedule', workoutId: 'w2', date: '2026-09-23', timezone: TIMEZONE,
    })
    expect(first.requestHash).toBe(requestHash(first.request))
    expect(second.requestHash).toBe(requestHash(second.request))
    expect(first.idempotencyKeyHash).toBe(idempotencyKeyHash(ACCOUNT, 'key-a'))
    expect(second.idempotencyKeyHash).toBe(idempotencyKeyHash(ACCOUNT, 'key-b'))
    expect(document.idempotencyIndex[
      idempotencyKeyHash(ACCOUNT, 'key-a')
    ]).toBe(firstOperationId)
    // Distinct targets never share steps, so one can never authorize the other.
    expect(first.steps.map(step => step.businessKey))
      .not.toEqual(second.steps.map(step => step.businessKey))
  })

  it('a new batch key neither rewrites nor adopts an existing operation\'s steps', async () => {
    const state = freshState()
    const writer = jest.fn().mockResolvedValue({ workoutScheduleId: 'sid-7' })
    const { service } = makeService(state, writer)

    const single = await service.scheduleWorkout({
      workoutId: 'w1', date: '2026-09-21', timezone: TIMEZONE, idempotencyKey: 'key-single',
    } as never)
    const singleId = (single as { operationId: string }).operationId

    const batch = await service.batchScheduleWorkouts({
      timezone: TIMEZONE,
      schedules: [
        { workoutId: 'w1', date: '2026-09-21' },
        { workoutId: 'w2', date: '2026-09-22' },
      ],
      idempotencyKey: 'key-batch',
    } as never)
    const batchId = (batch as { operationId?: string }).operationId
    expect(batchId).toBeDefined()
    expect(batchId).not.toBe(singleId)

    const document = readOperationDocument(state, ACCOUNT)
    // The original operation keeps exactly its own single step: a later
    // preview may never grow or shrink an earlier operation's step set.
    expect(document.operations[singleId].steps).toHaveLength(1)
    expect(document.operations[singleId].request).toMatchObject({ workoutId: 'w1' })
    expect(document.operations[singleId].steps[0]).toMatchObject({
      workoutId: 'w1', date: '2026-09-21',
    })
    // Ownership of the overlapping business key moves explicitly: the older
    // never-dispatched step is superseded, so the stale single-key preview can
    // no longer dispatch the same workout and date as the batch.
    const [singleStep] = document.operations[singleId].steps
    const batchSteps = document.operations[batchId as string].steps
    const overlapping = batchSteps.filter(step => step.businessKey === singleStep.businessKey)
    expect(overlapping).toHaveLength(1)
    expect(singleStep.status).toBe('not_attempted')
    expect(singleStep.errorCode).toBe('CONFIRMATION_STALE')
    expect(overlapping[0].status).toBe('prepared')

    // Confirming the stale single-key handle cannot dispatch: the superseded
    // step reports its stale binding instead of sending a request, and the
    // writer is never invoked for it.
    const stale = await service.scheduleWorkout({
      workoutId: 'w1', date: '2026-09-21', timezone: TIMEZONE,
      idempotencyKey: 'key-single', confirmed: true,
      confirmationId: confirmationIdOf(single),
    } as never)
    expect(stale).toMatchObject({
      success: false,
      status: 'not_attempted',
      errorCode: 'CONFIRMATION_STALE',
    })
    expect(writer).not.toHaveBeenCalled()

    // And the superseded key cannot be re-armed while the batch owns it.
    const rePreview = await service.scheduleWorkout({
      workoutId: 'w1', date: '2026-09-21', timezone: TIMEZONE, idempotencyKey: 'key-single',
    } as never)
    expect(rePreview).toMatchObject({ requiresConfirmation: false })
    expect(writer).not.toHaveBeenCalled()

    // The batch itself is dispensable exactly once.
    await service.batchScheduleWorkouts({
      timezone: TIMEZONE,
      schedules: [
        { workoutId: 'w1', date: '2026-09-21' },
        { workoutId: 'w2', date: '2026-09-22' },
      ],
      idempotencyKey: 'key-batch', confirmed: true,
      confirmationId: confirmationIdOf(batch),
    } as never)
    expect(writer).toHaveBeenCalledTimes(2)
  })
})

describe('F5: the persisted document holds only the key hash', () => {
  it('never writes the plaintext key, and recomputes the canonical request hash', async () => {
    const state = freshState()
    const writer = jest.fn().mockResolvedValue({ workoutScheduleId: 'sid-8' })
    const { service } = makeService(state, writer)

    const request = {
      workoutId: 'w3', date: '2026-09-25', timezone: TIMEZONE,
      idempotencyKey: 'leaked-key', confirmed: false,
    }
    const preview = await service.scheduleWorkout(request as never)
    await service.scheduleWorkout({
      ...request, confirmed: true, confirmationId: confirmationIdOf(preview),
    } as never)

    const document = readOperationDocument(state, ACCOUNT)
    const serialized = JSON.stringify(document)
    expect(serialized).not.toContain('leaked-key')
    expect(serialized).not.toContain('confirmationId')
    expect(document.idempotencyIndex[idempotencyKeyHash(ACCOUNT, 'leaked-key')]).toBeDefined()

    const operation = document.operations[
      document.idempotencyIndex[idempotencyKeyHash(ACCOUNT, 'leaked-key')]
    ]
    // The hash is over the business request only, so it is reproducible from
    // the request a caller would send again.
    expect(operation.requestHash).toBe(requestHash(operation.request))
    expect(operation.request).not.toHaveProperty('idempotencyKey')
    expect(operation.request).not.toHaveProperty('confirmed')
  })

  it('an unschedule key is hashed the same way, and its schedule id stays readable', async () => {
    const state = freshState()
    const writer = jest.fn().mockResolvedValue(undefined)
    const { service } = makeService(state, writer)

    const preview = await service.unscheduleWorkout({
      workoutScheduleId: 'sched-42', idempotencyKey: 'unschedule-secret',
    } as never)
    await service.unscheduleWorkout({
      workoutScheduleId: 'sched-42',
      confirmed: true,
      confirmationId: confirmationIdOf(preview),
    } as never)

    const document = readOperationDocument(state, ACCOUNT)
    expect(JSON.stringify(document)).not.toContain('unschedule-secret')
    const operationId = document.idempotencyIndex[
      idempotencyKeyHash(ACCOUNT, 'unschedule-secret')
    ]
    expect(operationId).toBeDefined()
    expect(document.operations[operationId].steps[0]).toMatchObject({
      workoutScheduleId: 'sched-42',
      status: 'succeeded',
    })
  })
})

/**
 * A preview is not a write, so the journal — not a process-local flag — decides
 * whether a target may be armed again. These cases pin the exact boundary:
 * proven-not-sent work is re-armable, and uncertain or satisfied work is not.
 */
describe('re-arming is decided by the journal, not by a terminal status', () => {
  it('re-arms a step that failed with a proven not_applied error, keeping its attempt record', async () => {
    const state = freshState()
    const writer = jest
      .fn()
      .mockRejectedValueOnce(new GarminWriteTransportError(
        'not_applied', 'WRITE_NOT_APPLIED', 'Garmin rejected the request without applying it',
      ))
      .mockResolvedValue({ workoutScheduleId: 'sid-retry' })
    const { service } = makeService(state, writer)

    const request = {
      workoutId: 'w9', date: '2026-09-28', timezone: TIMEZONE, idempotencyKey: 'key-retry',
    }
    const preview = await service.scheduleWorkout(request as never)
    const first = await service.scheduleWorkout({
      ...request, confirmed: true, confirmationId: confirmationIdOf(preview),
    } as never)
    expect(first).toMatchObject({ success: false, status: 'failed' })
    expect(writer).toHaveBeenCalledTimes(1)

    // The failure is proven not applied, so the same key may be previewed again
    // and yields a *new* confirmation — the target is not wedged forever.
    const refreshed = await service.scheduleWorkout(request as never)
    expect(refreshed).toMatchObject({ requiresConfirmation: true })
    expect((refreshed as { operationId: string }).operationId)
      .toBe((preview as { operationId: string }).operationId)
    expect(confirmationIdOf(refreshed)).not.toBe(confirmationIdOf(preview))

    const retry = await service.scheduleWorkout({
      ...request, confirmed: true, confirmationId: confirmationIdOf(refreshed),
    } as never)
    expect(retry).toMatchObject({ success: true, status: 'succeeded' })
    expect(writer).toHaveBeenCalledTimes(2)

    const document = readOperationDocument(state, ACCOUNT)
    const operation = document.operations[(preview as { operationId: string }).operationId]
    // One step, one operationId, and the whole attempt history is preserved.
    expect(operation.steps).toHaveLength(1)
    expect(operation.steps[0].attempt).toBe(2)
    expect(operation.steps[0].attempts.map(a => a.outcome)).toEqual(['failed', 'succeeded'])
  })

  it('never re-arms an unknown step, even under the same key', async () => {
    const state = freshState()
    const writer = jest.fn().mockRejectedValue(new Error('socket hang up'))
    const { service } = makeService(state, writer)

    const request = {
      workoutId: 'w10', date: '2026-09-29', timezone: TIMEZONE, idempotencyKey: 'key-unknown',
    }
    const preview = await service.scheduleWorkout(request as never)
    const result = await service.scheduleWorkout({
      ...request, confirmed: true, confirmationId: confirmationIdOf(preview),
    } as never)
    expect(result).toMatchObject({ success: false, status: 'unknown', manualReviewRequired: true })
    expect(writer).toHaveBeenCalledTimes(1)

    const again = await service.scheduleWorkout(request as never)
    expect(again).toMatchObject({ requiresConfirmation: false })
    await expect(service.scheduleWorkout({
      ...request, confirmed: true, confirmationId: confirmationIdOf(preview),
    } as never)).resolves.toMatchObject({ status: 'unknown', success: false })
    // Same key, unresolved outcome: no new dispatch authority is minted.
    expect(writer).toHaveBeenCalledTimes(1)

    const document = readOperationDocument(state, ACCOUNT)
    expect(document.operations[(preview as { operationId: string }).operationId].steps[0].status)
      .toBe('unknown')
  })

  it('re-arms only the entries a halted batch never sent, and never re-sends the unknown one', async () => {
    const state = freshState()
    const writer = jest
      .fn()
      // A credential that stops being accepted mid-batch: the request for A was
      // already dispatched, so A is `unknown`, and the account-level failure
      // stops the batch before B is ever sent.
      .mockImplementationOnce(async () => {
        throw new GarminWriteTransportError(
          'unknown', 'WRITE_AUTH_EXPIRED', 'Garmin stopped accepting this credential',
        )
      })
      .mockImplementationOnce(async () => ({ workoutScheduleId: 'sid-B' }))
    const { service } = makeService(state, writer)

    const batch = {
      timezone: TIMEZONE,
      schedules: [
        { workoutId: 'A', date: '2026-09-30' },
        { workoutId: 'B', date: '2026-10-01' },
      ],
      idempotencyKey: 'key-halt',
    }
    const preview = await service.batchScheduleWorkouts(batch as never)
    const first = await service.batchScheduleWorkouts({
      ...batch, confirmed: true, confirmationId: confirmationIdOf(preview),
    } as never) as { results: Array<{ workoutId: string; status: string }> }
    expect(first.results.map(r => r.status)).toEqual(['unknown', 'not_attempted'])
    expect(writer).toHaveBeenCalledTimes(1)

    const refreshed = await service.batchScheduleWorkouts(batch as never)
    expect(refreshed).toMatchObject({ requiresConfirmation: true })
    expect (confirmationIdOf(refreshed)).not.toBe(confirmationIdOf(preview))

    const second = await service.batchScheduleWorkouts({
      ...batch, confirmed: true, confirmationId: confirmationIdOf(refreshed),
    } as never) as { results: Array<{ workoutId: string; status: string }> }
    expect(second.results).toEqual([
      expect.objectContaining({ workoutId: 'A', status: 'unknown' }),
      expect.objectContaining({ workoutId: 'B', status: 'succeeded' }),
    ])
    // Exactly one new POST — for B. A is never re-sent.
    expect(writer).toHaveBeenCalledTimes(2)
    expect(writer).toHaveBeenNthCalledWith(2, 'B', '2026-10-01')

    const document = readOperationDocument(state, ACCOUNT)
    const operation = document.operations[(preview as { operationId: string }).operationId]
    const statuses = Object.fromEntries(operation.steps.map(step => [step.workoutId, step.status]))
    expect(statuses).toEqual({ A: 'unknown', B: 'succeeded' })
  })
})

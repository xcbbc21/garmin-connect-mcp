import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GarminToolService, type GarminDataClient } from '../src/tool-service'
import { WriteCoordinator, previewRevisionOf } from '../src/write-operations/coordinator'
import { GarminWriteError, WRITE_ERROR_CODES } from '../src/write-operations/errors'
import { accountKey, decodeConfirmationId, requestHash } from '../src/write-operations/identity'
import { FileAccountLock } from '../src/write-operations/lock'
import { type OperationStore } from '../src/write-operations/store'
import { emptyOperationDocument, type OperationDocument } from '../src/write-operations/types'

const ACCOUNT = accountKey('runner@example.test', 'cn')
const TIMEZONE = 'Asia/Shanghai'

function freshState(): string {
  return mkdtempSync(join(tmpdir(), 'garmin-coordinator-'))
}

function makeService(stateDirectory: string, writer: jest.Mock) {
  const data = {
    getWorkoutDetail: jest.fn().mockResolvedValue({ workoutName: 'Easy run' }),
    scheduleWorkout: writer,
    unscheduleWorkout: jest.fn().mockResolvedValue(undefined),
    addWorkout: jest.fn().mockResolvedValue({ workoutId: 'created-1' }),
  }
  const service = new GarminToolService(data as unknown as GarminDataClient, {
    activityDetail: 'compact',
    fitDownloadDir: '',
    accountUsername: 'runner@example.test',
    accountRegion: 'cn',
    stateDirectory,
  })
  return { data, service }
}

async function confirm(service: GarminToolService, request: Record<string, unknown>) {
  const preview = await service.scheduleWorkout(request as never)
  return {
    preview,
    result: await service.scheduleWorkout({
      ...request,
      confirmed: true,
      confirmationId: preview.confirmationId,
    } as never),
  }
}

describe('write protection: no bypass through previews, keys, restarts or concurrency', () => {
  it('a brand-new preview cannot bypass an existing unknown write', async () => {
    const state = freshState()
    const writer = jest.fn().mockRejectedValue(new Error('socket hang up'))
    const { service } = makeService(state, writer)
    const request = { workoutId: 'w1', date: '2026-09-20', timezone: TIMEZONE }

    const { result } = await confirm(service, request)
    expect(result).toMatchObject({
      success: false,
      status: 'unknown',
      manualReviewRequired: true,
      errorCode: 'WRITE_OUTCOME_UNKNOWN',
      operationId: expect.any(String),
    })
    expect(writer).toHaveBeenCalledTimes(1)

    const second = await service.scheduleWorkout(request as never)
    expect(second).toMatchObject({
      requiresConfirmation: false,
      action: 'blocked',
      status: 'unknown',
      success: false,
    })
    expect(second).not.toHaveProperty('confirmationId')
    expect(writer).toHaveBeenCalledTimes(1)
  })

  it('a different idempotency key cannot bypass an existing unknown write', async () => {
    const state = freshState()
    const writer = jest.fn().mockRejectedValue(new Error('timed out'))
    const { service } = makeService(state, writer)
    const request = { workoutId: 'w2', date: '2026-09-21', timezone: TIMEZONE, idempotencyKey: 'week-1' }

    await confirm(service, request)
    expect(writer).toHaveBeenCalledTimes(1)

    const withNewKey = await service.scheduleWorkout({
      workoutId: 'w2', date: '2026-09-21', timezone: TIMEZONE, idempotencyKey: 'week-2',
    } as never)
    expect(withNewKey).toMatchObject({ requiresConfirmation: false, action: 'blocked', status: 'unknown' })
    expect(writer).toHaveBeenCalledTimes(1)
  })

  it('a restarted process cannot bypass an existing unknown write', async () => {
    const state = freshState()
    const writer = jest.fn().mockRejectedValue(new Error('timed out'))
    const first = makeService(state, writer)
    const request = { workoutId: 'w3', date: '2026-09-22', timezone: TIMEZONE }
    await confirm(first.service, request)
    expect(writer).toHaveBeenCalledTimes(1)

    // Entirely new service, store and lock objects reading the same journal.
    const restarted = makeService(state, writer)
    const preview = await restarted.service.scheduleWorkout(request as never)
    expect(preview).toMatchObject({ requiresConfirmation: false, action: 'blocked', status: 'unknown' })
    expect(writer).toHaveBeenCalledTimes(1)
  })

  it('concurrent confirmations cannot double-write the same workout and date', async () => {
    const state = freshState()
    const writer = jest.fn().mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 40))
      return { workoutScheduleId: 's-concurrent' }
    })
    const a = makeService(state, writer)
    const b = makeService(state, writer)
    const request = { workoutId: 'w4', date: '2026-09-23', timezone: TIMEZONE }

    // Both callers preview the same workout/date. They share one journal
    // operation for that business key and the second preview advances its
    // revision, so only the newest handle stays executable.
    const previewA = await a.service.scheduleWorkout(request as never)
    const previewB = await b.service.scheduleWorkout(request as never)
    expect(previewA.requiresConfirmation).toBe(true)
    expect(previewB.requiresConfirmation).toBe(true)
    expect(previewA.operationId).toBe(previewB.operationId)

    const handleA = decodeConfirmationId(previewA.confirmationId)
    const handleB = decodeConfirmationId(previewB.confirmationId)
    expect(handleA).toBeDefined()
    expect(handleB?.previewRevision).toBe((handleA?.previewRevision ?? 0) + 1)

    // Both confirm at the same moment from two independent service instances.
    // The superseded handle is refused before anything is sent; the newest one
    // dispatches. Exactly one POST reaches Garmin.
    const [left, right] = await Promise.allSettled([
      a.service.scheduleWorkout({
        ...request, confirmed: true, confirmationId: previewA.confirmationId,
      } as never),
      b.service.scheduleWorkout({
        ...request, confirmed: true, confirmationId: previewB.confirmationId,
      } as never),
    ])

    expect(left.status).toBe('rejected')
    expect((left as PromiseRejectedResult).reason).toMatchObject({
      code: WRITE_ERROR_CODES.CONFIRMATION_STALE,
    })
    expect(right.status).toBe('fulfilled')
    expect((right as PromiseFulfilledResult<Record<string, unknown>>).value).toMatchObject({
      success: true,
      desiredStateSatisfied: true,
    })
    expect(writer).toHaveBeenCalledTimes(1)

    // The superseded caller is not left blind: re-previewing the same target
    // reports it as already satisfied rather than offering a second write.
    const afterA = await a.service.scheduleWorkout(request as never)
    expect(afterA).toMatchObject({ requiresConfirmation: false, action: 'skip_existing', success: true })
    expect(writer).toHaveBeenCalledTimes(1)
  })
})

describe('journal semantics', () => {
  it('binds one idempotency key to one request and conflicts on a different one', async () => {
    const state = freshState()
    const writer = jest.fn().mockResolvedValue({ workoutScheduleId: 's1' })
    const { service } = makeService(state, writer)

    await confirm(service, { workoutId: 'w5', date: '2026-09-24', timezone: TIMEZONE, idempotencyKey: 'k1' })
    expect(writer).toHaveBeenCalledTimes(1)

    // Same key, same request: durable receipt, no second write.
    const replay = await service.scheduleWorkout({
      workoutId: 'w5', date: '2026-09-24', timezone: TIMEZONE, idempotencyKey: 'k1',
    } as never)
    expect(replay).toMatchObject({ requiresConfirmation: false, action: 'skip_existing', status: 'succeeded' })
    expect(writer).toHaveBeenCalledTimes(1)

    // Same key, different request: conflict, no write.
    await expect(service.scheduleWorkout({
      workoutId: 'w5', date: '2026-09-25', timezone: TIMEZONE, idempotencyKey: 'k1',
    } as never)).rejects.toMatchObject({ code: WRITE_ERROR_CODES.IDEMPOTENCY_CONFLICT })
    expect(writer).toHaveBeenCalledTimes(1)
  })

  it('skips an already-satisfied target instead of writing again', async () => {
    const state = freshState()
    const writer = jest.fn().mockResolvedValue({ workoutScheduleId: 's2' })
    const { service } = makeService(state, writer)
    const request = { workoutId: 'w6', date: '2026-09-26', timezone: TIMEZONE }

    await confirm(service, request)
    const again = await service.scheduleWorkout(request as never)
    expect(again).toMatchObject({ requiresConfirmation: false, action: 'skip_existing', success: true })
    expect(writer).toHaveBeenCalledTimes(1)
  })

  it('allows the same workout on a different date', async () => {
    const state = freshState()
    const writer = jest.fn().mockResolvedValue({ workoutScheduleId: 's3' })
    const { service } = makeService(state, writer)

    await confirm(service, { workoutId: 'w7', date: '2026-09-27', timezone: TIMEZONE })
    await confirm(service, { workoutId: 'w7', date: '2026-09-28', timezone: TIMEZONE })
    expect(writer).toHaveBeenCalledTimes(2)
  })

  it('rejects an out-of-contract idempotency key before any Garmin access', async () => {
    const state = freshState()
    const writer = jest.fn()
    const { data, service } = makeService(state, writer)
    await expect(service.scheduleWorkout({
      workoutId: 'w8', date: '2026-09-29', timezone: TIMEZONE, idempotencyKey: 'bad key!',
    } as never)).rejects.toMatchObject({ code: WRITE_ERROR_CODES.INVALID_IDEMPOTENCY_KEY })
    expect(data.getWorkoutDetail).not.toHaveBeenCalled()
    expect(writer).not.toHaveBeenCalled()
  })
})

/** Store whose saves can be made to fail at a chosen point. */
class FailingStore implements OperationStore {
  private document: OperationDocument
  saves = 0
  failOnSave = Number.POSITIVE_INFINITY

  constructor(account: string) {
    this.document = emptyOperationDocument(account)
  }

  async read(): Promise<OperationDocument> {
    return JSON.parse(JSON.stringify(this.document)) as OperationDocument
  }

  async save(document: OperationDocument): Promise<void> {
    this.saves += 1
    if (this.saves >= this.failOnSave) {
      throw new GarminWriteError(WRITE_ERROR_CODES.STATE_UNAVAILABLE, 'not_applied', 'injected save failure')
    }
    this.document = JSON.parse(JSON.stringify(document)) as OperationDocument
  }

  snapshot(): OperationDocument {
    return JSON.parse(JSON.stringify(this.document)) as OperationDocument
  }
}

function makeCoordinator(store: OperationStore, writer: { schedule: jest.Mock }) {
  return new WriteCoordinator({
    store,
    lock: new FileAccountLock(freshState(), ACCOUNT),
    accountKey: ACCOUNT,
    writer,
    newOperationId: (() => {
      let n = 0
      return () => `op-${++n}`
    })(),
    newStepId: (() => {
      let n = 0
      return () => `step-${++n}`
    })(),
  })
}

describe('coordinator state machine', () => {
  const request = { operation: 'schedule', workoutId: 'w9', date: '2026-09-30', timezone: TIMEZONE }

  it('persists in_flight before dispatch and sends nothing if that write fails', async () => {
    const store = new FailingStore(ACCOUNT)
    const writer = { schedule: jest.fn().mockResolvedValue({ workoutScheduleId: 'never' }) }
    const coordinator = makeCoordinator(store, writer)

    const preview = await coordinator.previewSchedule({
      kind: 'schedule', timezone: TIMEZONE, request, steps: [{ workoutId: 'w9', date: '2026-09-30' }],
    })
    expect(preview.requiresConfirmation).toBe(true)

    store.failOnSave = store.saves + 1
    const execution = await coordinator.executeSchedule({
      operationId: preview.operationId as string,
      requestHash: requestHash(request),
      previewRevision: previewRevisionOf(preview),
    })
    expect(writer.schedule).not.toHaveBeenCalled()
    // The journal write failed, but the receipt must still carry the
    // operationId: throwing it away would leave the caller with no handle to
    // reconcile. Nothing was dispatched, so the entry is a proven
    // non-application and stays retryable.
    expect(execution.operationId).toBe(preview.operationId)
    expect(execution.receipts).toHaveLength(1)
    expect(execution.receipts[0]).toMatchObject({
      status: 'failed',
      errorCode: WRITE_ERROR_CODES.STATE_UNAVAILABLE,
      success: false,
      desiredStateSatisfied: false,
      manualReviewRequired: false,
    })
    // The step never reached `in_flight` on disk, so it stays `prepared`.
    expect(store.snapshot().operations[preview.operationId as string].steps[0].status).toBe('prepared')
  })

  it('never dispatches a superseded preview', async () => {
    const store = new FailingStore(ACCOUNT)
    const writer = { schedule: jest.fn().mockResolvedValue({ workoutScheduleId: 'x' }) }
    const coordinator = makeCoordinator(store, writer)

    const firstRequest = { ...request }
    const first = await coordinator.previewSchedule({
      kind: 'schedule', timezone: TIMEZONE, request: firstRequest, steps: [{ workoutId: 'w9', date: '2026-09-30' }],
    })

    // A second preview widens the candidate set, superseding the first.
    const widened = { ...request, workoutId: 'w9,w10' }
    const second = await coordinator.previewSchedule({
      kind: 'batch-schedule',
      timezone: TIMEZONE,
      request: widened,
      steps: [
        { workoutId: 'w9', date: '2026-09-30' },
        { workoutId: 'w10', date: '2026-10-01' },
      ],
    })
    expect(second.operationId).not.toBe(first.operationId)
    expect(store.snapshot().operations[first.operationId as string].steps[0].status).toBe('not_attempted')

    // Confirming the superseded preview must not write anything.
    const execution = await coordinator.executeSchedule({
      operationId: first.operationId as string,
      requestHash: requestHash(firstRequest),
      previewRevision: previewRevisionOf(first),
    })
    expect(execution.receipts[0].status).toBe('not_attempted')
    expect(writer.schedule).not.toHaveBeenCalled()
  })
})

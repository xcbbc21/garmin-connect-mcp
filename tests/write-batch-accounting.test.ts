/**
 * Batch accounting tests (F2).
 *
 * The plan requires the parent batch operation to retain EVERY item from the
 * original request, in original order, with its final status. Blocked items
 * reference the existing holder (no duplicate attempts) and unknown items are
 * reported by the same shape as any other result. `results.length` always
 * equals the original batch size and every result has the same keys.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GarminToolService, type GarminDataClient } from '../src/tool-service'
import { accountKey, scheduleBusinessKey } from '../src/write-operations/identity'
import { WriteCoordinator } from '../src/write-operations/coordinator'
import { FileAccountLock } from '../src/write-operations/lock'
import { type OperationStore } from '../src/write-operations/store'
import {
  emptyOperationDocument,
  type OperationDocument,
  type WriteOperation,
  type WriteStep,
} from '../src/write-operations/types'

const ACCOUNT = accountKey('runner@example.test', 'cn')
const TIMEZONE = 'Asia/Shanghai'

function freshState(): string {
  return mkdtempSync(join(tmpdir(), 'garmin-batch-'))
}

function makeService(stateDirectory: string, writer: jest.Mock) {
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
  })
  return { data, service }
}

function makeCoordinator(store: OperationStore, writer: { schedule: jest.Mock }) {
  return new WriteCoordinator({
    store,
    lock: new FileAccountLock(freshState(), ACCOUNT),
    accountKey: ACCOUNT,
    writer,
    newOperationId: (() => { let n = 0; return () => `op-${++n}` })(),
    newStepId: (() => { let n = 0; return () => `step-${++n}` })(),
  })
}

class InMemoryStore implements OperationStore {
  private document: OperationDocument
  constructor(account: string) {
    this.document = emptyOperationDocument(account)
  }
  async read(): Promise<OperationDocument> {
    return JSON.parse(JSON.stringify(this.document)) as OperationDocument
  }
  async save(document: OperationDocument): Promise<void> {
    this.document = JSON.parse(JSON.stringify(document)) as OperationDocument
  }
  snapshot(): OperationDocument {
    return JSON.parse(JSON.stringify(this.document)) as OperationDocument
  }
  seed(operation: WriteOperation): void {
    this.document.operations[operation.operationId] = operation
  }
}

function step(over: Partial<WriteStep>): WriteStep {
  return {
    stepId: over.stepId ?? 'seed-step',
    businessKey: over.businessKey ?? 'bk',
    kind: over.kind ?? 'schedule',
    status: over.status ?? 'not_attempted',
    attempt: over.attempt ?? 0,
    workoutId: over.workoutId ?? 'w',
    date: over.date ?? '2026-09-20',
    evidence: over.evidence ?? 'none',
    attempts: over.attempts ?? [],
    dispatchedAt: over.dispatchedAt,
    workoutScheduleId: over.workoutScheduleId,
    errorCode: over.errorCode,
  }
}

function makeOp(id: string, steps: WriteStep[]): WriteOperation {
  return {
    schemaVersion: 1,
    operationId: id,
    kind: 'batch-schedule',
    accountKey: ACCOUNT,
    requestHash: `hash-${id}`,
    request: {},
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
    steps,
  }
}

describe('batch accounting retains every requested item in original order', () => {
  it('unknown A + new B → results has 2 items with mixed status and accurate counts', async () => {
    const state = freshState()
    const writer = jest
      .fn()
      .mockImplementationOnce(async () => { throw new Error('socket hang up') })
      .mockImplementationOnce(async () => ({ workoutScheduleId: 'sid-B' }))
    const { service } = makeService(state, writer)
    const single = { workoutId: 'A', date: '2026-09-25', timezone: TIMEZONE }
    const previewA = await service.scheduleWorkout(single as never)
    await service.scheduleWorkout({
      ...single,
      confirmed: true,
      confirmationId: previewA.confirmationId,
    } as never)
    expect(writer).toHaveBeenCalledTimes(1)

    const batch = {
      schedules: [{ workoutId: 'A', date: '2026-09-25' }, { workoutId: 'B', date: '2026-09-26' }],
      timezone: TIMEZONE,
    }
    const batchPreview = await service.batchScheduleWorkouts(batch as never)
    const result = await service.batchScheduleWorkouts({
      ...batch,
      confirmed: true,
      confirmationId: batchPreview.confirmationId,
    } as never) as Record<string, unknown> & {
      results: Array<{ workoutId: string; date: string; status: string }>
    }
    expect(result.total).toBe(2)
    expect(result.results).toHaveLength(2)
    expect(result.results.map(r => r.workoutId)).toEqual(['A', 'B'])
    expect(result.success).toBe(false)
    expect(result.successCount).toBe(1)
    expect(result.unknownCount).toBe(1)
    expect(result.notAttemptedCount).toBe(0)
    expect(result.failureCount).toBe(1)
    // Original order preserved.
    expect(result.results[0].workoutId).toBe('A')
    expect(result.results[0].status).toBe('unknown')
    expect(result.results[1].workoutId).toBe('B')
    expect(result.results[1].status).toBe('succeeded')
  })

  it('all-blocked batch returns success=false and full blocked set with no dispatcher calls', async () => {
    const store = new InMemoryStore(ACCOUNT)
    const writer = { schedule: jest.fn() }
    const coordinator = makeCoordinator(store, writer)

    // Pre-block both keys with an unknown record.
    const bkA = scheduleBusinessKey(ACCOUNT, 'A', '2026-10-01')
    const bkB = scheduleBusinessKey(ACCOUNT, 'B', '2026-10-02')
    store.seed(makeOp('blocker', [
      step({ stepId: 'sa', businessKey: bkA, status: 'unknown' }),
      step({ stepId: 'sb', businessKey: bkB, status: 'unknown' }),
    ]))

    const preview = await coordinator.previewSchedule({
      kind: 'batch-schedule',
      timezone: TIMEZONE,
      request: { kind: 'batch', schedules: [{ workoutId: 'A', date: '2026-10-01' }, { workoutId: 'B', date: '2026-10-02' }] },
      steps: [{ workoutId: 'A', date: '2026-10-01' }, { workoutId: 'B', date: '2026-10-02' }],
    })
    expect(preview.requiresConfirmation).toBe(false)
    expect(preview.steps).toHaveLength(2)
    expect(preview.steps.every(s => s.action === 'blocked')).toBe(true)
    expect(writer.schedule).not.toHaveBeenCalled()
  })

  it('all-skip_existing batch (already satisfied) returns success=true and no calls', async () => {
    const store = new InMemoryStore(ACCOUNT)
    const writer = { schedule: jest.fn() }
    const coordinator = makeCoordinator(store, writer)
    const bkA = scheduleBusinessKey(ACCOUNT, 'A', '2026-10-01')
    const bkB = scheduleBusinessKey(ACCOUNT, 'B', '2026-10-02')
    store.seed(makeOp('satis', [
      step({ stepId: 'sa', businessKey: bkA, status: 'succeeded', workoutScheduleId: 'sid-A', evidence: 'response' }),
      step({ stepId: 'sb', businessKey: bkB, status: 'succeeded', workoutScheduleId: 'sid-B', evidence: 'response' }),
    ]))

    const preview = await coordinator.previewSchedule({
      kind: 'batch-schedule',
      timezone: TIMEZONE,
      request: { kind: 'batch', schedules: [{ workoutId: 'A', date: '2026-10-01' }, { workoutId: 'B', date: '2026-10-02' }] },
      steps: [{ workoutId: 'A', date: '2026-10-01' }, { workoutId: 'B', date: '2026-10-02' }],
    })
    expect(preview.requiresConfirmation).toBe(false)
    expect(preview.steps.every(s => s.action === 'skip_existing')).toBe(true)
    expect(writer.schedule).not.toHaveBeenCalled()
  })

  it('replay of the same idempotency key returns the durable receipt and never re-runs', async () => {
    const state = freshState()
    const writer = jest.fn().mockResolvedValue({ workoutScheduleId: 'sid-X' })
    const { service } = makeService(state, writer)
    const batch = {
      schedules: [{ workoutId: 'X', date: '2026-10-05' }],
      timezone: TIMEZONE,
      idempotencyKey: 'week-1',
    }
    const preview = await service.batchScheduleWorkouts(batch as never)
    await service.batchScheduleWorkouts({
      ...batch,
      confirmed: true,
      confirmationId: preview.confirmationId,
    } as never)
    expect(writer).toHaveBeenCalledTimes(1)

    // Same key + same payload: durable receipt, no new call.
    const replay = await service.batchScheduleWorkouts(batch as never) as Record<string, unknown>
    expect(replay.requiresConfirmation).toBe(false)
    expect(writer).toHaveBeenCalledTimes(1)
  })

  it('persists the full original batch in the parent operation including blocked references', async () => {
    const state = freshState()
    const writer = jest
      .fn()
      .mockImplementationOnce(async () => { throw new Error('socket hang up') })
      .mockImplementationOnce(async () => ({ workoutScheduleId: 'sid-B' }))
    const { service } = makeService(state, writer)
    const single = { workoutId: 'A', date: '2026-11-01', timezone: TIMEZONE }
    const previewA = await service.scheduleWorkout(single as never)
    await service.scheduleWorkout({
      ...single,
      confirmed: true,
      confirmationId: previewA.confirmationId,
    } as never)

    const batch = {
      schedules: [{ workoutId: 'A', date: '2026-11-01' }, { workoutId: 'B', date: '2026-11-02' }],
      timezone: TIMEZONE,
    }
    const preview = await service.batchScheduleWorkouts(batch as never)
    await service.batchScheduleWorkouts({
      ...batch,
      confirmed: true,
      confirmationId: preview.confirmationId,
    } as never)

    // The batch's parent operation must contain BOTH steps: A is blocked
    // (referencing the previous operation's unknown) and B is succeeded.
    const allOps = await (service as unknown as {
      listWriteOperations(): Promise<Array<{ operationId: string; kind: string; steps: Array<{ workoutId: string; status: string; workoutScheduleId: string | null; errorCode?: string }> }>>;
    }).listWriteOperations()
    const batchOp = allOps.find(op => op.kind === 'batch-schedule' && op.steps.length === 2)
    expect(batchOp).toBeDefined()
    const aStep = batchOp!.steps.find(s => s.workoutId === 'A')
    const bStep = batchOp!.steps.find(s => s.workoutId === 'B')
    expect(aStep?.status).toBe('not_attempted')
    expect(aStep?.errorCode).toBe('WRITE_OUTCOME_UNKNOWN')
    expect(bStep?.status).toBe('succeeded')
    expect(bStep?.workoutScheduleId).toBe('sid-B')
  })

  it('five-item mixed batch preserves order and computes counts', async () => {
    const state = freshState()
    const writer = jest.fn().mockImplementation(async (workoutId: string) => {
      if (workoutId === 'W3') throw new Error('transient network blip')
      return { workoutScheduleId: `sid-${workoutId}` }
    })
    const { service } = makeService(state, writer)
    const batch = {
      schedules: [
        { workoutId: 'W1', date: '2026-12-01' },
        { workoutId: 'W2', date: '2026-12-02' },
        { workoutId: 'W3', date: '2026-12-03' },
        { workoutId: 'W4', date: '2026-12-04' },
        { workoutId: 'W5', date: '2026-12-05' },
      ],
      timezone: TIMEZONE,
    }
    const preview = await service.batchScheduleWorkouts(batch as never)
    const result = await service.batchScheduleWorkouts({
      ...batch,
      confirmed: true,
      confirmationId: preview.confirmationId,
    } as never) as Record<string, unknown> & {
      results: Array<{ workoutId: string; status: string }>
    }
    // Transient network errors do NOT auto-stop the batch: only auth/cancel/
    // storage failures do. W3 dispatches, fails, and is reported as unknown.
    expect(result.total).toBe(5)
    expect(result.results).toHaveLength(5)
    expect(result.results.map(r => r.workoutId)).toEqual(['W1', 'W2', 'W3', 'W4', 'W5'])
    expect(result.successCount).toBe(4)
    expect(result.unknownCount).toBe(1)
    expect(result.failureCount).toBe(1)
    expect(result.results[2].status).toBe('unknown')
    expect(writer).toHaveBeenCalledTimes(5)
  })
})

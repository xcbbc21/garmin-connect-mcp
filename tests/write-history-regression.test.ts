/**
 * History-hiding regression tests.
 *
 * The original coordinator consulted the journal with `findStepByBusinessKey`,
 * which only returned the FIRST step that happened to share a business key. If
 * a stale `not_attempted` or `prepared` record sat in front of a newer
 * `unknown` / `succeeded` one, the stale record could authorize a duplicate
 * dispatch. These tests force that scenario with explicit journal shaping so
 * the fix can be verified end-to-end.
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
  return mkdtempSync(join(tmpdir(), 'garmin-history-'))
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
    workoutId: over.workoutId ?? 'w1',
    date: over.date ?? '2026-09-20',
    evidence: over.evidence ?? 'none',
    attempts: over.attempts ?? [],
    dispatchedAt: over.dispatchedAt,
    workoutScheduleId: over.workoutScheduleId,
    errorCode: over.errorCode,
  }
}

function makeOp(
  id: string,
  steps: WriteStep[],
  extras: Partial<WriteOperation> = {},
): WriteOperation {
  return {
    schemaVersion: 2,
    previewRevision: 0,
    operationId: id,
    kind: 'batch-schedule',
    accountKey: ACCOUNT,
    requestHash: `hash-${id}`,
    request: {},
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
    steps,
    ...extras,
  }
}

describe('history aggregation must hide nothing', () => {
  it('blocks re-dispatch when a stale not_attempted sits in front of a new unknown', async () => {
    const store = new InMemoryStore(ACCOUNT)
    const businessKey = scheduleBusinessKey(ACCOUNT, 'w1', '2026-09-20')
    // Insertion order matters for first-match bugs: stale must come first.
    store.seed(makeOp('old', [step({ stepId: 's-old', businessKey, status: 'not_attempted' })]))
    store.seed(makeOp('new', [step({ stepId: 's-new', businessKey, status: 'unknown', errorCode: 'WRITE_OUTCOME_UNKNOWN' })]))
    const writer = { schedule: jest.fn() }
    const coordinator = makeCoordinator(store, writer)

    const preview = await coordinator.previewSchedule({
      kind: 'schedule',
      timezone: TIMEZONE,
      request: { workoutId: 'w1', date: '2026-09-20', timezone: TIMEZONE },
      steps: [{ workoutId: 'w1', date: '2026-09-20' }],
    })

    expect(preview.requiresConfirmation).toBe(false)
    expect(preview.steps[0].action).toBe('blocked')
    expect(preview.steps[0].status).toBe('unknown')
    expect(preview.steps[0].operationId).toBe('new')
    expect(writer.schedule).not.toHaveBeenCalled()
  })

  it('returns skip_existing when a stale not_attempted sits in front of a new succeeded', async () => {
    const store = new InMemoryStore(ACCOUNT)
    const businessKey = scheduleBusinessKey(ACCOUNT, 'w2', '2026-09-21')
    store.seed(makeOp('old', [step({ stepId: 's-old', businessKey, status: 'not_attempted' })]))
    store.seed(makeOp('new', [step({
      stepId: 's-new',
      businessKey,
      status: 'succeeded',
      evidence: 'response',
      workoutScheduleId: 'sid-2',
    })]))
    const writer = { schedule: jest.fn() }
    const coordinator = makeCoordinator(store, writer)

    const preview = await coordinator.previewSchedule({
      kind: 'schedule',
      timezone: TIMEZONE,
      request: { workoutId: 'w2', date: '2026-09-21', timezone: TIMEZONE },
      steps: [{ workoutId: 'w2', date: '2026-09-21' }],
    })

    expect(preview.requiresConfirmation).toBe(false)
    expect(preview.steps[0].action).toBe('skip_existing')
    expect(preview.steps[0].workoutScheduleId).toBe('sid-2')
    expect(preview.steps[0].operationId).toBe('new')
    expect(writer.schedule).not.toHaveBeenCalled()
  })

  it('blocks when a stale prepared sits in front of a new in_flight', async () => {
    const store = new InMemoryStore(ACCOUNT)
    const businessKey = scheduleBusinessKey(ACCOUNT, 'w3', '2026-09-22')
    store.seed(makeOp('old', [step({ stepId: 's-old', businessKey, status: 'prepared' })]))
    store.seed(makeOp('new', [step({ stepId: 's-new', businessKey, status: 'in_flight', dispatchedAt: '2026-09-10T00:00:00.000Z' })]))
    const writer = { schedule: jest.fn() }
    const coordinator = makeCoordinator(store, writer)

    const preview = await coordinator.previewSchedule({
      kind: 'schedule',
      timezone: TIMEZONE,
      request: { workoutId: 'w3', date: '2026-09-22', timezone: TIMEZONE },
      steps: [{ workoutId: 'w3', date: '2026-09-22' }],
    })

    expect(preview.requiresConfirmation).toBe(false)
    expect(preview.steps[0].action).toBe('blocked')
    expect(preview.steps[0].status).toBe('in_flight')
    expect(writer.schedule).not.toHaveBeenCalled()
  })

  it('blocks when an old failed sits in front of a new unknown (uncertainty wins)', async () => {
    const store = new InMemoryStore(ACCOUNT)
    const businessKey = scheduleBusinessKey(ACCOUNT, 'w4', '2026-09-23')
    store.seed(makeOp('old', [step({ stepId: 's-old', businessKey, status: 'failed', errorCode: 'BAD_REQUEST' })]))
    store.seed(makeOp('new', [step({ stepId: 's-new', businessKey, status: 'unknown' })]))
    const writer = { schedule: jest.fn() }
    const coordinator = makeCoordinator(store, writer)

    const preview = await coordinator.previewSchedule({
      kind: 'schedule',
      timezone: TIMEZONE,
      request: { workoutId: 'w4', date: '2026-09-23', timezone: TIMEZONE },
      steps: [{ workoutId: 'w4', date: '2026-09-23' }],
    })

    expect(preview.requiresConfirmation).toBe(false)
    expect(preview.steps[0].action).toBe('blocked')
    expect(preview.steps[0].status).toBe('unknown')
    expect(writer.schedule).not.toHaveBeenCalled()
  })

  it('end-to-end: single-day A then batch A+B with A succeeded then re-preview A is blocked (no second write)', async () => {
    const state = freshState()
    const writer = jest.fn().mockResolvedValue({ workoutScheduleId: 'sid-A' })
    const { service } = makeService(state, writer)

    const single = { workoutId: 'A', date: '2026-09-20', timezone: TIMEZONE }
    const singlePreview = await service.scheduleWorkout(single as never)
    expect(singlePreview).toMatchObject({ requiresConfirmation: true })

    const batch = {
      schedules: [{ workoutId: 'A', date: '2026-09-20' }, { workoutId: 'B', date: '2026-09-21' }],
      timezone: TIMEZONE,
    }
    const batchPreview = await service.batchScheduleWorkouts(batch as never)
    expect(batchPreview).toMatchObject({ requiresConfirmation: true })
    await service.batchScheduleWorkouts({
      ...batch,
      confirmed: true,
      confirmationId: batchPreview.confirmationId,
    } as never)
    expect(writer).toHaveBeenCalledTimes(2)

    // The critical step: A is now succeeded from the batch. A new single-day
    // preview must NOT trigger another scheduleWorkout POST.
    const replay = await service.scheduleWorkout(single as never)
    expect(replay).toMatchObject({
      requiresConfirmation: false,
      action: 'skip_existing',
      success: true,
    })
    expect(writer).toHaveBeenCalledTimes(2)
  })

  it('end-to-end: A → A+B with A unknown → batch never re-dispatches A', async () => {
    const state = freshState()
    const writer = jest
      .fn()
      .mockImplementationOnce(async () => { throw new Error('socket hang up') })
      .mockImplementationOnce(async () => ({ workoutScheduleId: 'sid-B' }))
    const { service } = makeService(state, writer)

    const single = { workoutId: 'A', date: '2026-09-25', timezone: TIMEZONE }
    const singlePreview = await service.scheduleWorkout(single as never)
    expect(singlePreview).toMatchObject({ requiresConfirmation: true })
    await service.scheduleWorkout({
      ...single,
      confirmed: true,
      confirmationId: singlePreview.confirmationId,
    } as never)
    expect(writer).toHaveBeenCalledTimes(1)

    // Now widen to A+B. The new batch's preview must observe A is unknown and
    // refuse a second POST for A; only B should be dispatched.
    const batch = {
      schedules: [{ workoutId: 'A', date: '2026-09-25' }, { workoutId: 'B', date: '2026-09-26' }],
      timezone: TIMEZONE,
    }
    const batchPreview = await service.batchScheduleWorkouts(batch as never)
    expect(batchPreview).toMatchObject({ requiresConfirmation: true })
    const previewSteps = (batchPreview as { preview: Array<{ workoutId: string; action: string; status: string }> })
      .preview
    const aPreview = previewSteps.find(s => s.workoutId === 'A')
    const bPreview = previewSteps.find(s => s.workoutId === 'B')
    expect(aPreview?.action).toBe('blocked')
    expect(aPreview?.status).toBe('unknown')
    expect(bPreview?.action).toBe('write')
    await service.batchScheduleWorkouts({
      ...batch,
      confirmed: true,
      confirmationId: batchPreview.confirmationId,
    } as never)
    // Critical: A was never re-sent. Only B was dispatched (the second call).
    expect(writer).toHaveBeenCalledTimes(2)
    expect(writer).toHaveBeenNthCalledWith(2, 'B', '2026-09-26')
  })

  it('preserves safety regardless of operation insertion order in the journal', async () => {
    // Insert newest first this time — first-match should still resolve to the
    // right outcome because the decision is history-aggregated, not first-hit.
    const store = new InMemoryStore(ACCOUNT)
    const businessKey = scheduleBusinessKey(ACCOUNT, 'w5', '2026-09-27')
    store.seed(makeOp('new', [step({ stepId: 's-new', businessKey, status: 'succeeded', evidence: 'response', workoutScheduleId: 'sid-5' })]))
    store.seed(makeOp('old', [step({ stepId: 's-old', businessKey, status: 'not_attempted' })]))
    const writer = { schedule: jest.fn() }
    const coordinator = makeCoordinator(store, writer)

    const preview = await coordinator.previewSchedule({
      kind: 'schedule',
      timezone: TIMEZONE,
      request: { workoutId: 'w5', date: '2026-09-27', timezone: TIMEZONE },
      steps: [{ workoutId: 'w5', date: '2026-09-27' }],
    })
    expect(preview.requiresConfirmation).toBe(false)
    expect(preview.steps[0].action).toBe('skip_existing')
    expect(preview.steps[0].operationId).toBe('new')
    expect(writer.schedule).not.toHaveBeenCalled()
  })
})

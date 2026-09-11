/**
 * Unified write coordinator for Garmin Calendar scheduling.
 *
 * Invariants enforced here (each is covered by a regression test):
 *   1. A business key (account + workoutId + local date) is occupied while an
 *      `in_flight` or `unknown` step exists for it. A new preview, a different
 *      idempotency key, a restart or a concurrent caller can never dispatch a
 *      second write for that key.
 *   2. `in_flight` is persisted *before* the single network dispatch. If that
 *      persistence fails, no write is sent.
 *   3. A write is dispatched at most once per confirmation, and never
 *      automatically retried after a timeout.
 *   4. Only steps still `prepared` can dispatch, so a superseded preview can
 *      never add a write.
 */

import { randomUUID } from 'node:crypto'
import type { AccountLock } from './lock'
import type { OperationStore } from './store'
import {
  GarminWriteError,
  WRITE_ERROR_CODES,
  classifyWriteFailure,
  type WriteErrorCode,
} from './errors'
import { idempotencyKeyHash, requestHash, scheduleBusinessKey } from './identity'
import {
  SATISFIED_STEP_STATUSES,
  findStepByBusinessKeySafe,
  type OperationDocument,
  type StepStatus,
  type WriteEvidence,
  type WriteOperation,
  type WriteStep,
} from './types'

export interface CalendarWriter {
  schedule(workoutId: string, date: string): Promise<{ workoutScheduleId?: string | null }>
}

export interface ScheduleStepInput {
  workoutId: string
  date: string
}

export type ScheduleAction = 'write' | 'skip_existing' | 'blocked'

export interface SchedulePreviewStep {
  stepId: string
  workoutId: string
  date: string
  action: ScheduleAction
  status: StepStatus
  operationId?: string
  workoutScheduleId?: string | null
  errorCode?: string
  reason?: string
}

export interface SchedulePreview {
  operationId?: string
  requiresConfirmation: boolean
  steps: SchedulePreviewStep[]
  /** Operation a caller should inspect when nothing new may be written. */
  existingOperationId?: string
}

export interface ScheduleStepReceipt {
  stepId: string
  workoutId: string
  date: string
  status: StepStatus
  success: boolean
  desiredStateSatisfied: boolean
  evidence: WriteEvidence
  workoutScheduleId?: string | null
  errorCode?: string
  canResume: boolean
  manualReviewRequired: boolean
  nextAction?: string
  operationId: string
  message?: string
}

export interface ScheduleExecution {
  operationId: string
  receipts: ScheduleStepReceipt[]
}

export interface SchedulePreviewInput {
  kind: 'schedule' | 'batch-schedule'
  timezone: string
  request: Record<string, unknown>
  steps: ScheduleStepInput[]
  idempotencyKey?: string
}

export interface WriteCoordinatorOptions {
  store: OperationStore
  lock: AccountLock
  accountKey: string
  writer: CalendarWriter
  now?: () => Date
  newOperationId?: () => string
  newStepId?: () => string
}

const BLOCKED_REASON =
  'An earlier write for this workout and date has an unknown outcome. ' +
  'Reconcile that operation before scheduling again.'
const SKIP_REASON = 'Garmin Calendar already has this workout on this date.'

export class WriteCoordinator {
  private readonly now: () => Date
  private readonly newOperationId: () => string
  private readonly newStepId: () => string

  constructor(private readonly options: WriteCoordinatorOptions) {
    this.now = options.now ?? (() => new Date())
    this.newOperationId = options.newOperationId ?? (() => randomUUID())
    this.newStepId = options.newStepId ?? (() => randomUUID())
  }

  private get accountKey(): string {
    return this.options.accountKey
  }

  /** Read the journal without taking the write lock; safe for read-only tools. */
  async getOperation(operationId: string): Promise<WriteOperation | undefined> {
    const document = await this.options.store.read()
    return document.operations[operationId]
  }

  async listOperations(): Promise<WriteOperation[]> {
    const document = await this.options.store.read()
    return Object.values(document.operations)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  async findOperationByIdempotencyKey(idempotencyKey: string): Promise<WriteOperation | undefined> {
    const document = await this.options.store.read()
    const operationId = document.idempotencyIndex[idempotencyKeyHash(this.accountKey, idempotencyKey)]
    return operationId ? document.operations[operationId] : undefined
  }

  /**
   * Build a preview and persist the candidate set. Never writes to Garmin.
   * Returns `requiresConfirmation:false` with a safe no-op when every step is
   * blocked or already satisfied.
   */
  async previewSchedule(input: SchedulePreviewInput): Promise<SchedulePreview> {
    return this.options.lock.runExclusive(async () => {
      const document = await this.options.store.read()
      const idemHash = input.idempotencyKey
        ? idempotencyKeyHash(this.accountKey, input.idempotencyKey)
        : undefined

      if (idemHash) {
        const existingId = document.idempotencyIndex[idemHash]
        if (existingId) {
          const existing = document.operations[existingId]
          if (!existing) {
            throw corrupt('Idempotency index points at a missing operation')
          }
          if (existing.requestHash !== requestHash(stripIdempotencyKey(input.request))) {
            throw new GarminWriteError(
              WRITE_ERROR_CODES.IDEMPOTENCY_CONFLICT,
              'not_applied',
              'This idempotencyKey is already bound to a different request for this account',
            )
          }
          // Same key, same request: was anything actually confirmed?
          //   - If every step is in a terminal state (succeeded / skipped /
          //     failed / not_attempted), return the durable receipt. No new
          //     confirmation is issued; the caller may re-poll.
          //   - If any step is still prepared (never confirmed) or unknown /
          //     in_flight, advance the preview revision and let the caller
          //     re-confirm. The earlier confirmationId is invalidated.
          const allTerminal = existing.steps.every(step =>
            step.status === 'succeeded'
            || step.status === 'skipped'
            || step.status === 'failed'
            || step.status === 'not_attempted',
          )
          if (allTerminal) {
            return {
              operationId: existing.operationId,
              existingOperationId: existing.operationId,
              requiresConfirmation: false,
              steps: existing.steps.map(step => ({
                stepId: step.stepId,
                workoutId: step.workoutId ?? '',
                date: step.date ?? '',
                action: SATISFIED_STEP_STATUSES.has(step.status) ? 'skip_existing' : 'blocked',
                status: step.status,
                operationId: existing.operationId,
                workoutScheduleId: step.workoutScheduleId,
                errorCode: step.errorCode,
                reason: SATISFIED_STEP_STATUSES.has(step.status) ? SKIP_REASON : BLOCKED_REASON,
              })),
            }
          }
          // Otherwise: same key, same payload, re-issue a confirmation by
          // bumping the preview revision. The operation's `request` and
          // `requestHash` are not mutated: the caller's earlier intent is
          // preserved across re-previews.
          existing.previewRevision = (existing.previewRevision ?? 0) + 1
          existing.updatedAt = this.now().toISOString()
          await this.persist(document)
          return {
            operationId: existing.operationId,
            existingOperationId: existing.operationId,
            requiresConfirmation: true,
            previewRevision: existing.previewRevision,
            steps: existing.steps.map(step => ({
              stepId: step.stepId,
              workoutId: step.workoutId ?? '',
              date: step.date ?? '',
              action: step.status === 'prepared' ? 'write' : 'blocked',
              status: step.status,
              operationId: existing.operationId,
              workoutScheduleId: step.workoutScheduleId,
              errorCode: step.errorCode,
              reason: step.status === 'prepared' ? undefined : BLOCKED_REASON,
            })),
          }
        }
      }

      const decisions = input.steps.map((step) => {
        const businessKey = scheduleBusinessKey(this.accountKey, step.workoutId, step.date)
        const verdict = findStepByBusinessKeySafe(document, businessKey)
        if (verdict.kind === 'unresolved') {
          return {
            step,
            businessKey,
            action: 'blocked' as ScheduleAction,
            found: { operation: verdict.operation, step: verdict.step },
          }
        }
        if (verdict.kind === 'satisfied') {
          return {
            step,
            businessKey,
            action: 'skip_existing' as ScheduleAction,
            found: { operation: verdict.operation, step: verdict.step },
          }
        }
        if (verdict.kind === 'retryable') {
          return {
            step,
            businessKey,
            action: 'write' as ScheduleAction,
            found: { operation: verdict.operation, step: verdict.step },
          }
        }
        return { step, businessKey, action: 'write' as ScheduleAction }
      })

      const writable = decisions.filter(decision => decision.action === 'write')
      if (writable.length === 0) {
        return {
          requiresConfirmation: false,
          steps: decisions.map(decision => this.toPreviewStep(decision)),
          existingOperationId: decisions.find(decision => decision.found)?.found?.operation.operationId,
        }
      }

      const writableKeys = writable.map(decision => decision.businessKey)
      const reused = this.findReusableOperation(document, writableKeys)
      const safeRequest = stripIdempotencyKey(input.request)
      const operation: WriteOperation = reused ?? {
        schemaVersion: 1,
        operationId: this.newOperationId(),
        kind: input.kind,
        accountKey: this.accountKey,
        requestHash: requestHash(safeRequest),
        idempotencyKeyHash: idemHash,
        previewRevision: 0,
        // The on-disk request must never include the plaintext idempotencyKey.
        // It's caller-metadata, not a template fingerprint input, and we never
        // want to round-trip an unknown user-supplied string into a private
        // journal. The hash is preserved in `idempotencyKeyHash` instead.
        request: safeRequest,
        createdAt: this.now().toISOString(),
        updatedAt: this.now().toISOString(),
        steps: [],
      }

      operation.kind = input.kind
      operation.requestHash = requestHash(safeRequest)
      operation.request = safeRequest
      if (idemHash) operation.idempotencyKeyHash = idemHash
      operation.updatedAt = this.now().toISOString()
      // Persist EVERY requested item in the original order, including
      // blocked/satisfied references. Only the writable items are turned into
      // a fresh `prepared` step here; non-writable items reuse the existing
      // stepId (if any) and pin a read-only `reference` to the blocker so the
      // original batch is reconstructable across restarts.
      operation.steps = decisions.map((decision) => {
        const reusedStep = reused
          ? reused.steps.find(candidate => candidate.businessKey === decision.businessKey)
          : undefined
        if (decision.action === 'write') {
          if (reusedStep && reusedStep.status === 'prepared') return reusedStep
          return {
            stepId: reusedStep?.stepId ?? this.newStepId(),
            businessKey: decision.businessKey,
            kind: 'schedule',
            status: 'prepared',
            attempt: reusedStep?.attempt ?? 0,
            workoutId: decision.step.workoutId,
            date: decision.step.date,
            evidence: 'none',
            attempts: reusedStep?.attempts ?? [],
          }
        }
        // Non-writable: anchor a reference to the blocker / satisfaction
        // holder. The original batch's order and identity are preserved.
        const ref = decision.found
          ? {
              operationId: decision.found.operation.operationId,
              stepId: decision.found.step.stepId,
              status: decision.found.step.status,
              workoutScheduleId: decision.found.step.workoutScheduleId,
              errorCode: decision.found.step.errorCode,
            }
          : undefined
        if (reusedStep) {
          reusedStep.reference = ref
          reusedStep.status = decision.action === 'blocked' ? 'not_attempted' : 'skipped'
          reusedStep.errorCode = decision.action === 'blocked'
            ? ref?.errorCode ?? WRITE_ERROR_CODES.WRITE_OUTCOME_UNKNOWN
            : undefined
          return reusedStep
        }
        return {
          stepId: this.newStepId(),
          businessKey: decision.businessKey,
          kind: 'schedule',
          status: decision.action === 'blocked' ? 'not_attempted' : 'skipped',
          attempt: 0,
          workoutId: decision.step.workoutId,
          date: decision.step.date,
          evidence: decision.action === 'blocked' ? 'none' : 'response',
          attempts: [],
          ...(ref ? { reference: ref } : {}),
          ...(decision.action === 'blocked'
            ? { errorCode: ref?.errorCode ?? WRITE_ERROR_CODES.WRITE_OUTCOME_UNKNOWN }
            : {}),
        }
      })

      document.operations[operation.operationId] = operation
      if (idemHash) document.idempotencyIndex[idemHash] = operation.operationId
      // Supersede any other prepared step for these keys so an old preview can
      // never dispatch a write for a key this preview now owns.
      this.supersedePreparedSteps(document, writableKeys, operation.operationId)
      await this.persist(document)

      return {
        operationId: operation.operationId,
        requiresConfirmation: true,
        steps: decisions.map(decision => this.toPreviewStep(decision, operation)),
      }
    })
  }

  /**
   * Execute a confirmed operation. Dispatches each `prepared` step at most
   * once. Never retries automatically.
   */
  async executeSchedule(
    operationId: string,
    expectedRequestHash: string,
  ): Promise<ScheduleExecution> {
    return this.options.lock.runExclusive(async () => {
      const document = await this.options.store.read()
      const operation = document.operations[operationId]
      if (!operation) {
        throw new GarminWriteError(
          WRITE_ERROR_CODES.OPERATION_NOT_FOUND,
          'not_applied',
          'No local write operation matches this confirmation for this account',
        )
      }
      if (operation.requestHash !== expectedRequestHash) {
        throw new GarminWriteError(
          WRITE_ERROR_CODES.CONFIRMATION_INVALID,
          'not_applied',
          'The confirmed operation changed after the preview; request a new preview',
        )
      }

      const receipts: ScheduleStepReceipt[] = []
      for (const step of operation.steps) {
        if (step.status !== 'prepared') {
          // Either a non-writable entry (blocked / skipped) already finalized
          // at preview time, or a step mutated by an earlier confirm attempt.
          receipts.push(this.receiptFor(operation, step))
          continue
        }

        // Re-check the business key inside the lock using history aggregation
        // so a stale not_attempted / prepared from an earlier operation cannot
        // authorize a duplicate dispatch while a newer in_flight / unknown /
        // succeeded step exists.
        const holder = findStepByBusinessKeySafe(document, step.businessKey)
        if (holder.kind !== 'absent' && holder.step.stepId !== step.stepId) {
          if (holder.kind === 'unresolved') {
            step.status = 'not_attempted'
            step.errorCode = holder.step.errorCode ?? WRITE_ERROR_CODES.WRITE_OUTCOME_UNKNOWN
            step.reference = {
              operationId: holder.operation.operationId,
              stepId: holder.step.stepId,
              status: holder.step.status,
              workoutScheduleId: holder.step.workoutScheduleId,
              errorCode: holder.step.errorCode,
            }
            await this.persist(document)
            receipts.push(this.blockedReceipt(holder.operation, step))
            continue
          }
          if (holder.kind === 'satisfied') {
            step.status = 'skipped'
            step.evidence = 'none'
            step.reference = {
              operationId: holder.operation.operationId,
              stepId: holder.step.stepId,
              status: holder.step.status,
              workoutScheduleId: holder.step.workoutScheduleId,
            }
            await this.persist(document)
            receipts.push(this.receiptFor(operation, step))
            continue
          }
        }

        // PERSIST in_flight BEFORE dispatch. If this fails, nothing is sent.
        step.status = 'in_flight'
        step.attempt += 1
        step.dispatchedAt = this.now().toISOString()
        step.attempts.push({
          attempt: step.attempt,
          outcome: 'in_flight',
          startedAt: step.dispatchedAt,
        })
        operation.updatedAt = this.now().toISOString()
        await this.persist(document)

        // Exactly one dispatch. There is deliberately no retry on any failure.
        try {
          const result = await this.options.writer.schedule(step.workoutId as string, step.date as string)
          step.status = 'succeeded'
          step.evidence = 'response'
          step.workoutScheduleId = result?.workoutScheduleId ?? null
          step.errorCode = undefined
          this.finishAttempt(step, 'succeeded')
        } catch (error) {
          const { outcome, code } = classifyWriteFailure(error)
          step.status = outcome === 'not_applied' ? 'failed' : 'unknown'
          step.evidence = 'none'
          step.errorCode = code
          this.finishAttempt(step, step.status === 'unknown' ? 'unknown' : 'failed', code)
        }
        operation.updatedAt = this.now().toISOString()
        await this.persist(document)
        receipts.push(this.receiptFor(operation, step))
      }

      return { operationId, receipts }
    })
  }

  private finishAttempt(step: WriteStep, outcome: 'succeeded' | 'failed' | 'unknown', errorCode?: WriteErrorCode): void {
    const last = step.attempts[step.attempts.length - 1]
    if (!last) return
    last.outcome = outcome
    last.finishedAt = this.now().toISOString()
    if (errorCode) last.errorCode = errorCode
  }

  private async persist(document: OperationDocument): Promise<void> {
    const expected = document.revision
    document.revision = expected + 1
    await this.options.store.save(document, { expectedRevision: expected })
  }

  private findReusableOperation(
    document: OperationDocument,
    writableKeys: string[],
  ): WriteOperation | undefined {
    return Object.values(document.operations).find((operation) => {
      const prepared = operation.steps.filter(step => step.status === 'prepared')
      if (prepared.length !== writableKeys.length) return false
      return prepared.every(step => writableKeys.includes(step.businessKey))
    })
  }

  private supersedePreparedSteps(
    document: OperationDocument,
    keys: string[],
    ownerOperationId: string,
  ): void {
    for (const operation of Object.values(document.operations)) {
      for (const step of operation.steps) {
        if (operation.operationId === ownerOperationId) continue
        if (step.status !== 'prepared') continue
        if (!keys.includes(step.businessKey)) continue
        step.status = 'not_attempted'
        step.errorCode = WRITE_ERROR_CODES.CONFIRMATION_STALE
      }
    }
  }

  private toPreviewStep(
    decision: {
      step: ScheduleStepInput
      businessKey: string
      action: ScheduleAction
      found?: { operation: WriteOperation; step: WriteStep }
    },
    operation?: WriteOperation,
  ): SchedulePreviewStep {
    if (decision.found) {
      return {
        stepId: decision.found.step.stepId,
        workoutId: decision.step.workoutId,
        date: decision.step.date,
        action: decision.action,
        status: decision.found.step.status,
        operationId: decision.found.operation.operationId,
        workoutScheduleId: decision.found.step.workoutScheduleId,
        errorCode: decision.action === 'blocked'
          ? decision.found.step.errorCode ?? WRITE_ERROR_CODES.WRITE_OUTCOME_UNKNOWN
          : undefined,
        reason: decision.action === 'blocked' ? BLOCKED_REASON : SKIP_REASON,
      }
    }
    const step = operation?.steps.find(candidate => candidate.businessKey === decision.businessKey)
    return {
      stepId: step?.stepId ?? '',
      workoutId: decision.step.workoutId,
      date: decision.step.date,
      action: decision.action,
      status: step?.status ?? 'prepared',
      operationId: operation?.operationId,
    }
  }

  private blockedReceipt(holder: WriteOperation, step: WriteStep): ScheduleStepReceipt {
    return {
      stepId: step.stepId,
      workoutId: step.workoutId ?? '',
      date: step.date ?? '',
      status: 'unknown',
      success: false,
      desiredStateSatisfied: false,
      evidence: holder.steps.find(candidate => candidate.businessKey === step.businessKey)?.evidence ?? 'none',
      errorCode: step.errorCode ?? WRITE_ERROR_CODES.WRITE_OUTCOME_UNKNOWN,
      canResume: false,
      manualReviewRequired: true,
      nextAction: 'reconcile_garmin_write_operation',
      operationId: holder.operationId,
      message: BLOCKED_REASON,
    }
  }

  private receiptFor(operation: WriteOperation, step: WriteStep): ScheduleStepReceipt {
    // A non-prepared step that pins a read-only reference to an existing
    // blocker / satisfied holder is reported in the holder's status, not the
    // local step's bookkeeping status. The plan requires blocked-by-unknown
    // to surface as `unknown` to the caller, and blocked-by-satisfied to
    // surface as the holder's `succeeded` (i.e. desiredStateSatisfied:true).
    const referenceStatus = step.reference?.status
    const reportedStatus = referenceStatus ?? step.status
    const satisfied = SATISFIED_STEP_STATUSES.has(reportedStatus)
    const resumable = reportedStatus === 'failed' || reportedStatus === 'not_attempted'
    const unknown = reportedStatus === 'unknown' || reportedStatus === 'in_flight'
    return {
      stepId: step.stepId,
      workoutId: step.workoutId ?? '',
      date: step.date ?? '',
      status: reportedStatus,
      success: satisfied,
      desiredStateSatisfied: satisfied,
      evidence: step.evidence,
      workoutScheduleId: step.reference?.workoutScheduleId ?? step.workoutScheduleId,
      errorCode: step.errorCode ?? step.reference?.errorCode,
      canResume: resumable,
      manualReviewRequired: unknown,
      nextAction: unknown
        ? 'reconcile_garmin_write_operation'
        : resumable && !step.reference
          ? 'resume_garmin_write_operation'
          : undefined,
      operationId: operation.operationId,
    }
  }
}

function corrupt(detail: string): GarminWriteError {
  return new GarminWriteError(WRITE_ERROR_CODES.STATE_CORRUPT, 'not_applied', detail)
}

/**
 * Strip caller-supplied metadata (the raw idempotencyKey) before persisting
 * the request. The hash is kept separately on the operation. This is a
 * shallow strip: arrays and nested objects are returned by reference, and
 * only top-level keys named in RESULT_CONTROL_FIELDS are removed.
 */
const RESULT_CONTROL_FIELDS = ['idempotencyKey', 'confirmationId', 'confirmed'] as const

function stripIdempotencyKey(request: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(request)) {
    if ((RESULT_CONTROL_FIELDS as readonly string[]).includes(key)) continue
    clone[key] = value
  }
  return clone
}

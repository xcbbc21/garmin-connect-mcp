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
  isAccountLevelWriteFailure,
  type WriteErrorCode,
} from './errors'
import {
  idempotencyKeyHash,
  requestHash,
  scheduleBusinessKey,
  stripResultControlFields as stripIdempotencyKey,
} from './identity'
import {
  CURRENT_JOURNAL_SCHEMA_VERSION,
  migrateJournalUnderLock,
  type JournalMigrationReport,
} from './migration'
import {
  REBUILDABLE_STEP_STATUS,
  RETRYABLE_STEP_STATUSES,
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

export interface CreateWriter {
  addWorkout(definition: Record<string, unknown>): Promise<{ workoutId: string | number }>
}

export interface UnscheduleWriter {
  unschedule(workoutScheduleId: string): Promise<void>
}

/**
 * A confirmed approval, decoded from the durable `confirmationId` handle.
 * `previewRevision` is checked against the persisted operation, so a handle
 * issued before a re-preview (in this process or any other) cannot dispatch.
 */
export interface WriteConfirmation {
  operationId: string
  requestHash: string
  previewRevision: number
}

/** How long a preview revision stays authorized to dispatch a new write. */
export const CONFIRMATION_TTL_MS = 10 * 60 * 1000

/**
 * Union of every write verb the coordinator may dispatch. The writer is
 * passed in one place so the coordinator never has to know about the
 * underlying client shape — only the business key and the verb.
 */
export interface UnifiedCalendarWriter extends CalendarWriter, CreateWriter, UnscheduleWriter {
  // The shape is structural: any object with all three methods qualifies.
}

export interface CreateStepInput {
  /** canonical workout definition; the coordinator normalises and fingerprints it. */
  definition: Record<string, unknown>
  /** precomputed business key for the definition. */
  businessKey: string
}

export interface UnscheduleStepInput {
  workoutScheduleId: string
  businessKey: string
}

export interface ScheduleStepInput {
  workoutId: string
  date: string
}

export type WriteKindExtended = 'create' | 'schedule' | 'unschedule' | 'batch-schedule'

export type ScheduleAction = 'write' | 'skip_existing' | 'blocked'

export interface SchedulePreviewStep {
  stepId: string
  workoutId: string
  date: string
  /** kind the step belongs to. */
  kind: WriteKindExtended
  /** the workoutScheduleId for unschedule steps; undefined for create/schedule. */
  workoutScheduleId?: string
  action: ScheduleAction
  status: StepStatus
  operationId?: string
  /** assigned workoutId for create steps after success. */
  resolvedWorkoutId?: string
  errorCode?: string
  reason?: string
}

export interface SchedulePreview {
  operationId?: string
  requiresConfirmation: boolean
  steps: SchedulePreviewStep[]
  /** Operation a caller should inspect when nothing new may be written. */
  existingOperationId?: string
  /** previewRevision at the time this preview was issued; re-issued previews bump this. */
  previewRevision?: number
}

/**
 * A preview carrying an operation the caller may approve.
 */
export function previewRevisionOf(preview: SchedulePreview): number {
  return preview.previewRevision ?? 0
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

export interface ExecuteScheduleOptions {
  /**
   * When aborted, no *further* entry is dispatched. An entry already in flight
   * is never abandoned: its real outcome is still recorded, and the remaining
   * entries become retryable `not_attempted` receipts.
   */
  signal?: AbortSignal
}

/**
 * Why the rest of a batch stopped being dispatched. Passed down to every
 * remaining entry so its receipt points at the entry that caused the stop.
 */
interface HaltReason {
  cause: WriteStep
  code: WriteErrorCode
  reason: 'aborted' | 'expired' | 'transport' | 'state_unavailable' | 'lock_lost'
}

export interface SchedulePreviewInput {
  kind: 'schedule' | 'batch-schedule'
  timezone: string
  request: Record<string, unknown>
  steps: ScheduleStepInput[]
  idempotencyKey?: string
}

export interface CreatePreviewInput {
  request: Record<string, unknown>
  idempotencyKey?: string
  businessKey: string
  fingerprint: string
}

export interface UnschedulePreviewInput {
  request: Record<string, unknown>
  idempotencyKey?: string
  businessKey: string
  workoutScheduleId: string
}

export interface SingleStepPreviewInput {
  kind: 'create' | 'unschedule'
  request: Record<string, unknown>
  idempotencyKey?: string
  businessKey: string
  step: Record<string, unknown>
  toStep: (businessKey: string, stepId: string) => WriteStep
}

export interface CreateAndScheduleWriter extends CreateWriter, CalendarWriter {
  // create phase first, then the schedule phase for the resolved id.
}

export interface CreateAndSchedulePreviewInput {
  request: Record<string, unknown>
  idempotencyKey?: string
  /** business key of the create phase (account + definition fingerprint). */
  businessKey: string
  fingerprint: string
  date: string
}

interface ScheduleDecision {
  step: { workoutId?: string; date?: string; workoutScheduleId?: string }
  businessKey: string
  action: ScheduleAction
  found?: { operation: WriteOperation; step: WriteStep }
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

  /**
   * Commit a pending v1 -> v2 journal upgrade while holding the account lock.
   *
   * The upgrade is a whole-file read-modify-write, so it must not race a live
   * writer: without the lock, two processes could each migrate a stale copy and
   * the loser's rename would resurrect steps the winner had already advanced.
   *
   * It is a no-op — one bounded read — when the journal is already v2, so the
   * write paths can call it unconditionally before their first use. A failure
   * is propagated rather than swallowed: a journal this build cannot migrate is
   * a journal whose confirmation bindings and unknown occupancy it cannot
   * trust, and proceeding would be exactly the silent repair the store refuses
   * to do.
   */
  async migrateJournal(): Promise<JournalMigrationReport> {
    return this.options.lock.runExclusive(async () => {
      const { report } = await migrateJournalUnderLock({
        store: this.options.store,
        accountKey: this.accountKey,
        now: this.options.now,
      })
      return report
    })
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
  /**
   * Common preview path for single-step writes (create, unschedule, single
   * schedule). Always takes the account lock, builds a one-step decision
   * list, and either reuses an existing operation or creates a new one.
   */
  private async previewSingleStep(input: SingleStepPreviewInput): Promise<SchedulePreview> {
    return this.options.lock.runExclusive(async () => {
      const document = await this.options.store.read()
      const idemHash = input.idempotencyKey
        ? idempotencyKeyHash(this.accountKey, input.idempotencyKey)
        : undefined

      if (idemHash) {
        const existingId = document.idempotencyIndex[idemHash]
        if (existingId) {
          const existing = document.operations[existingId]
          if (!existing) throw corrupt('Idempotency index points at a missing operation')
          if (existing.requestHash !== requestHash(stripIdempotencyKey(input.request))) {
            throw new GarminWriteError(
              WRITE_ERROR_CODES.IDEMPOTENCY_CONFLICT,
              'not_applied',
              'This idempotencyKey is already bound to a different request for this account',
            )
          }
          return this.reshowOrAdvance(document, existing)
        }
      }

      const businessKey = input.businessKey
      const verdict = findStepByBusinessKeySafe(document, businessKey)
      const decision: ScheduleDecision = (() => {
        if (verdict.kind === 'unresolved') {
          return {
            step: input.step,
            businessKey,
            action: 'blocked',
            found: { operation: verdict.operation, step: verdict.step },
          }
        }
        if (verdict.kind === 'satisfied') {
          return {
            step: input.step,
            businessKey,
            action: 'skip_existing',
            found: { operation: verdict.operation, step: verdict.step },
          }
        }
        if (verdict.kind === 'retryable') {
          return {
            step: input.step,
            businessKey,
            action: 'write',
            found: { operation: verdict.operation, step: verdict.step },
          }
        }
        return { step: input.step, businessKey, action: 'write' }
      })()

      if (decision.action !== 'write') {
        // No new operation: return a synthetic preview derived from history.
        return {
          requiresConfirmation: false,
          steps: [this.toPreviewStep(decision)],
          existingOperationId: decision.found?.operation.operationId,
        }
      }

      const safeRequest = stripIdempotencyKey(input.request)
      const reused = this.findReusableOperation(document, [businessKey])
      const operation: WriteOperation = reused ?? {
        schemaVersion: CURRENT_JOURNAL_SCHEMA_VERSION,
        operationId: this.newOperationId(),
        kind: input.kind,
        accountKey: this.accountKey,
        requestHash: requestHash(safeRequest),
        idempotencyKeyHash: idemHash,
        previewRevision: 0,
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

      // One-step operation: a single fresh prepared step.
      const writeStep = input.toStep(businessKey, this.newStepId())
      operation.steps = [writeStep]
      document.operations[operation.operationId] = operation
      if (idemHash) document.idempotencyIndex[idemHash] = operation.operationId
      this.supersedePreparedSteps(document, [businessKey], operation.operationId)
      if (reused) this.advanceRevision(operation)
      this.issueRevision(operation)
      await this.persist(document)

      return {
        operationId: operation.operationId,
        requiresConfirmation: true,
        previewRevision: operation.previewRevision ?? 0,
        steps: [this.toPreviewStep(decision, operation)],
      }
    })
  }

  /**
   * Create a workout in the user's library. The fingerprint of the canonical
   * definition is the business key. A repeat call with the same definition
   * returns skip_existing; a different definition returns write.
   */
  async previewCreate(input: CreatePreviewInput): Promise<SchedulePreview> {
    return this.previewSingleStep({
      kind: 'create',
      request: input.request,
      idempotencyKey: input.idempotencyKey,
      businessKey: input.businessKey,
      step: {},
      toStep: (businessKey, stepId) => ({
        stepId,
        businessKey,
        kind: 'create',
        status: 'prepared',
        attempt: 0,
        evidence: 'none',
        attempts: [],
        // workoutId is left undefined; the resolved id is recorded after
        // the writer returns, in executeCreate.
        fingerprint: input.fingerprint,
      }),
    })
  }

  /**
   * Unschedule a previously scheduled workout. The business key is the
   * exact workoutScheduleId; an unknown / not-yet-attempted reference
   * to the same id is preserved.
   */
  async previewUnschedule(input: UnschedulePreviewInput): Promise<SchedulePreview> {
    return this.previewSingleStep({
      kind: 'unschedule',
      request: input.request,
      idempotencyKey: input.idempotencyKey,
      businessKey: input.businessKey,
      step: { workoutScheduleId: input.workoutScheduleId },
      toStep: (businessKey, stepId) => ({
        stepId,
        businessKey,
        kind: 'unschedule',
        status: 'prepared',
        attempt: 0,
        workoutScheduleId: input.workoutScheduleId,
        evidence: 'none',
        attempts: [],
      }),
    })
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
          //   - If no step can be re-armed (already satisfied, or its business
          //     key is claimed by an unresolved record), return the durable
          //     receipt. No new confirmation is issued; the caller may re-poll.
          //   - Otherwise re-issue a confirmation by bumping the preview
          //     revision and invalidating the earlier handle.
          return this.reshowOrAdvance(document, existing)
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
        schemaVersion: CURRENT_JOURNAL_SCHEMA_VERSION,
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
      if (reused) this.advanceRevision(operation)
      this.issueRevision(operation)
      await this.persist(document)

      return {
        operationId: operation.operationId,
        requiresConfirmation: true,
        previewRevision: operation.previewRevision ?? 0,
        steps: decisions.map(decision => this.toPreviewStep(decision, operation)),
      }
    })
  }

  /**
   * Execute a confirmed operation. Dispatches each `prepared` step at most
   * once. Never retries automatically.
   */
  async executeSchedule(
    confirmation: WriteConfirmation,
    options: ExecuteScheduleOptions = {},
  ): Promise<ScheduleExecution> {
    return this.options.lock.runExclusive(async () => {
      const document = await this.options.store.read()
      const operationId = confirmation.operationId
      const operation = this.authorize(
        document,
        confirmation,
        'No local write operation matches this confirmation for this account',
      )

      const receipts: ScheduleStepReceipt[] = []
      // Once the batch is halted, every remaining entry is recorded as
      // `not_attempted` (retryable) instead of being dispatched. A halt is
      // sticky: it is decided once, from evidence, and never re-litigated for
      // the rest of the batch.
      let halt: HaltReason | undefined

      for (const step of operation.steps) {
        if (step.status !== 'prepared') {
          // Either a non-writable entry (blocked / skipped) already finalized
          // at preview time, or a step mutated by an earlier confirm attempt.
          receipts.push(this.receiptFor(operation, step))
          continue
        }

        if (options.signal?.aborted) {
          halt ??= { cause: step, code: WRITE_ERROR_CODES.WRITE_NOT_APPLIED, reason: 'aborted' }
        }
        if (!halt && !(await this.stillHoldsLock())) {
          // The account lock was taken away between entries. Continuing would
          // race whoever owns it now, so the rest of the batch is not sent.
          halt ??= { cause: step, code: WRITE_ERROR_CODES.OPERATION_BUSY, reason: 'lock_lost' }
        }
        if (halt) {
          receipts.push(await this.haltStep(document, operation, step, halt))
          continue
        }

        if (!this.authorizeDispatch(operation)) {
          const receipt = await this.refuseExpired(document, operation, step)
          receipts.push(receipt)
          halt = { cause: step, code: WRITE_ERROR_CODES.CONFIRMATION_STALE, reason: 'expired' }
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
            // Only this entry is blocked. Its business key is occupied by an
            // unresolved write, which says nothing about the other keys in the
            // batch, so unrelated entries are still dispatched.
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
        const preDispatch = await this.persistOrReport(document, operation, step, 'before')
        if (preDispatch) {
          // The journal could not record the attempt, so no request was sent.
          receipts.push(preDispatch)
          halt = { cause: step, code: WRITE_ERROR_CODES.STATE_UNAVAILABLE, reason: 'state_unavailable' }
          continue
        }

        // Exactly one dispatch. There is deliberately no retry on any failure.
        let failureHalt: HaltReason['reason'] | undefined
        let failureCode: WriteErrorCode | undefined
        try {
          const result = await this.options.writer.schedule(step.workoutId as string, step.date as string)
          step.status = 'succeeded'
          step.evidence = 'response'
          step.workoutScheduleId = result?.workoutScheduleId ?? null
          step.errorCode = undefined
          this.finishAttempt(step, 'succeeded')
        } catch (error) {
          const accountLevel = this.recordFailure(step, error)
          failureCode = (step.errorCode ?? WRITE_ERROR_CODES.WRITE_OUTCOME_UNKNOWN) as WriteErrorCode
          // Only a failure that invalidates the channel or the batch's authority
          // stops the rest of the batch. An `unknown` entry on its own does not:
          // it is already durably journaled and the caller asked for every
          // remaining entry to be attempted.
          if (accountLevel) failureHalt = 'transport'
        }

        operation.updatedAt = this.now().toISOString()
        const postDispatch = await this.persistOrReport(document, operation, step, 'after')
        receipts.push(postDispatch ?? this.receiptFor(operation, step))

        if (postDispatch) {
          // The remote call already happened but could not be recorded. The
          // durable record is still the pre-dispatch `in_flight` marker, which
          // is unresolved by design, so the batch must not continue.
          halt = { cause: step, code: WRITE_ERROR_CODES.STATE_UNAVAILABLE, reason: 'state_unavailable' }
          continue
        }
        if (failureHalt) {
          halt = {
            cause: step,
            code: failureCode ?? WRITE_ERROR_CODES.WRITE_OUTCOME_UNKNOWN,
            reason: failureHalt,
          }
        }
      }

      return { operationId, receipts }
    })
  }

  /**
   * Execute a confirmed create operation. The fingerprint is part of the
   * request hash; a mismatch throws CONFIRMATION_INVALID. The writer returns
   * a fresh workoutId; the step records the assigned id.
   */
  async executeCreate(
    confirmation: WriteConfirmation,
    writer: CreateWriter,
  ): Promise<ScheduleExecution> {
    return this.options.lock.runExclusive(async () => {
      const document = await this.options.store.read()
      const operationId = confirmation.operationId
      const operation = this.authorize(
        document,
        confirmation,
        'No local create operation matches this confirmation for this account',
      )
      const step = operation.steps.find(candidate => candidate.kind === 'create')
      if (!step) throw corrupt('Create operation has no create step')
      if (step.status !== 'prepared') {
        return { operationId, receipts: [this.receiptFor(operation, step)] }
      }
      if (!this.authorizeDispatch(operation)) {
        return { operationId, receipts: [await this.refuseExpired(document, operation, step)] }
      }
      const blocker = await this.recheckBusinessKey(document, operation, step)
      if (blocker) return { operationId, receipts: [blocker] }

      await this.dispatchCreate(document, operation, step, writer)
      return { operationId, receipts: [this.receiptFor(operation, step)] }
    })
  }

  /**
   * Execute a confirmed unschedule operation. The exact workoutScheduleId
   * is part of the request hash; a mismatch throws CONFIRMATION_INVALID.
   * The writer receives only the schedule id; the operation is journaled.
   */
  async executeUnschedule(
    confirmation: WriteConfirmation,
    writer: UnscheduleWriter,
  ): Promise<ScheduleExecution> {
    return this.options.lock.runExclusive(async () => {
      const document = await this.options.store.read()
      const operationId = confirmation.operationId
      const operation = this.authorize(
        document,
        confirmation,
        'No local unschedule operation matches this confirmation for this account',
      )
      const step = operation.steps.find(candidate => candidate.kind === 'unschedule')
      if (!step) throw corrupt('Unschedule operation has no unschedule step')
      if (step.status !== 'prepared') {
        return { operationId, receipts: [this.receiptFor(operation, step)] }
      }
      if (!this.authorizeDispatch(operation)) {
        return { operationId, receipts: [await this.refuseExpired(document, operation, step)] }
      }
      const blocker = await this.recheckBusinessKey(document, operation, step)
      if (blocker) return { operationId, receipts: [blocker] }

      await this.dispatchUnschedule(document, operation, step, writer)
      return { operationId, receipts: [this.receiptFor(operation, step)] }
    })
  }

  /**
   * Preview the combined "create the template, then schedule it" flow.
   *
   * The two phases live in the *same* operation (`kind: 'create-and-schedule'`)
   * so a standalone schedule operation can never observe the create phase as an
   * unrelated satisfied receipt and re-schedule the same target:
   *   - create phase business key: account + workout-definition fingerprint
   *   - schedule phase business key: account + resolved workoutId + local date
   *
   * The schedule phase key cannot be computed before the create phase resolves
   * the workout id, so it is appended to the operation during execution (still
   * inside the account lock, still journaled, still dispatched at most once).
   */
  async previewCreateAndSchedule(input: CreateAndSchedulePreviewInput): Promise<SchedulePreview> {
    return this.options.lock.runExclusive(async () => {
      const document = await this.options.store.read()
      const idemHash = input.idempotencyKey
        ? idempotencyKeyHash(this.accountKey, input.idempotencyKey)
        : undefined

      if (idemHash) {
        const existingId = document.idempotencyIndex[idemHash]
        if (existingId) {
          const existing = document.operations[existingId]
          if (!existing) throw corrupt('Idempotency index points at a missing operation')
          if (existing.requestHash !== requestHash(stripIdempotencyKey(input.request))) {
            throw new GarminWriteError(
              WRITE_ERROR_CODES.IDEMPOTENCY_CONFLICT,
              'not_applied',
              'This idempotencyKey is already bound to a different request for this account',
            )
          }
          return this.reshowOrAdvance(document, existing)
        }
      }

      const createKey = input.businessKey
      const createVerdict = findStepByBusinessKeySafe(document, createKey)
      if (createVerdict.kind === 'unresolved') {
        return {
          requiresConfirmation: false,
          existingOperationId: createVerdict.operation.operationId,
          steps: [this.toPreviewStep({ step: {}, businessKey: createKey, action: 'blocked', found: createVerdict })],
        }
      }

      const knownWorkoutId = this.resolvedCreateWorkoutId(document, createKey)
      const scheduleKey = knownWorkoutId
        ? scheduleBusinessKey(this.accountKey, knownWorkoutId, input.date)
        : undefined
      const scheduleVerdict = scheduleKey
        ? findStepByBusinessKeySafe(document, scheduleKey)
        : ({ kind: 'absent' } as const)
      if (scheduleVerdict.kind === 'unresolved') {
        return {
          requiresConfirmation: false,
          existingOperationId: scheduleVerdict.operation.operationId,
          steps: [this.toPreviewStep({
            step: { workoutId: knownWorkoutId, date: input.date },
            businessKey: scheduleKey as string,
            action: 'blocked',
            found: scheduleVerdict,
          })],
        }
      }

      const createSatisfied = createVerdict.kind === 'satisfied'
      if (createSatisfied && !knownWorkoutId) {
        // A satisfied create must have recorded the assigned workout id. If it
        // did not, the journal is inconsistent and we must not guess an id or
        // create a second template.
        throw corrupt('A satisfied create step is missing its resolved workoutId')
      }
      if (createSatisfied && scheduleVerdict.kind === 'satisfied') {
        return {
          requiresConfirmation: false,
          existingOperationId: scheduleVerdict.operation.operationId,
          steps: [
            this.previewStepFromExisting(createVerdict.step, createVerdict.operation),
            this.previewStepFromExisting(scheduleVerdict.step, scheduleVerdict.operation),
          ],
        }
      }

      const safeRequest = stripIdempotencyKey(input.request)
      const reused = Object.values(document.operations).find(candidate =>
        candidate.kind === 'create-and-schedule'
        && candidate.steps.some(step => step.businessKey === createKey),
      )
      const operation: WriteOperation = reused ?? {
        schemaVersion: CURRENT_JOURNAL_SCHEMA_VERSION,
        operationId: this.newOperationId(),
        kind: 'create-and-schedule',
        accountKey: this.accountKey,
        requestHash: requestHash(safeRequest),
        idempotencyKeyHash: idemHash,
        previewRevision: 0,
        request: safeRequest,
        createdAt: this.now().toISOString(),
        updatedAt: this.now().toISOString(),
        steps: [],
      }
      operation.kind = 'create-and-schedule'
      operation.requestHash = requestHash(safeRequest)
      operation.request = safeRequest
      if (idemHash) operation.idempotencyKeyHash = idemHash
      operation.updatedAt = this.now().toISOString()

      const createStep = this.ensureCreateStep(operation, {
        businessKey: createKey,
        fingerprint: input.fingerprint,
      })
      if (createSatisfied && createStep.status === 'prepared') {
        createStep.status = 'skipped'
        createStep.evidence = 'none'
        createStep.workoutId = knownWorkoutId
        createStep.reference = {
          operationId: createVerdict.operation.operationId,
          stepId: createVerdict.step.stepId,
          status: createVerdict.step.status,
        }
      }

      const existingScheduleStep = scheduleKey
        ? operation.steps.find(step => step.businessKey === scheduleKey)
        : undefined
      if (scheduleKey && knownWorkoutId && !existingScheduleStep && scheduleVerdict.kind !== 'satisfied') {
        operation.steps.push({
          stepId: this.newStepId(),
          businessKey: scheduleKey,
          kind: 'schedule',
          status: 'prepared',
          attempt: 0,
          workoutId: knownWorkoutId,
          date: input.date,
          evidence: 'none',
          attempts: [],
        })
      }

      document.operations[operation.operationId] = operation
      if (idemHash) document.idempotencyIndex[idemHash] = operation.operationId
      const ownedKeys = [createKey, scheduleKey].filter((key): key is string => Boolean(key))
      this.supersedePreparedSteps(document, ownedKeys, operation.operationId)
      if (reused) this.advanceRevision(operation)
      this.issueRevision(operation)
      await this.persist(document)

      const previewSteps: SchedulePreviewStep[] = []
      if (createSatisfied) {
        previewSteps.push(this.previewStepFromExisting(
          operation.steps.find(step => step.businessKey === createKey) as WriteStep,
          operation,
        ))
      } else {
        previewSteps.push(this.toPreviewStep({ step: {}, businessKey: createKey, action: 'write' }, operation))
      }
      const appended = scheduleKey ? operation.steps.find(step => step.businessKey === scheduleKey) : undefined
      if (appended) previewSteps.push(this.toPreviewStep({ step: {}, businessKey: scheduleKey as string, action: 'write' }, operation))

      return {
        operationId: operation.operationId,
        requiresConfirmation: true,
        previewRevision: operation.previewRevision ?? 0,
        steps: previewSteps,
      }
    })
  }

  /**
   * Execute both phases of a confirmed create-and-schedule operation.
   *
   * The resolved workout id is read from the persisted create step (written by
   * the create dispatch itself) — it is never searched for, guessed, nor
   * re-created. If the create phase is not satisfied, the schedule phase is not
   * attempted at all, so an unknown create can never be followed by a schedule
   * for an id nobody recorded.
   */
  async executeCreateAndSchedule(
    confirmation: WriteConfirmation,
    writer: CreateAndScheduleWriter,
  ): Promise<ScheduleExecution> {
    return this.options.lock.runExclusive(async () => {
      const document = await this.options.store.read()
      const operationId = confirmation.operationId
      const operation = this.authorize(
        document,
        confirmation,
        'No local create-and-schedule operation matches this confirmation for this account',
      )
      const receipts: ScheduleStepReceipt[] = []

      const createStep = operation.steps.find(step => step.kind === 'create')
      if (!createStep) throw corrupt('Create-and-schedule operation has no create step')

      if (createStep.status === 'prepared') {
        if (!this.authorizeDispatch(operation)) {
          receipts.push(await this.refuseExpired(document, operation, createStep))
          return { operationId, receipts }
        }
        const blocker = await this.recheckBusinessKey(document, operation, createStep)
        if (blocker) {
          receipts.push(blocker)
          return { operationId, receipts }
        }
        await this.dispatchCreate(document, operation, createStep, writer)
      }
      receipts.push(this.receiptFor(operation, createStep))

      if (!SATISFIED_STEP_STATUSES.has(this.reportStatusOf(createStep))) {
        // The template is not proven present, so there is nothing safe to
        // schedule. No schedule step is created and no schedule is dispatched.
        return { operationId, receipts }
      }
      const resolvedWorkoutId = createStep.workoutId
      if (!resolvedWorkoutId) {
        throw corrupt('A satisfied create step is missing its resolved workoutId')
      }
      const date = operation.request.date
      if (typeof date !== 'string' || !date) {
        throw corrupt('Create-and-schedule operation has no canonical date')
      }
      const scheduleKey = scheduleBusinessKey(this.accountKey, resolvedWorkoutId, date)

      let scheduleStep = operation.steps.find(step => step.businessKey === scheduleKey)
      if (!scheduleStep) {
        const verdict = findStepByBusinessKeySafe(document, scheduleKey)
        scheduleStep = {
          stepId: this.newStepId(),
          businessKey: scheduleKey,
          kind: 'schedule',
          status: verdict.kind === 'satisfied' ? 'skipped' : verdict.kind === 'unresolved' ? 'not_attempted' : 'prepared',
          attempt: 0,
          workoutId: resolvedWorkoutId,
          date,
          evidence: 'none',
          attempts: [],
          ...(verdict.kind === 'absent' || verdict.kind === 'retryable'
            ? {}
            : {
                reference: {
                  operationId: verdict.operation.operationId,
                  stepId: verdict.step.stepId,
                  status: verdict.step.status,
                  workoutScheduleId: verdict.step.workoutScheduleId,
                  errorCode: verdict.step.errorCode,
                },
                ...(verdict.kind === 'unresolved'
                  ? { errorCode: verdict.step.errorCode ?? WRITE_ERROR_CODES.WRITE_OUTCOME_UNKNOWN }
                  : {}),
              }),
        }
        operation.steps.push(scheduleStep)
        operation.updatedAt = this.now().toISOString()
        await this.persist(document)
        if (verdict.kind === 'unresolved') {
          receipts.push(this.blockedReceipt(verdict.operation, scheduleStep))
          return { operationId, receipts }
        }
      }

      if (scheduleStep.status === 'prepared') {
        if (!this.authorizeDispatch(operation)) {
          receipts.push(await this.refuseExpired(document, operation, scheduleStep))
          return { operationId, receipts }
        }
        const blocker = await this.recheckBusinessKey(document, operation, scheduleStep)
        if (blocker) {
          receipts.push(blocker)
          return { operationId, receipts }
        }
        await this.dispatchSchedule(document, operation, scheduleStep, writer)
      }
      receipts.push(this.receiptFor(operation, scheduleStep))
      return { operationId, receipts }
    })
  }

  /**
   * Shared "same idempotency key, same canonical request" re-preview.
   *
   * A preview is not a write, and a confirmation that was never confirmed — or
   * one whose window closed, or one whose batch halted before this entry — must
   * not wedge the target forever. Those steps are `prepared`, `not_attempted`
   * or `failed` (proven not applied), so a *new* confirmation may arm them
   * again; the attempt history is preserved and the revision is advanced, which
   * invalidates every earlier handle in this process and in any other one.
   *
   * Everything else keeps its durable receipt: a `succeeded`/`skipped` step is
   * already done, and an `in_flight`/`unknown` step must never mint fresh write
   * authority. Both cases return `requiresConfirmation:false`, so a caller can
   * only ever re-dispatch work the journal proves was never sent.
   */
  private async reshowOrAdvance(
    document: OperationDocument,
    existing: WriteOperation,
  ): Promise<SchedulePreview> {
    const rearmable = existing.steps.filter(step =>
      this.canRearm(document, existing.operationId, step))

    if (rearmable.length === 0) {
      return {
        operationId: existing.operationId,
        existingOperationId: existing.operationId,
        requiresConfirmation: false,
        steps: existing.steps.map(step => this.previewStepFromExisting(step, existing)),
      }
    }

    // Re-arming keeps the stepId, the attempt counter and the whole attempt
    // history: the record must still show that nothing was ever sent, and a
    // later replay of the same key must find this operation rather than mint a
    // second one for the same target. The operation's `request` and
    // `requestHash` are not mutated either, so the caller's original intent
    // survives re-previews.
    for (const step of rearmable) {
      step.status = REBUILDABLE_STEP_STATUS
      step.evidence = 'none'
      delete step.errorCode
      delete step.reference
    }
    this.advanceRevision(existing)
    this.issueRevision(existing)
    existing.updatedAt = this.now().toISOString()
    await this.persist(document)
    return {
      operationId: existing.operationId,
      existingOperationId: existing.operationId,
      requiresConfirmation: true,
      previewRevision: existing.previewRevision,
      steps: existing.steps.map(step => this.previewStepFromExisting(step, existing, true)),
    }
  }

  /**
   * May this step be returned to `prepared`?
   *
   * Two facts must hold, and both are read from the journal rather than
   * inferred:
   *
   *   1. the status proves nothing was ever sent — `prepared` (never
   *      dispatched), `failed` (`not_applied` evidence) or `not_attempted` (the
   *      batch halted, or the revision had expired, before the POST);
   *   2. no *other* record claims the same business key. Any other record —
   *      `prepared` from a newer preview, `unknown` from a lost response,
   *      `succeeded` from someone else's write — makes this step's authority
   *      ambiguous, and ambiguity must never arm a dispatch.
   */
  private canRearm(
    document: OperationDocument,
    operationId: string,
    step: WriteStep,
  ): boolean {
    if (step.status !== REBUILDABLE_STEP_STATUS && !RETRYABLE_STEP_STATUSES.has(step.status)) {
      return false
    }
    for (const candidate of Object.values(document.operations)) {
      for (const other of candidate.steps) {
        if (candidate.operationId === operationId && other.stepId === step.stepId) continue
        if (other.businessKey !== step.businessKey) continue
        return false
      }
    }
    return true
  }

  /** Create phase step, created once per operation. */
  private ensureCreateStep(
    operation: WriteOperation,
    input: { businessKey: string; fingerprint: string },
  ): WriteStep {
    const existing = operation.steps.find(step => step.kind === 'create')
    if (existing) return existing
    const step: WriteStep = {
      stepId: this.newStepId(),
      businessKey: input.businessKey,
      kind: 'create',
      status: 'prepared',
      attempt: 0,
      evidence: 'none',
      attempts: [],
      fingerprint: input.fingerprint,
    }
    // The create phase always precedes the schedule phase.
    operation.steps.unshift(step)
    return step
  }

  /**
   * The workout id a satisfied create step recorded, from the whole journal.
   * Used by the preview to compute the schedule-phase business key without
   * ever calling Garmin.
   */
  private resolvedCreateWorkoutId(document: OperationDocument, createKey: string): string | undefined {
    for (const operation of Object.values(document.operations)) {
      for (const step of operation.steps) {
        if (step.kind !== 'create') continue
        if (step.businessKey !== createKey) continue
        if (step.workoutId) return step.workoutId
      }
    }
    return undefined
  }

  /**
   * The status a receipt will report, resolving the read-only reference a
   * non-writable step pins to its blocker / satisfaction holder.
   */
  private reportStatusOf(step: WriteStep): StepStatus {
    return step.reference?.status ?? step.status
  }

  /** Refresh the deadline that authorizes a *new* dispatch from this revision. */
  private issueRevision(operation: WriteOperation): void {
    operation.confirmationExpiresAt = new Date(this.now().getTime() + CONFIRMATION_TTL_MS).toISOString()
  }

  /**
   * Advance the revision of a *reused* operation before handing out a new
   * confirmation.
   *
   * Re-previewing a request that has not been dispatched reuses the
   * operationId, so one business key keeps exactly one journal record, but the
   * approval itself must be re-minted: bumping `previewRevision` invalidates
   * every confirmationId issued by an earlier preview, in this process or any
   * other one. Otherwise two previews of the same key would both appear
   * authorized and a caller could dispatch from the stale one.
   */
  private advanceRevision(operation: WriteOperation): void {
    operation.previewRevision = (operation.previewRevision ?? 0) + 1
  }

  /**
   * Re-check the business key inside the lock, immediately before dispatching.
   * Returns a receipt when the write must not happen, `undefined` when the
   * dispatch is allowed. Uses whole-history aggregation, never a first match.
   */
  private async recheckBusinessKey(
    document: OperationDocument,
    operation: WriteOperation,
    step: WriteStep,
  ): Promise<ScheduleStepReceipt | undefined> {
    const holder = findStepByBusinessKeySafe(document, step.businessKey)
    if (holder.kind === 'absent' || holder.step.stepId === step.stepId) return undefined
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
      return this.blockedReceipt(holder.operation, step)
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
      if (step.kind === 'create' && holder.step.workoutId) step.workoutId = holder.step.workoutId
      await this.persist(document)
      return this.receiptFor(operation, step)
    }
    return undefined
  }

  /** The canonical workout definition persisted for a create operation. */
  private definitionOf(operation: WriteOperation): Record<string, unknown> {
    const definition = operation.request.definition
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
      throw corrupt('Create operation has no canonical workout definition')
    }
    return definition as Record<string, unknown>
  }

  /** Mark in_flight, persist, dispatch exactly once, persist the outcome. */
  private async dispatchCreate(
    document: OperationDocument,
    operation: WriteOperation,
    step: WriteStep,
    writer: CreateWriter,
  ): Promise<void> {
    this.beginAttempt(document, operation, step)
    await this.persist(document)
    try {
      const result = await writer.addWorkout(this.definitionOf(operation))
      const assigned = usableWorkoutId(result?.workoutId)
      if (assigned === undefined) {
        // The request was accepted but no usable id came back, so the
        // template may well exist and we cannot name it. Recording success
        // here would let the schedule phase run against an invented id, and
        // recording a proven failure would invite a blind re-create. The only
        // honest state is `unknown`: keep the unresolved outcome, never guess
        // the id, never create a second template.
        step.status = 'unknown'
        step.evidence = 'none'
        step.errorCode = WRITE_ERROR_CODES.WRITE_OUTCOME_UNKNOWN
        this.finishAttempt(step, 'unknown', WRITE_ERROR_CODES.WRITE_OUTCOME_UNKNOWN)
      } else {
        step.status = 'succeeded'
        step.evidence = 'response'
        step.workoutId = assigned
        step.errorCode = undefined
        this.finishAttempt(step, 'succeeded')
      }
    } catch (error) {
      this.recordFailure(step, error)
    }
    operation.updatedAt = this.now().toISOString()
    await this.persist(document)
  }

  private async dispatchSchedule(
    document: OperationDocument,
    operation: WriteOperation,
    step: WriteStep,
    writer: CalendarWriter,
  ): Promise<void> {
    this.beginAttempt(document, operation, step)
    await this.persist(document)
    try {
      const result = await writer.schedule(step.workoutId as string, step.date as string)
      step.status = 'succeeded'
      step.evidence = 'response'
      step.workoutScheduleId = result?.workoutScheduleId ?? null
      step.errorCode = undefined
      this.finishAttempt(step, 'succeeded')
    } catch (error) {
      this.recordFailure(step, error)
    }
    operation.updatedAt = this.now().toISOString()
    await this.persist(document)
  }

  private async dispatchUnschedule(
    document: OperationDocument,
    operation: WriteOperation,
    step: WriteStep,
    writer: UnscheduleWriter,
  ): Promise<void> {
    this.beginAttempt(document, operation, step)
    await this.persist(document)
    try {
      await writer.unschedule(step.workoutScheduleId as string)
      step.status = 'succeeded'
      step.evidence = 'response'
      step.errorCode = undefined
      this.finishAttempt(step, 'succeeded')
    } catch (error) {
      this.recordFailure(step, error)
    }
    operation.updatedAt = this.now().toISOString()
    await this.persist(document)
  }

  private beginAttempt(document: OperationDocument, operation: WriteOperation, step: WriteStep): void {
    step.status = 'in_flight'
    step.attempt += 1
    step.dispatchedAt = this.now().toISOString()
    step.attempts.push({
      attempt: step.attempt,
      outcome: 'in_flight',
      startedAt: step.dispatchedAt,
    })
    operation.updatedAt = this.now().toISOString()
    void document
  }

  /**
   * Re-check account-lock ownership between entries.
   *
   * A lock implementation that cannot report ownership (a mutual-exclusion-only
   * double) is treated as still owned: we have no evidence of loss, and holding
   * the lock for the whole batch is the conservative default. A check that
   * throws is treated as lost, because an unreadable owner record cannot prove
   * anything and stopping is the safe direction.
   */
  private async stillHoldsLock(): Promise<boolean> {
    const lock = this.options.lock
    if (typeof lock.verifyOwned !== 'function') return true
    try {
      return await lock.verifyOwned()
    } catch {
      return false
    }
  }

  /** A definite non-application is `failed`; anything else stays `unknown`. */
  private recordFailure(step: WriteStep, error: unknown): boolean {
    const { outcome, code } = classifyWriteFailure(error)
    step.status = outcome === 'not_applied' ? 'failed' : 'unknown'
    step.evidence = 'none'
    step.errorCode = code
    this.finishAttempt(step, step.status === 'unknown' ? 'unknown' : 'failed', code)
    return isAccountLevelWriteFailure(error)
  }

  /**
   * Record a not-dispatched entry because the batch already halted, and return
   * its receipt. The step stays retryable: `not_attempted` proves nothing was
   * sent, so a later confirmed attempt may still perform it.
   */
  private async haltStep(
    document: OperationDocument,
    operation: WriteOperation,
    step: WriteStep,
    halt: HaltReason,
  ): Promise<ScheduleStepReceipt> {
    step.status = 'not_attempted'
    step.evidence = 'none'
    step.errorCode = halt.code
    step.reference = {
      operationId: operation.operationId,
      stepId: halt.cause.stepId,
      status: halt.cause.reference?.status ?? halt.cause.status,
      workoutScheduleId: halt.cause.workoutScheduleId,
      errorCode: halt.cause.errorCode ?? halt.code,
    }
    operation.updatedAt = this.now().toISOString()
    const journaled = await this.persistQuietly(document)
    const receipt = this.receiptFor(operation, step)
    return {
      ...receipt,
      // The durable status is `not_attempted`, and so is the reported one: this
      // entry provably never reached the network, so it must be counted as
      // `not_attempted` (retryable) rather than inheriting the blocker's
      // `unknown`. Only the blocker needs manual review.
      status: 'not_attempted',
      success: false,
      desiredStateSatisfied: false,
      evidence: 'none',
      // Never inherit the blocker's calendar id: this entry holds no Garmin
      // object of its own, and reporting someone else's id under this stepId
      // would make the receipt unreadable.
      workoutScheduleId: null,
      errorCode: halt.code,
      canResume: true,
      manualReviewRequired: false,
      nextAction:
        `This entry was not attempted because the batch stopped (${halt.reason}) at step ` +
        `${halt.cause.stepId}${halt.cause.errorCode ? ` (${halt.cause.errorCode})` : ''}. ` +
        'Resolve or reconcile that blocker, then preview and confirm this entry again.',
      ...(journaled
        ? {}
        : {
            message:
              'This entry was not attempted and nothing was sent to Garmin, but the local journal ' +
              'could not record that fact. Restore write access to the state directory before resuming.',
          }),
    }
  }

  /**
   * Persist a halt receipt, but never discard the batch report over it.
   *
   * By the time this runs the batch has already stopped, so these entries
   * provably never reached the network. Letting a local state failure escape
   * here would throw away the operationId and the receipts of the entries that
   * *did* run — exactly the recovery identifier the caller must keep — so the
   * failure is reported through the receipt instead (C5: "最终落盘失败 ... 不
   * 丢失 operationId").
   *
   * Only `GarminWriteError` from the store is absorbed; a programming error is
   * still a bug and must surface.
   *
   * The revision is rolled back on failure so the in-memory document keeps
   * matching the last durable revision. Without that, every later save in this
   * batch would be refused as a stale write and turn into a `STATE_CORRUPT`.
   */
  private async persistQuietly(document: OperationDocument): Promise<boolean> {
    const expected = document.revision
    document.revision = expected + 1
    try {
      await this.options.store.save(document, { expectedRevision: expected })
      return true
    } catch (error) {
      document.revision = expected
      if (error instanceof GarminWriteError) return false
      throw error
    }
  }

  /**
   * Persist, and turn a local state failure into a receipt instead of throwing.
   *
   * Losing this error would leave the caller without the operationId it needs
   * to reconcile. Returning `undefined` means the record was durably written.
   */
  private async persistOrReport(
    document: OperationDocument,
    operation: WriteOperation,
    step: WriteStep,
    phase: 'before' | 'after',
  ): Promise<ScheduleStepReceipt | undefined> {
    try {
      await this.persist(document)
      return undefined
    } catch (error) {
      if (!(error instanceof GarminWriteError) || error.code !== WRITE_ERROR_CODES.STATE_UNAVAILABLE) {
        throw error
      }
      const base = this.receiptFor(operation, step)
      return {
        ...base,
        // Before the dispatch nothing was sent, so this entry is a proven
        // non-application. After it, the durable record is still the
        // pre-dispatch `in_flight` marker, so the honest status is unknown.
        status: phase === 'before' ? 'failed' : 'unknown',
        success: false,
        desiredStateSatisfied: false,
        evidence: phase === 'before' ? 'none' : base.evidence,
        errorCode: WRITE_ERROR_CODES.STATE_UNAVAILABLE,
        canResume: false,
        manualReviewRequired: phase === 'after',
        nextAction:
          phase === 'before'
            ? 'Restore write access to the local state directory; this entry provably was not sent and can be confirmed again.'
            : 'Restore write access to the local state directory, then reconcile this operation: the calendar write was sent but its outcome could not be recorded.',
        message:
          phase === 'before'
            ? 'The local write journal could not be updated, so nothing was sent to Garmin.'
            : 'Garmin may have applied this write, but the local journal could not record the outcome.',
      }
    }
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

  /**
   * Resolve a confirmed approval against the persisted journal.
   *
   * Three independent things must still hold at dispatch time, and all three
   * are checked from disk rather than from process memory, so a confirmation
   * behaves identically in the process that issued it and in one that started
   * later:
   *   1. the operation exists for this account,
   *   2. its request hash is unchanged (the previewed payload is the approved one),
   *   3. its preview revision matches the handle (a re-preview invalidated it).
   */
  private authorize(
    document: OperationDocument,
    confirmation: WriteConfirmation,
    notFoundDetail: string,
  ): WriteOperation {
    const operation = document.operations[confirmation.operationId]
    if (!operation) {
      throw new GarminWriteError(WRITE_ERROR_CODES.OPERATION_NOT_FOUND, 'not_applied', notFoundDetail)
    }
    if (operation.requestHash !== confirmation.requestHash) {
      throw new GarminWriteError(
        WRITE_ERROR_CODES.CONFIRMATION_INVALID,
        'not_applied',
        'The confirmed operation changed after the preview; request a new preview',
      )
    }
    if ((operation.previewRevision ?? 0) !== confirmation.previewRevision) {
      throw new GarminWriteError(
        WRITE_ERROR_CODES.CONFIRMATION_STALE,
        'not_applied',
        'This confirmation was superseded by a newer preview; request a new preview',
      )
    }
    return operation
  }

  /** Authorize this revision to dispatch a *new* write right now. */
  private authorizeDispatch(operation: WriteOperation): boolean {
    const expiresAt = operation.confirmationExpiresAt
    if (!expiresAt) return true
    return Date.parse(expiresAt) > this.now().getTime()
  }

  /**
   * Refuse a dispatch that this revision may no longer authorize. The step is
   * left `not_attempted` (proven not applied) with an actionable reason, so a
   * later `resume_garmin_write_operation` can pick it up after a fresh preview.
   */
  private async refuseExpired(
    document: OperationDocument,
    operation: WriteOperation,
    step: WriteStep,
  ): Promise<ScheduleStepReceipt> {
    step.status = 'not_attempted'
    step.evidence = 'none'
    step.errorCode = WRITE_ERROR_CODES.CONFIRMATION_STALE
    operation.updatedAt = this.now().toISOString()
    await this.persist(document)
    return this.receiptFor(operation, step)
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
    decision: ScheduleDecision,
    operation?: WriteOperation,
  ): SchedulePreviewStep {
    if (decision.found) {
      const stepKind = (decision.found.step.kind === 'create' || decision.found.step.kind === 'unschedule' || decision.found.step.kind === 'batch-schedule')
        ? decision.found.step.kind
        : 'schedule'
      return {
        stepId: decision.found.step.stepId,
        workoutId: (decision.step.workoutId as string) ?? decision.found.step.workoutId ?? '',
        date: (decision.step.date as string) ?? decision.found.step.date ?? '',
        kind: stepKind,
        workoutScheduleId: decision.found.step.workoutScheduleId ?? undefined,
        action: decision.action,
        status: decision.found.step.status,
        operationId: decision.found.operation.operationId,
        resolvedWorkoutId: decision.found.step.workoutId,
        errorCode: decision.action === 'blocked'
          ? decision.found.step.errorCode ?? WRITE_ERROR_CODES.WRITE_OUTCOME_UNKNOWN
          : undefined,
        reason: decision.action === 'blocked' ? BLOCKED_REASON : SKIP_REASON,
      }
    }
    const step = operation?.steps.find(candidate => candidate.businessKey === decision.businessKey)
    return {
      stepId: step?.stepId ?? '',
      workoutId: (decision.step.workoutId as string) ?? '',
      date: (decision.step.date as string) ?? '',
      kind: step?.kind === 'create' || step?.kind === 'unschedule' ? step.kind : 'schedule',
      workoutScheduleId: step?.workoutScheduleId ?? undefined,
      action: decision.action,
      status: step?.status ?? 'prepared',
      operationId: operation?.operationId,
      resolvedWorkoutId: step?.workoutId,
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

  /**
   * Project an existing journal step into a `SchedulePreviewStep` for the
   * re-preview path. The action is derived from the journal status, not from
   * a fresh write, so a re-issued confirmation never claims a fresh write
   * for an already-satisfied target.
   */
  private previewStepFromExisting(
    step: WriteStep,
    existing: WriteOperation,
    reshowingPrepared = false,
  ): SchedulePreviewStep {
    if (reshowingPrepared && step.status === 'prepared') {
      return {
        stepId: step.stepId,
        workoutId: step.workoutId ?? '',
        date: step.date ?? '',
        kind: step.kind,
        workoutScheduleId: step.workoutScheduleId ?? undefined,
        action: 'write',
        status: step.status,
        operationId: existing.operationId,
        resolvedWorkoutId: step.workoutId,
      }
    }
    if (SATISFIED_STEP_STATUSES.has(step.status)) {
      return {
        stepId: step.stepId,
        workoutId: step.workoutId ?? '',
        date: step.date ?? '',
        kind: step.kind,
        workoutScheduleId: step.workoutScheduleId ?? undefined,
        action: 'skip_existing',
        status: step.status,
        operationId: existing.operationId,
        resolvedWorkoutId: step.workoutId,
        reason: SKIP_REASON,
      }
    }
    return {
      stepId: step.stepId,
      workoutId: step.workoutId ?? '',
      date: step.date ?? '',
      kind: step.kind,
      workoutScheduleId: step.workoutScheduleId ?? undefined,
      action: 'blocked',
      status: step.status,
      operationId: existing.operationId,
      resolvedWorkoutId: step.workoutId,
      errorCode: step.errorCode ?? WRITE_ERROR_CODES.WRITE_OUTCOME_UNKNOWN,
      reason: BLOCKED_REASON,
    }
  }
}

function corrupt(detail: string): GarminWriteError {
  return new GarminWriteError(WRITE_ERROR_CODES.STATE_CORRUPT, 'not_applied', detail)
}

/**
 * Accept only an identifier that can be handed back to Garmin later.
 *
 * A missing, empty, `null`, or object-valued id is NOT usable: the template
 * may exist but cannot be addressed. Treating it as success would let the
 * schedule phase run against an invented id; treating it as a proven failure
 * would invite a blind re-create. `undefined` here means "unresolved".
 */
function usableWorkoutId(value: unknown): string | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : undefined
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 && trimmed.length <= 256 ? trimmed : undefined
  }
  return undefined
}

/**
 * Strip caller-supplied metadata (the raw idempotencyKey) before persisting
 * the request. The hash is kept separately on the operation, and the same
 * helper is used by the v1 -> v2 journal migration so persisted requests and
 * freshly previewed requests always agree on what the canonical payload is.
 */

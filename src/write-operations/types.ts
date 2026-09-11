/**
 * Persistent write-operation model.
 *
 * These types describe the local, account-scoped journal that makes an
 * uncertain Garmin write recoverable without ever replaying it. Nothing here
 * talks to the network; the store and coordinator own that.
 */

export type WriteKind =
  | 'create'
  | 'schedule'
  | 'unschedule'
  | 'create-and-schedule'
  | 'batch-schedule'

export type StepStatus =
  | 'prepared'
  | 'in_flight'
  | 'succeeded'
  | 'skipped'
  | 'failed'
  | 'unknown'
  | 'not_attempted'

/**
 * How a step's outcome became known. `response` is a direct Garmin write
 * receipt; `observed_present` / `observed_absent` come from a later read-only
 * check and never prove that this request caused the change; `none` means no
 * evidence at all.
 */
export type WriteEvidence =
  | 'response'
  | 'observed_present'
  | 'observed_absent'
  | 'none'

export interface WriteAttempt {
  attempt: number
  outcome: 'in_flight' | 'succeeded' | 'failed' | 'unknown'
  startedAt: string
  finishedAt?: string
  errorCode?: string
}

export interface WriteStep {
  stepId: string
  businessKey: string
  kind: 'create' | 'schedule' | 'unschedule'
  status: StepStatus
  attempt: number
  dispatchedAt?: string
  workoutId?: string
  workoutScheduleId?: string | null
  date?: string
  evidence: WriteEvidence
  errorCode?: string
  desiredStateSatisfied?: boolean
  observedAt?: string
  attempts: WriteAttempt[]
  /**
   * A read-only reference to a step in another operation that explains why
   * this step is in a non-write state. The original blocker (unknown /
   * succeeded / etc.) is never duplicated; the new step is anchored to it.
   */
  reference?: {
    operationId: string
    stepId: string
    status: StepStatus
    workoutScheduleId?: string | null
    errorCode?: string
  }
}

export interface WriteOperation {
  schemaVersion: 1
  operationId: string
  kind: WriteKind
  accountKey: string
  requestHash: string
  idempotencyKeyHash?: string
  /**
   * Monotonic counter advanced every time a preview is re-issued for the same
   * operation without dispatch. ConfirmationIds are bound to the
   * previewRevision at issue time; old confirmations are invalidated when the
   * counter moves. Optional in the on-disk type so older journals (or test
   * fixtures) without the field continue to parse; readers must default to 0.
   */
  previewRevision?: number
  request: Record<string, unknown>
  createdAt: string
  updatedAt: string
  steps: WriteStep[]
}

/** On-disk journal for one account. `revision` guards atomic replacement. */
export interface OperationDocument {
  schemaVersion: 1
  revision: number
  accountKey: string
  operations: Record<string, WriteOperation>
  /** idempotencyKeyHash -> operationId */
  idempotencyIndex: Record<string, string>
}

/** A non-network store. Implementations must fail closed on any doubt. */
export interface OperationStore {
  read(): Promise<OperationDocument>
  save(document: OperationDocument): Promise<void>
}

export function emptyOperationDocument(accountKey: string): OperationDocument {
  return {
    schemaVersion: 1,
    revision: 0,
    accountKey,
    operations: {},
    idempotencyIndex: {},
  }
}

/**
 * Statuses that hard-block a business key: nothing new may ever be dispatched
 * for the same key while one of these is present, across previews, idempotency
 * keys, tools, processes and restarts. `unknown` stays here permanently unless
 * evidence proves the write did not apply.
 */
export const BLOCKING_STEP_STATUSES: ReadonlySet<StepStatus> = new Set<StepStatus>([
  'in_flight',
  'unknown',
])

/**
 * `prepared` never dispatched: the caller may re-preview and re-confirm, reusing
 * the same operationId and advancing the preview revision. It does not permit a
 * brand-new write until a fresh confirmation exists.
 */
export const REBUILDABLE_STEP_STATUS: StepStatus = 'prepared'

/** Statuses proven not to have applied, so a new confirmed attempt is allowed. */
export const RETRYABLE_STEP_STATUSES: ReadonlySet<StepStatus> = new Set<StepStatus>([
  'failed',
  'not_attempted',
])

/** Statuses that describe a target the server considers already satisfied. */
export const SATISFIED_STEP_STATUSES: ReadonlySet<StepStatus> = new Set<StepStatus>([
  'succeeded',
  'skipped',
])

export function findStepByBusinessKey(
  document: OperationDocument,
  businessKey: string,
): { operation: WriteOperation; step: WriteStep } | undefined {
  for (const operation of Object.values(document.operations)) {
    const step = operation.steps.find(candidate => candidate.businessKey === businessKey)
    if (step) return { operation, step }
  }
  return undefined
}

/**
 * Per-step verdict derived from a business key's full history, in priority order:
 *   1. Any in_flight step (other or self) is unresolved.
 *   2. Any unknown step proves the write may have reached Garmin.
 *   3. A succeeded step is the durable receipt for this target.
 *   4. A skipped step is the durable "already satisfied by another path" receipt.
 *   5. Otherwise the most recent failed / not_attempted / prepared wins.
 *
 * The function intentionally does not look at operation insertion order; the
 * first hit in `Object.values(document.operations)` is allowed to be a stale
 * `not_attempted` and must never authorize a fresh dispatch.
 */
export type BusinessHistoryVerdict =
  | { kind: 'unresolved'; operation: WriteOperation; step: WriteStep }
  | { kind: 'satisfied'; operation: WriteOperation; step: WriteStep }
  | { kind: 'retryable'; operation: WriteOperation; step: WriteStep }
  | { kind: 'absent' }

export function collectBusinessHistory(
  document: OperationDocument,
  businessKey: string,
): BusinessHistoryVerdict {
  let blockingHit: { operation: WriteOperation; step: WriteStep } | undefined
  let satisfiedHit: { operation: WriteOperation; step: WriteStep } | undefined
  let retryableHit: { operation: WriteOperation; step: WriteStep } | undefined

  for (const operation of Object.values(document.operations)) {
    for (const step of operation.steps) {
      if (step.businessKey !== businessKey) continue
      if (BLOCKING_STEP_STATUSES.has(step.status)) {
        // In_flight or unknown: never look past this. Even if a later record
        // is "succeeded", we may be observing a duplicate identity, not the
        // post-recovery state.
        return { kind: 'unresolved', operation, step }
      }
      if (!satisfiedHit && SATISFIED_STEP_STATUSES.has(step.status)) {
        satisfiedHit = { operation, step }
        continue
      }
      if (!retryableHit && RETRYABLE_STEP_STATUSES.has(step.status)) {
        retryableHit = { operation, step }
      }
      // prepared steps are treated as retryable too, but the explicit rule in
      // the spec means we prefer the explicit retryable statuses when both
      // exist. We still need a fallback that picks a prepared step if no
      // failed/not_attempted is present.
      if (!retryableHit && step.status === 'prepared') {
        retryableHit = { operation, step }
      }
    }
  }

  if (blockingHit) return { kind: 'unresolved', ...blockingHit }
  if (satisfiedHit) return { kind: 'satisfied', ...satisfiedHit }
  if (retryableHit) return { kind: 'retryable', ...retryableHit }
  return { kind: 'absent' }
}

/**
 * The single source of truth for whether a new dispatch is allowed for this
 * business key. Returns the strongest verdict collected from history. The
 * `operation` field is the source of `operationId` to report to the caller;
 * it is NOT a permission to mutate a different operation than the one
 * currently being authored.
 */
export function findStepByBusinessKeySafe(
  document: OperationDocument,
  businessKey: string,
): BusinessHistoryVerdict {
  return collectBusinessHistory(document, businessKey)
}

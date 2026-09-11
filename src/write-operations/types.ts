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
}

export interface WriteOperation {
  schemaVersion: 1
  operationId: string
  kind: WriteKind
  accountKey: string
  requestHash: string
  idempotencyKeyHash?: string
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

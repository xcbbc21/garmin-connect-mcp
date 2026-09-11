import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GarminRegion } from './config'
import { exportFitFromZip, fitAccountOutputDirectory } from './fit-export'
import type { ActivityDetail } from './utils/format'
import {
  RUNNING_SKILLS,
  TRAINING_PHILOSOPHIES,
  findSkills,
  findTrainingPhilosophies,
  formatSkillCard,
  formatSkillSummary,
  formatTrainingPhilosophy,
} from './knowledge/running-skills'
import type {
  CoachingLanguage,
  TrainingPhilosophy,
} from './knowledge/running-skills'
import {
  buildGarminWorkout,
  validateWorkoutDef,
} from './knowledge/workout-schema'
import type { WorkoutDef } from './knowledge/workout-schema'
import { PublicToolError } from './utils/errors'
import { parseLocalDate } from './utils/date'
import { resolveStateDirectory } from './config'
import { WriteCoordinator } from './write-operations/coordinator'
import type {
  DuplicatePolicy,
  ReconcileReport,
  ResumePreview,
  ScheduleExecution,
  ScheduleStepReceipt,
  UnifiedCalendarWriter,
  WriteConfirmation,
} from './write-operations/coordinator'
import {
  CalendarCapabilityError,
  CalendarRangeError,
} from './calendar/types'
import type { CalendarSnapshot, CalendarRange } from './calendar/types'
import {
  MAX_CALENDAR_RANGE_DAYS,
  calendarDayCount,
  isValidCalendarDate,
} from './calendar/adapter'
import type { CalendarLookup } from './write-operations/reconcile'
import { FileAccountLock } from './write-operations/lock'
import { GarminWriteError, WRITE_ERROR_CODES, isGarminWriteError } from './write-operations/errors'
import { FileOperationStore } from './write-operations/store'
import {
  accountKey as deriveAccountKey,
  assertIdempotencyKey,
  createBusinessKey,
  decodeConfirmationId,
  encodeConfirmationId,
  requestHash,
  unscheduleBusinessKey,
  workoutDefinitionFingerprint,
} from './write-operations/identity'
import type { OperationStore } from './write-operations/store'
import { SATISFIED_STEP_STATUSES } from './write-operations/types'
import type { WriteOperation } from './write-operations/types'
import type { AccountLock } from './write-operations/lock'
import {
  formatActivity,
  formatHeartRate,
  formatProfile,
  formatSleep,
  formatSteps,
  formatWeight,
  formatWorkout,
} from './utils/format'

export interface GarminDataClient {
  getActivities(start?: number, limit?: number): Promise<unknown[]>
  getSleep(date: string): Promise<unknown>
  getSteps(date: string): Promise<unknown>
  getHeartRate(date: string): Promise<unknown>
  getWeight(date: string): Promise<unknown>
  getWorkouts(start?: number, limit?: number): Promise<unknown[]>
  getWorkoutDetail(workoutId: string): Promise<unknown>
  downloadOriginalActivityZip(activityId: number, destinationDir: string): Promise<string>
  addWorkout(workout: Record<string, unknown>): Promise<Record<string, unknown>>
  scheduleWorkout(workoutId: string, date: string): Promise<Record<string, unknown>>
  unscheduleWorkout(workoutScheduleId: string): Promise<void>
  getUserProfile(): Promise<unknown>
  /**
   * Fresh Garmin Calendar read. Optional on the type on purpose: a client
   * without a verified read capability is expressible, and its absence blocks
   * new writes instead of being treated as an empty calendar.
   */
  getCalendarRange?(range: CalendarRange): Promise<CalendarSnapshot>
}

export interface GarminToolServiceOptions {
  activityDetail: ActivityDetail
  fitDownloadDir: string
  accountUsername: string
  accountRegion: GarminRegion
  /**
   * Aborted when the owning process is shutting down.
   *
   * A cancellation only means this process will not send the *next* entry: it
   * is never proof that Garmin rolled anything back, so already-dispatched
   * entries keep whatever real outcome they reported.
   */
  shutdownSignal?: AbortSignal
  /**
   * Absolute directory for the account-scoped write journal and lock. When
   * omitted the platform default is resolved; it is never in-memory.
   */
  stateDirectory?: string
  /**
   * The calendar *reader* handed to the coordinator for preflight, reconcile
   * and resume. It is deliberately a separate seam from the writer: the type
   * has no schedule/create/unschedule method, so nothing on the read path can
   * hide a re-send. When omitted, a client that implements `getCalendarRange`
   * is used; when neither exists, writes are refused rather than sent blind.
   */
  calendarReader?: CalendarLookup
  /** Test seams: injected store/lock and deterministic ids/clock. */
  operationStore?: OperationStore
  accountLock?: AccountLock
  now?: () => Date
  newOperationId?: () => string
  newStepId?: () => string
}

export interface DateRangeArgs {
  startDate?: string
  endDate?: string
}

/**
 * An inclusive calendar-range query.
 *
 * `startDate`/`endDate` are required by the tool schema; they stay optional on
 * the type so the service can be called with a partial object and answer with
 * a validation error instead of a type-level crash.
 */
export interface CalendarRangeArgs {
  startDate?: string
  endDate?: string
  /** IANA label echoed on the snapshot. It never shifts a date. */
  timezone?: string
}

/** Paging arguments for a local journal listing. */
export interface WriteOperationPageArgs {
  limit?: number
  /**
   * Opaque token from a previous listing's `nextCursor`. It names a position in
   * a *specific* journal state, never a filesystem path.
   */
  cursor?: string
}

export interface ActivityArgs {
  limit?: number
  offset?: number
  detail?: ActivityDetail
}

export interface PaginationArgs {
  limit?: number
  offset?: number
}

export const RUNNING_ADVICE_MODES = ['explain', 'personalized'] as const
export const PERFORMANCE_BASES = [
  'recent_race',
  'time_trial',
  'no_recent_benchmark',
] as const
export const TRAINING_LOAD_PREFERENCES = ['steady', 'hard_easy', 'mixed'] as const
export const INTENSITY_GUIDANCE_PREFERENCES = [
  'pace',
  'heart_rate',
  'rpe',
  'mixed',
] as const
export const RUNNING_INTAKE_MIN_LENGTHS = {
  goal: 4,
  currentPerformance: 4,
  trainingBackground: 8,
  availability: 4,
  healthConstraints: 2,
} as const

export interface RunningAdviceArgs {
  mode: typeof RUNNING_ADVICE_MODES[number]
  query?: string
  includeRecentActivities?: boolean
  language?: CoachingLanguage
  goal?: string
  currentPerformance?: string
  performanceBasis?: typeof PERFORMANCE_BASES[number]
  trainingBackground?: string
  availability?: string
  healthConstraints?: string
  hasWarningSymptoms?: boolean
  trainingPreference?: typeof TRAINING_LOAD_PREFERENCES[number]
  maxQualitySessionsPerWeek?: number
  intensityGuidancePreference?: typeof INTENSITY_GUIDANCE_PREFERENCES[number]
}

export const RUNNING_INTAKE_FIELDS = [
  'goal',
  'currentPerformance',
  'performanceBasis',
  'trainingBackground',
  'availability',
  'healthConstraints',
  'hasWarningSymptoms',
  'trainingPreference',
  'maxQualitySessionsPerWeek',
  'intensityGuidancePreference',
] as const

export type RunningIntakeField = typeof RUNNING_INTAKE_FIELDS[number]

export interface RunningIntakeResult {
  requiresUserInput: true
  missingFields: RunningIntakeField[]
  questions: Array<{ field: RunningIntakeField; question: string }>
  instruction: string
}

export interface RunningAdviceResult extends Record<string, unknown> {
  requiresUserInput: false
  mode: 'explain' | 'personalized'
  matchedSkills: Array<Record<string, unknown>>
  trainingPhilosophies: Array<Record<string, unknown>>
  totalSkillsInKB: number
  totalPhilosophiesInKB: number
  evidenceLegend: Record<string, string>
  athleteContext?: Record<string, string | number | boolean>
  planningInstructions?: string[]
  recentRunningActivities?: unknown
}

export interface RunningSafetyStopResult {
  requiresUserInput: false
  mode: 'personalized'
  safetyStop: true
  instruction: string
}

export type RunningAdviceResponse =
  | RunningIntakeResult
  | RunningAdviceResult
  | RunningSafetyStopResult

export interface DownloadActivityFitArgs {
  activityId: number
}

export interface DownloadActivityFitResult {
  success: true
  activityId: number
  fileName: string
  sizeBytes: number
  sha256: string
}

export type CreateWorkoutArgs = WorkoutDef & {
  confirmed?: boolean
  confirmationId?: string
  idempotencyKey?: string
}

export interface ScheduleWorkoutArgs {
  workoutId: string
  date: string
  timezone?: string
  idempotencyKey?: string
  duplicatePolicy?: DuplicatePolicy
  confirmed?: boolean
  confirmationId?: string
}

/**
 * One line a caller can act on without reading the whole report.
 *
 * It names only tools that exist in this build, and it never suggests re-sending
 * a write: an unresolved attempt is resolved by reading, or by a human.
 */
function nextActionMessage(action: string, detail: string): string {
  switch (action) {
    case 'resume_garmin_write_operation':
      return `${detail} Call resume_garmin_write_operation to preview the safe remaining steps.`
    case 'reconcile_garmin_write_operation':
      return `${detail} Call reconcile_garmin_write_operation again later, or read get_garmin_calendar directly.`
    case 'manual_review':
      return `${detail} Check the Garmin Calendar in the Garmin app before doing anything else.`
    default:
      return `${detail} No action is required.`
  }
}

/** A plain object guard for records read back from the journal file. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/**
 * The one-line answer to "what happened to that write operation?".
 *
 * A caller reading the journal after a lost response should not have to
 * reconstruct the verdict from per-step bookkeeping, so the operation carries
 * its own roll-up. The rules are deliberately fail-closed and evaluated in
 * priority order — a single blocking step outweighs every satisfied one:
 *
 *   1. any step whose outcome is still uncertain (`unknown` / `in_flight`),
 *      or an operation the journal itself flagged as unreconciled, yields
 *      `unknown` and points at reconciliation. It never points at a write.
 *   2. otherwise, any step that is proven not to have applied yields
 *      `incomplete` and points at the resume preview.
 *   3. otherwise, every step satisfied yields `satisfied` with no next action.
 *   4. anything else is `mixed` and asks for a human.
 *
 * `empty` is an operation with no steps at all: a state this build does not
 * produce, reported as its own value rather than being folded into "satisfied".
 */
function summarizeOperationRecovery(
  operationId: unknown,
  manualReview: unknown,
  receipts: ScheduleStepReceipt[],
): Record<string, unknown> {
  if (typeof operationId !== 'string') return {}
  const blocking = receipts.filter(receipt =>
    receipt.manualReviewRequired || receipt.status === 'unknown' || receipt.status === 'in_flight')
  if (blocking.length > 0 || manualReview) {
    return {
      status: 'unknown',
      canResume: false,
      manualReviewRequired: true,
      desiredStateSatisfied: false,
      blockedStepIds: blocking.map(receipt => receipt.stepId),
      errorCode: blocking.find(receipt => receipt.errorCode)?.errorCode
        ?? WRITE_ERROR_CODES.WRITE_OUTCOME_UNKNOWN,
      nextAction: 'reconcile_garmin_write_operation',
      message: nextActionMessage(
        'reconcile_garmin_write_operation',
        'This operation has an attempt whose outcome is not known.',
      ),
    }
  }
  const resumable = receipts.filter(receipt => receipt.canResume)
  if (resumable.length > 0) {
    return {
      status: 'incomplete',
      canResume: true,
      manualReviewRequired: false,
      desiredStateSatisfied: false,
      resumableStepIds: resumable.map(receipt => receipt.stepId),
      nextAction: 'resume_garmin_write_operation',
      message: nextActionMessage(
        'resume_garmin_write_operation',
        `${resumable.length} step(s) were never sent or provably did not apply.`,
      ),
    }
  }
  if (receipts.length > 0 && receipts.every(receipt => receipt.success)) {
    return {
      status: 'satisfied',
      canResume: false,
      manualReviewRequired: false,
      desiredStateSatisfied: true,
      message: nextActionMessage('none', 'Every step of this operation is satisfied.'),
    }
  }
  if (receipts.length === 0) {
    return {
      status: 'empty',
      canResume: false,
      manualReviewRequired: false,
      desiredStateSatisfied: false,
      nextAction: 'manual_review',
      message: nextActionMessage(
        'manual_review',
        'This record has no steps, which this build never writes.',
      ),
    }
  }
  return {
    status: 'mixed',
    canResume: false,
    manualReviewRequired: false,
    desiredStateSatisfied: false,
    nextAction: 'manual_review',
    message: nextActionMessage('manual_review', 'The steps of this operation disagree.'),
  }
}

export interface ReconcileWriteOperationArgs {
  operationId: string
}

export interface ResumeWriteOperationArgs {
  operationId: string
  confirmed?: boolean
  confirmationId?: string
}

export interface BatchScheduleWorkoutArgs {
  schedules: Array<{ workoutId: string; date: string }>
  timezone?: string
  idempotencyKey?: string
  duplicatePolicy?: DuplicatePolicy
  confirmed?: boolean
  confirmationId?: string
}

export interface CreateAndScheduleWorkoutArgs {
  workout: WorkoutDef
  date: string
  timezone?: string
  confirmed?: boolean
  confirmationId?: string
  idempotencyKey?: string
}

export interface UnscheduleWorkoutArgs {
  workoutScheduleId: string
  confirmed?: boolean
  confirmationId?: string
  idempotencyKey?: string
}

/**
 * Approval handles are derived from persisted state, not from process memory:
 * `confirmationId` is `<operationId>:<previewRevision>`. Any process that can
 * read the account journal can resolve one, and a re-preview bumps the
 * revision so an earlier handle stops working everywhere.
 */
export class GarminToolService {
  private readonly dateRequestLimiter = new AsyncSemaphore(4)
  private coordinator?: WriteCoordinator
  private journalMigration?: Promise<string[]>

  constructor(
    private readonly client: GarminDataClient,
    private readonly options: GarminToolServiceOptions,
  ) {}

  /**
   * Local-only read access to the account write journal. No network calls;
   * used by `get_garmin_write_operation` and tests. The returned records
   * intentionally exclude the raw idempotency key, file path, and any
   * credential-shaped data — callers must not log them.
   */
  async listWriteOperations(): Promise<unknown[]> {
    return this.writeCoordinator().listOperations()
  }

  async getWriteOperation(operationId: string): Promise<unknown> {
    return this.writeCoordinator().getOperation(operationId)
  }

  async findWriteOperationByIdempotencyKey(idempotencyKey: string): Promise<unknown> {
    return this.writeCoordinator().findOperationByIdempotencyKey(idempotencyKey)
  }

  /**
   * One page of the local journal, newest first — the fallback for a caller
   * that lost the `operationId` when a response was lost but still wants to
   * find its own record.
   *
   * The cursor is an opaque, bounded local token, never a path, and it is bound
   * to the exact journal state it was minted against. If any record was
   * written, advanced or removed since, the cursor is reported *stale* rather
   * than translated into a shifted window: silently returning "page 2 of a
   * different list" would let a caller believe it had seen every record.
   *
   * Stale pages carry no `operations` key at all, so an empty result can never
   * be misread as "this account has no operations".
   */
  async listWriteOperationPage(
    args: WriteOperationPageArgs = {},
  ): Promise<Record<string, unknown>> {
    const limit = normalizePageLimit(args.limit)
    const operations = await this.listWriteOperations() as Array<{
      operationId?: string
      updatedAt?: string
    }>
    const digest = journalDigest(operations)

    let offset = 0
    if (args.cursor !== undefined) {
      const decoded = decodeOperationCursor(args.cursor)
      if (!decoded) {
        throw new PublicToolError(
          `[${WRITE_ERROR_CODES.CURSOR_INVALID}] Invalid cursor: pass the nextCursor returned by ` +
          'the previous listing, or omit cursor to start a new listing.',
        )
      }
      if (decoded.digest !== digest) {
        return {
          success: false,
          staleCursor: true,
          errorCode: WRITE_ERROR_CODES.CURSOR_STALE,
          total: operations.length,
          message:
            'The local journal changed since this cursor was issued, so its position no longer ' +
            'names the same list. Omit cursor to list again from the beginning.',
        }
      }
      offset = decoded.offset
    }

    const slice = operations.slice(offset, offset + limit)
    const nextOffset = offset + slice.length
    const hasMore = nextOffset < operations.length
    return {
      success: true,
      total: operations.length,
      limit,
      offset,
      operations: slice.map(operation => this.redactOperation(operation)),
      nextCursor: hasMore
        ? encodeOperationCursor({ v: OPERATION_CURSOR_VERSION, offset: nextOffset, digest })
        : null,
      message: hasMore
        ? 'Continue with nextCursor. It stays valid only while the journal is unchanged.'
        : 'This page reaches the end of the local journal.',
    }
  }

  /**
   * Redact a stored operation into a JSON-safe summary. Removes the raw
   * idempotency hash, the on-disk request payload (which can contain caller
   * text we never want echoed back), and the raw account key. The summary
   * retains what an MCP caller actually needs to make a recovery decision:
   * per-step status, evidence, result IDs, `canResume` and `nextAction` are
   * projected by the coordinator's own receipt rules, so a reader of the
   * journal cannot disagree with the writer that produced it.
   */
  redactOperation(operation: unknown): unknown {
    if (!operation || typeof operation !== 'object') return operation
    const op = operation as Record<string, unknown>
    const rawSteps = Array.isArray(op.steps) ? op.steps : []
    const manualReview = asRecord(op.manualReview)
    const guidance = new Map<string, ScheduleStepReceipt>()
    if (typeof op.operationId === 'string' && typeof op.schemaVersion === 'number') {
      for (const receipt of this.writeCoordinator()
        .describeRecoveryGuidance(op as unknown as WriteOperation)) {
        guidance.set(receipt.stepId, receipt)
      }
    }
    const steps = rawSteps.map(step => {
      const s = step as Record<string, unknown>
      const reference = s.reference as Record<string, unknown> | undefined
      const receipt = typeof s.stepId === 'string' ? guidance.get(s.stepId) : undefined
      return {        stepId: s.stepId,
        kind: s.kind,
        status: s.status,
        attempt: s.attempt,
        workoutId: s.workoutId,
        date: s.date,
        workoutScheduleId: s.workoutScheduleId,
        evidence: s.evidence,
        errorCode: s.errorCode,
        desiredStateSatisfied: s.desiredStateSatisfied,
        observedAt: s.observedAt,
        dispatchedAt: s.dispatchedAt,
        attempts: Array.isArray(s.attempts) ? s.attempts.map((a: unknown) => {
          const at = a as Record<string, unknown>
          return {
            attempt: at.attempt,
            outcome: at.outcome,
            startedAt: at.startedAt,
            finishedAt: at.finishedAt,
            errorCode: at.errorCode,
          }
        }) : [],
        reference: reference ? {
          operationId: reference.operationId,
          stepId: reference.stepId,
          status: reference.status,
          workoutScheduleId: reference.workoutScheduleId,
          errorCode: reference.errorCode,
        } : undefined,
        // Server-authoritative recovery guidance. Present whenever the record
        // is a real journal entry; a hand-built fixture simply omits it rather
        // than being reported with invented advice.
        canResume: receipt?.canResume,
        manualReviewRequired: receipt?.manualReviewRequired,
        nextAction: receipt?.nextAction,
        receiptStatus: receipt?.status,
      }
    })
    return {
      operationId: op.operationId,
      kind: op.kind,
      createdAt: op.createdAt,
      updatedAt: op.updatedAt,
      previewRevision: op.previewRevision ?? 0,
      // Surface the idempotency key fingerprint, never the raw value, and
      // only when the caller already knows the key (they queried by it).
      hasIdempotencyKey: Boolean(op.idempotencyKeyHash),
      // The journal's own "this record could not be reconciled" flag. It blocks
      // every new write for its steps, so it must reach the caller as a
      // recovery instruction, not as a silent annotation.
      manualReview: manualReview
        ? { reason: manualReview.reason, detectedAt: manualReview.detectedAt }
        : undefined,
      ...summarizeOperationRecovery(op.operationId, manualReview, [...guidance.values()]),
      steps,
    }
  }

  /**
   * Lazily build the write coordinator so read-only tool use never touches the
   * state directory. The store and lock are account-scoped and persisted; they
   * are never replaced by in-memory stand-ins in production.
   */
  private writeAccountKey(): string {
    return deriveAccountKey(this.options.accountUsername, this.options.accountRegion)
  }

  /**
   * The reader the coordinator may use, or `undefined` when this account has no
   * verified way to read the Garmin Calendar.
   *
   * `undefined` is a meaningful answer: preflight turns it into
   * `CALENDAR_QUERY_UNSUPPORTED` and refuses the write. The one thing it must
   * never become is "the calendar is empty".
   */
  private calendarReader(): CalendarLookup | undefined {
    if (this.options.calendarReader) return this.options.calendarReader
    const client = this.client
    if (typeof client.getCalendarRange !== 'function') return undefined
    return {
      getCalendarRange: range => client.getCalendarRange!(range),
    }
  }

  private writeCoordinator(): WriteCoordinator {
    if (!this.coordinator) {
      const accountKey = this.writeAccountKey()
      const stateDirectory = this.options.stateDirectory
        ?? resolveStateDirectory(process.env.GARMIN_STATE_DIR)
      this.coordinator = new WriteCoordinator({
        accountKey,
        store: this.options.operationStore ?? new FileOperationStore(stateDirectory, accountKey),
        lock: this.options.accountLock ?? new FileAccountLock(stateDirectory, accountKey),
        writer: {
          schedule: async (workoutId, date) => {
            const result = await this.client.scheduleWorkout(workoutId, date)
            const id = result?.workoutScheduleId
            return {
              workoutScheduleId: typeof id === 'string' || typeof id === 'number' ? String(id) : null,
            }
          },
        },
        calendarReader: this.calendarReader(),
        now: this.options.now,
        newOperationId: this.options.newOperationId,
        newStepId: this.options.newStepId,
        shutdownSignal: this.options.shutdownSignal,
      })
    }
    return this.coordinator
  }

  /**
   * The coordinator, with any pending v1 -> v2 journal upgrade already
   * committed under the account lock.
   *
   * Every write path goes through here, so an old journal is upgraded before
   * the first preview reads a request hash -- the alternative is a preview bound
   * to a v1 hash that the persisted v2 file would then disagree with. The
   * migration is a single bounded read once the journal is current, and a
   * failure is surfaced instead of being retried: a journal that cannot be
   * migrated is one whose confirmation bindings cannot be trusted.
   *
   * Read-only local queries deliberately use `writeCoordinator()` directly:
   * they see the migrated document in memory and must never trigger a write.
   *
   * The same prelude rolls forward abandoned `in_flight` markers. That is a
   * state change, so it belongs here — on a path that is about to write and
   * that takes the account lock — and never on a plain read: `getOperation`
   * and `listOperations` must stay side-effect free.
   */
  private async writeCoordinatorReady(): Promise<WriteCoordinator> {
    const coordinator = this.writeCoordinator()
    if (!this.journalMigration) {
      this.journalMigration = coordinator.migrateJournal()
        .then(report => coordinator.rollForwardAbandonedAttempts().then(() => report.warnings))
        .catch((error: unknown) => {
          // Do not memoize a failure: a later call should be able to retry a
          // transiently unreadable journal rather than being stuck forever.
          this.journalMigration = undefined
          throw error
        })
    }
    await this.journalMigration
    return coordinator
  }

  async getActivities(args: ActivityArgs = {}): Promise<unknown[]> {
    const limit = Math.min(Math.max(Math.trunc(args.limit ?? 5), 1), 100)
    const offset = Math.max(Math.trunc(args.offset ?? 0), 0)
    const detail = args.detail ?? this.options.activityDetail
    const activities = await this.client.getActivities(offset, limit)
    return (activities as Record<string, unknown>[])
      .map(activity => formatActivity(activity, detail))
  }

  async downloadActivityFit(
    args: DownloadActivityFitArgs,
  ): Promise<DownloadActivityFitResult> {
    if (!Number.isSafeInteger(args.activityId) || args.activityId <= 0) {
      throw new PublicToolError('Invalid activityId: expected a positive integer')
    }
    if (
      typeof this.options.fitDownloadDir !== 'string'
      || !this.options.fitDownloadDir.trim()
    ) {
      throw new PublicToolError(
        'FIT download directory is not configured; set GARMIN_FIT_DOWNLOAD_DIR',
      )
    }
    const accountOutputDirectory = fitAccountOutputDirectory(
      this.options.fitDownloadDir,
      this.options.accountUsername,
      this.options.accountRegion,
    )

    let temporaryDirectory: string | undefined
    try {
      temporaryDirectory = await mkdtemp(join(tmpdir(), 'garmin-connect-fit-'))
      if (process.platform !== 'win32') await chmod(temporaryDirectory, 0o700)

      await this.client.downloadOriginalActivityZip(
        args.activityId,
        temporaryDirectory,
      )
      const metadata = await exportFitFromZip({
        activityId: args.activityId,
        outputDir: accountOutputDirectory,
        // Never trust an upstream-returned path; the SDK contract writes this
        // fixed file name inside the private directory we just created.
        zipPath: join(temporaryDirectory, `${args.activityId}.zip`),
      })

      return {
        success: true,
        activityId: args.activityId,
        fileName: metadata.fileName,
        sizeBytes: metadata.sizeBytes,
        sha256: metadata.sha256,
      }
    } finally {
      if (temporaryDirectory) {
        // The FIT file is already committed with exclusive-create semantics.
        // A rare best-effort temp cleanup failure must not turn that success
        // into an error that encourages an unsafe duplicate retry.
        await rm(temporaryDirectory, { recursive: true, force: true })
          .catch(() => undefined)
      }
    }
  }

  async getSleep(args: DateRangeArgs = {}): Promise<unknown> {
    const start = validateDate('startDate', args.startDate ?? todayLocal())
    const end = validateDate('endDate', args.endDate ?? start)
    const dates = getDatesInRange(start, end)
    const results = await mapConcurrent(dates, 4, async (date) => {
      const raw = await this.dateRequestLimiter.run(() => this.client.getSleep(date))
      return formatSleep(raw as Record<string, unknown>)
    })
    return results.length === 1 ? results[0] : results
  }

  async getSteps(args: DateRangeArgs = {}): Promise<unknown> {
    const start = validateDate('startDate', args.startDate ?? todayLocal())
    const end = validateDate('endDate', args.endDate ?? start)
    const dates = getDatesInRange(start, end)
    const results = await mapConcurrent(dates, 4, async (date) => {
      const raw = await this.dateRequestLimiter.run(() => this.client.getSteps(date))
      return formatSteps(raw as Record<string, unknown>)
    })
    return results.length === 1 ? results[0] : results
  }

  async getHeartRate(args: DateRangeArgs = {}): Promise<unknown> {
    const start = validateDate('startDate', args.startDate ?? todayLocal())
    const end = validateDate('endDate', args.endDate ?? start)
    const dates = getDatesInRange(start, end)
    const results = await mapConcurrent(dates, 4, async (date) => {
      const raw = await this.dateRequestLimiter.run(() => this.client.getHeartRate(date))
      return formatHeartRate(raw as Record<string, unknown>)
    })
    return results.length === 1 ? results[0] : results
  }

  async getWeight(args: DateRangeArgs = {}): Promise<unknown> {
    const start = validateDate('startDate', args.startDate ?? todayLocal())
    const end = validateDate('endDate', args.endDate ?? start)
    const dates = getDatesInRange(start, end)
    const results = await mapConcurrent(dates, 4, async (date) => {
      const raw = await this.dateRequestLimiter.run(() => this.client.getWeight(date))
      return formatWeight(raw as Record<string, unknown>)
    })
    return results.length === 1 ? results[0] : results
  }

  async getWorkouts(args: PaginationArgs = {}): Promise<unknown[]> {
    const limit = Math.min(Math.max(Math.trunc(args.limit ?? 10), 1), 100)
    const offset = Math.max(Math.trunc(args.offset ?? 0), 0)
    const workouts = await this.client.getWorkouts(offset, limit)
    return (workouts as Record<string, unknown>[]).map(formatWorkout)
  }

  async getRunningAdvice(args: RunningAdviceArgs): Promise<RunningAdviceResponse> {
    const mode = args?.mode
    if (!isOneOf(RUNNING_ADVICE_MODES, mode)) {
      throw new PublicToolError(
        'Invalid running advice request: mode must be explain or personalized',
      )
    }
    const language = args.language ?? 'en'
    if (mode === 'personalized') {
      if (args.hasWarningSymptoms === true) {
        return {
          requiresUserInput: false,
          mode: 'personalized',
          safetyStop: true,
          instruction: language === 'zh-CN'
            ? '用户报告了胸部不适、轻微活动异常气短、晕厥/眩晕、异常心悸等健康警示症状。不要生成高强度或逐日训练计划，也不要自行诊断；请建议用户先取得医疗专业人员许可。'
            : 'The athlete reported warning symptoms such as chest discomfort, unusual breathlessness with mild activity, fainting/dizziness, or abnormal palpitations. Do not generate hard training or a daily plan and do not diagnose; advise medical clearance first.',
        }
      }
      const missingFields = missingRunningIntakeFields(args)
      if (missingFields.length > 0) {
        return {
          requiresUserInput: true,
          missingFields,
          questions: missingFields.map(field => ({
            field,
            question: runningIntakeQuestion(field, language),
          })),
          instruction: language === 'zh-CN'
            ? '请只询问上述缺失信息；在用户回答前不要生成逐日或逐周计划，也不要猜测训练量或强度。'
            : 'Ask only for the missing information above. Do not generate a daily or weekly plan, or guess training volume or intensity, until the user answers.',
        }
      }
    }

    const skills = findSkills(args.query)
    const matchedSkills = mode === 'personalized'
      ? skills.map(skill => formatSkillSummary(skill, language))
      : skills.map(skill => formatSkillCard(skill, language))
    const philosophies = mode === 'personalized'
      ? orderTrainingPhilosophies(args.trainingPreference!)
      : findTrainingPhilosophies(args.query)
    const result: RunningAdviceResult = {
      requiresUserInput: false,
      mode,
      matchedSkills,
      trainingPhilosophies: philosophies.map(philosophy => (
        formatTrainingPhilosophy(philosophy, language)
      )),
      totalSkillsInKB: RUNNING_SKILLS.length,
      totalPhilosophiesInKB: TRAINING_PHILOSOPHIES.length,
      evidenceLegend: language === 'zh-CN'
        ? {
          system_principle: '体系理念：用于说明方法如何训练，不代表优于其他方法。',
          research_evidence: '研究证据：结论必须服从样本、项目、周期和结局指标限制。',
          application_inference: '应用推断：面向该用户的保守转化，不是原研究直接结论。',
        }
        : {
          system_principle: 'System principle: defines how a method trains, not proof that it is superior.',
          research_evidence: 'Research evidence: interpretation is limited by sample, sport, duration, and outcomes.',
          application_inference: 'Application inference: a conservative user-specific translation, not a direct study conclusion.',
        },
    }

    if (mode === 'personalized') {
      result.athleteContext = {
        goal: args.goal!.trim(),
        currentPerformance: args.currentPerformance!.trim(),
        performanceBasis: args.performanceBasis!,
        trainingBackground: args.trainingBackground!.trim(),
        availability: args.availability!.trim(),
        healthConstraints: args.healthConstraints!.trim(),
        hasWarningSymptoms: args.hasWarningSymptoms!,
        trainingPreference: args.trainingPreference!,
        maxQualitySessionsPerWeek: args.maxQualitySessionsPerWeek!,
        intensityGuidancePreference: args.intensityGuidancePreference!,
      }
      result.planningInstructions = language === 'zh-CN'
        ? [
          '训练强度必须锚定当前成绩，不能用目标成绩反推训练配速。',
          '计划开头必须说明采用哪一种强度分区体系或配速/RPE 锚点；同一计划不能混用不同体系的分区名称或编号。',
          '说明借用了哪些训练体系原则、为何适合该用户，以及哪些部分未采用。',
          '给出周总量或总时长范围；每节课写明目的、强度锚点、热身和冷身，并明确轻松日、恢复日和休息日。',
          '写明因疼痛、疾病、睡眠不足、异常疲劳、天气或比赛而降级或停止的规则。',
          '每个调整周期只改变有限变量，不同时明显增加跑量、跑频、长跑和高强度。',
          '默认不安排双阈值；质量课必须受控、可恢复，并写明降级与停止规则。',
          '若用户描述当前疼痛、疾病或心血管健康警示症状，不安排高强度训练；建议先取得医疗专业人员许可，但不要自行诊断。',
          '计划必须服从可训练时间、伤病健康和恢复约束；安排 2–4 周复评，并根据完成率、RPE、疼痛、睡眠以及必要的比赛或计时测试更新，不能自动按目标配速升级。',
        ]
        : [
          'Anchor training intensity to current performance, never by reverse-engineering goal pace.',
          'At the start, name the intensity-zone system or pace/RPE anchors used; do not mix zone names or numbers from different systems in one plan.',
          'Name the principles borrowed from each system, why they fit, and what was not adopted.',
          'Give a weekly volume or time range; state each session\'s purpose, intensity anchor, warm-up and cool-down, plus easy, recovery, and rest days.',
          'Write explicit downgrade or stop rules for pain, illness, sleep loss, unusual fatigue, weather, or racing.',
          'Change only a limited number of variables per adjustment cycle; do not simultaneously raise volume, frequency, long-run load, and intensity.',
          'Do not prescribe double threshold by default; quality work must be controlled and recoverable with downgrade and stop rules.',
          'If the athlete reports current pain, illness, or cardiovascular warning symptoms, do not prescribe hard training; advise medical clearance without diagnosing.',
          'Respect availability, injury, health, and recovery constraints; reassess in 2–4 weeks using completion rate, RPE, pain, sleep, and any needed race or time-trial update, never an automatic progression toward goal pace.',
        ]
      if (args.performanceBasis === 'no_recent_benchmark') {
        result.planningInstructions.unshift(language === 'zh-CN'
          ? '当前没有可信近期成绩：先采用轻松基础训练或低风险基准测试，不给出精确的门槛/间歇配速。'
          : 'There is no trustworthy recent benchmark: begin with easy base work or a low-risk benchmark, and do not prescribe exact threshold or interval paces.')
      }
    } else {
      result.tip =
        'Explain the requested concept without inventing a personalized schedule. ' +
        'Use personalized mode before planning for an athlete.'
    }

    if (mode === 'personalized' && args.includeRecentActivities) {
      try {
        const activities = await this.client.getActivities(0, 5)
        result.recentRunningActivities = (activities as Record<string, unknown>[])
          .filter((activity) => {
            const activityType = activity.activityType
            const key = typeof activityType === 'object' && activityType !== null
              ? (activityType as Record<string, unknown>).typeKey
              : activityType
            const normalized = String(key ?? '').toLowerCase()
            return normalized.includes('run') || normalized.includes('trail')
          })
          .map(activity => formatActivity(activity, 'compact'))
      } catch {
        result.recentRunningActivities =
          'Recent Garmin activities are temporarily unavailable.'
      }
    }

    return result
  }

  async getProfile(): Promise<unknown> {
    const profile = await this.client.getUserProfile()
    return formatProfile(profile as Record<string, unknown>)
  }

  async createWorkout(args: CreateWorkoutArgs): Promise<Record<string, unknown>> {
    // `idempotencyKey` is caller metadata, not part of the workout definition:
    // it must never reach the definition validator, the template fingerprint, or
    // the persisted request. Leaving it in `definition` used to fail validation
    // ("unknown field") and would otherwise have leaked the raw value into the
    // journal payload.
    const { confirmed, confirmationId, idempotencyKey, ...definition } = args
    assertIdempotencyKey(idempotencyKey)
    const validationError = validateWorkoutDef(definition)
    if (validationError) {
      throw new PublicToolError(`Invalid workout definition: ${validationError}`)
    }

    // The workout definition is the fingerprint the coordinator uses to
    // dedupe across restarts. The confirmationId is the operationId.
    const fingerprint = workoutDefinitionFingerprint(definition as unknown as Record<string, unknown>)
    const canonicalRequest = { operation: 'create', definition }
    const businessKey = createBusinessKey(this.writeAccountKey(), fingerprint)
    const coordinator = await this.writeCoordinatorReady()

    if (confirmed !== true) {
      const preview = await coordinator.previewCreate({
        request: canonicalRequest,
        idempotencyKey: assertIdempotencyKey(idempotencyKey),
        businessKey,
        fingerprint,
      })
      if (!preview.requiresConfirmation) {
        const existing = preview.steps[0]
        if (existing?.action === 'skip_existing') {
          return {
            success: true,
            workoutId: existing.resolvedWorkoutId ?? null,
            workoutName: definition.name,
            alreadyCreated: true,
            operationId: existing.operationId,
            message: `Workout "${definition.name}" already exists in the Garmin library (id ${existing.resolvedWorkoutId ?? 'unknown'}).`,
          }
        }
        return {
          success: false,
          workoutName: definition.name,
          blocked: true,
          operationId: existing?.operationId,
          errorCode: existing?.errorCode ?? 'WRITE_OUTCOME_UNKNOWN',
          message: 'A previous create for this definition has an unresolved outcome. Reconcile before retrying.',
        }
      }
      return {
        requiresConfirmation: true,
        confirmationId: this.issueConfirmation(preview.operationId as string, preview.previewRevision ?? 0),
        operationId: preview.operationId,
        previewRevision: preview.previewRevision ?? 0,
        workoutName: definition.name,
        sport: definition.sport ?? 'running',
        stepCount: definition.steps.length,
        preview: definition,
        message:
          'Review this workout with the user, then call create_garmin_workout again ' +
          'with the same definition, confirmed=true, and this confirmationId.',
      }
    }

    const execution = await coordinator.executeCreate(
      this.resolveConfirmation(confirmationId, canonicalRequest),
      { addWorkout: () => this.client.addWorkout(buildGarminWorkout(definition)) as unknown as Promise<{ workoutId: string | number }> },
    )
    const receipt = this.receiptAt(execution, 0, 'create')
    if (receipt.status === 'succeeded') {
      return {
        success: true,
        workoutId: receipt.workoutId ?? null,
        workoutName: definition.name,
        operationId: execution.operationId,
        message: `Workout "${definition.name}" was created in the Garmin workout library.`,
      }
    }
    if (receipt.status === 'skipped') {
      return {
        success: true,
        workoutId: receipt.workoutId ?? null,
        workoutName: definition.name,
        alreadyCreated: true,
        operationId: execution.operationId,
        message: `Workout "${definition.name}" already exists in the Garmin library (id ${receipt.workoutId ?? 'unknown'}).`,
      }
    }
    return {
      success: false,
      workoutName: definition.name,
      blocked: receipt.manualReviewRequired,
      errorCode: receipt.errorCode,
      operationId: execution.operationId,
      message: receipt.manualReviewRequired
        ? `A previous create for this definition has an unresolved outcome (${receipt.errorCode ?? 'unknown'}). Reconcile before retrying.`
        : `Create failed: ${receipt.errorCode ?? 'unknown'}`,
    }
  }

  async scheduleWorkout(args: ScheduleWorkoutArgs): Promise<Record<string, unknown>> {
    const request = this.validateScheduleRequest(args)
    const idempotencyKey = assertIdempotencyKey(args.idempotencyKey)
    // canonicalRequest is what gets persisted and hashed. The caller-supplied
    // idempotencyKey never enters the journal: it is metadata, not a request
    // fingerprint, and may carry user text we do not want round-tripped.
    const canonicalRequest = {
      operation: 'schedule',
      workoutId: request.workoutId,
      date: request.date,
      timezone: request.timezone,
    }
    const coordinator = await this.writeCoordinatorReady()

    if (args.confirmed !== true) {
      const workout = await this.client.getWorkoutDetail(request.workoutId)
      const preview = await coordinator.previewSchedule({
        kind: 'schedule',
        timezone: request.timezone,
        request: canonicalRequest,
        steps: [{ workoutId: request.workoutId, date: request.date }],
        idempotencyKey,
        duplicatePolicy: args.duplicatePolicy,
      })
      const step = preview.steps[0]
      if (!preview.requiresConfirmation) return this.scheduleNoOpResponse(request, step)
      return {
        requiresConfirmation: true,
        confirmationId: this.issueConfirmation(preview.operationId as string, preview.previewRevision ?? 0),
        operationId: preview.operationId ?? null,
        preview: {
          ...request,
          workoutName: workoutName(workout),
          action: step?.action ?? 'write',
          status: step?.status ?? 'prepared',
        },
        message: 'Review this Garmin Calendar entry, then call schedule_garmin_workout again with confirmed=true and this confirmationId.',
      }
    }

    const execution = await coordinator.executeSchedule(
      this.resolveConfirmation(args.confirmationId, canonicalRequest),
      { signal: this.options.shutdownSignal },
    )
    return this.scheduleReceiptResponse(this.receiptAt(execution, 0, 'schedule'), request)
  }

  /**
   * The single receipt a confirmed one-step operation must produce.
   *
   * A confirmation names an operation and a revision, so a confirmed dispatch
   * always has exactly one step to report. If the journal no longer holds it,
   * nothing was sent and the honest answer is a state problem — not a
   * `TypeError` escaping from a public tool.
   */
  private receiptAt(execution: ScheduleExecution, index: number, label: string): ScheduleStepReceipt {
    const receipt = execution.receipts[index]
    if (!receipt) {
      throw new GarminWriteError(
        WRITE_ERROR_CODES.STATE_CORRUPT,
        'not_applied',
        `The confirmed operation records no ${label} step to report; nothing was sent to Garmin`,
      )
    }
    return receipt
  }

  private scheduleNoOpResponse(
    request: { workoutId: string; date: string; timezone: string },
    step: { action: string; status: string; operationId?: string; workoutScheduleId?: string | null; errorCode?: string; reason?: string } | undefined,
  ): Record<string, unknown> {
    const satisfied = step?.action === 'skip_existing'
    return {
      success: satisfied,
      requiresConfirmation: false,
      operationId: step?.operationId ?? null,
      status: step?.status ?? 'unknown',
      action: step?.action ?? 'blocked',
      desiredStateSatisfied: satisfied,
      workoutId: request.workoutId,
      date: request.date,
      timezone: request.timezone,
      workoutScheduleId: step?.workoutScheduleId ?? null,
      ...(step?.errorCode ? { errorCode: step.errorCode } : {}),
      ...(step?.reason ? { message: step.reason } : {}),
    }
  }

  private scheduleReceiptResponse(
    receipt: {
      success: boolean
      operationId: string
      status: string
      desiredStateSatisfied: boolean
      evidence: string
      canResume: boolean
      manualReviewRequired: boolean
      workoutScheduleId?: string | null
      errorCode?: string
      nextAction?: string
    },
    request: { workoutId: string; date: string; timezone: string },
  ): Record<string, unknown> {
    const uncertain = receipt.status === 'unknown' || receipt.status === 'in_flight'
    return {
      success: receipt.success,
      operationId: receipt.operationId,
      status: receipt.status,
      desiredStateSatisfied: receipt.desiredStateSatisfied,
      evidence: receipt.evidence,
      canResume: receipt.canResume,
      manualReviewRequired: receipt.manualReviewRequired,
      workoutId: request.workoutId,
      date: request.date,
      timezone: request.timezone,
      workoutScheduleId: receipt.workoutScheduleId ?? null,
      ...(receipt.errorCode ? { errorCode: receipt.errorCode } : {}),
      ...(receipt.nextAction ? { nextAction: receipt.nextAction } : {}),
      message: uncertain
        ? 'The Garmin Calendar write outcome is unknown. Do not retry: query the operation and reconcile before scheduling again.'
        : receipt.success
          ? 'Workout was added to Garmin Calendar.'
          : 'Garmin Calendar scheduling did not complete for this entry.',
    }
  }

  async batchScheduleWorkouts(args: BatchScheduleWorkoutArgs): Promise<Record<string, unknown>> {
    const request = this.validateBatchScheduleRequest(args)
    const idempotencyKey = assertIdempotencyKey(args.idempotencyKey)
    const canonicalRequest = {
      operation: 'batch-schedule',
      schedules: request.schedules.map(schedule => ({
        workoutId: schedule.workoutId,
        date: schedule.date,
      })),
      timezone: request.timezone,
    }
    const coordinator = await this.writeCoordinatorReady()

    if (args.confirmed !== true) {
      const workoutDetails = new Map<string, unknown>()
      for (const workoutId of new Set(request.schedules.map(schedule => schedule.workoutId))) {
        workoutDetails.set(workoutId, await this.client.getWorkoutDetail(workoutId))
      }
      const preview = await coordinator.previewSchedule({
        kind: 'batch-schedule',
        timezone: request.timezone,
        request: canonicalRequest,
        steps: request.schedules,
        idempotencyKey,
        duplicatePolicy: args.duplicatePolicy,
      })
      if (!preview.requiresConfirmation) {
        return {
          success: preview.steps.every(step => step.action === 'skip_existing'),
          requiresConfirmation: false,
          timezone: request.timezone,
          steps: preview.steps,
        }
      }
      const issuedConfirmationId = this.issueConfirmation(
        preview.operationId as string,
        preview.previewRevision ?? 0,
      )
      return {
        requiresConfirmation: true,
        confirmationId: issuedConfirmationId,
        operationId: preview.operationId ?? null,
        preview: preview.steps.map(step => ({
          workoutId: step.workoutId,
          date: step.date,
          timezone: request.timezone,
          workoutName: workoutName(workoutDetails.get(step.workoutId)),
          action: step.action,
          status: step.status,
        })),
        message: 'Review every Garmin Calendar entry, then call batch_schedule_garmin_workouts again with confirmed=true and this confirmationId. Rest days are intentionally omitted: they are not Garmin workouts.',
      }
    }

    const execution = await coordinator.executeSchedule(
      this.resolveConfirmation(args.confirmationId, canonicalRequest),
      { signal: this.options.shutdownSignal },
    )
    const results = execution.receipts.map(receipt => ({
      success: receipt.success,
      workoutId: receipt.workoutId,
      date: receipt.date,
      status: receipt.status,
      operationId: receipt.operationId,
      // Exposed so a caller can map an entry back to the journal step that
      // `get_garmin_write_operation` reports, instead of trusting array order.
      stepId: receipt.stepId,
      evidence: receipt.evidence,
      desiredStateSatisfied: receipt.desiredStateSatisfied,
      workoutScheduleId: receipt.workoutScheduleId ?? null,
      // Per-entry recoverability. A halted entry is retryable after its blocker
      // is resolved; an entry with an unresolved remote outcome needs manual
      // review. Dropping these two made every halted entry indistinguishable
      // from one that needs reconciling.
      canResume: receipt.canResume,
      manualReviewRequired: receipt.manualReviewRequired,
      ...(receipt.errorCode ? { errorCode: receipt.errorCode } : {}),
      ...(receipt.nextAction ? { nextAction: receipt.nextAction } : {}),
      ...(receipt.message ? { message: receipt.message } : {}),
    }))
    const successCount = results.filter(
      result => result.status === 'succeeded' || result.status === 'skipped',
    ).length
    return {
      success: results.every(result => result.status === 'succeeded' || result.status === 'skipped'),
      operationId: execution.operationId,
      timezone: request.timezone,
      total: results.length,
      successCount,
      skippedCount: results.filter(result => result.status === 'skipped').length,
      unknownCount: results.filter(result => result.status === 'unknown' || result.status === 'in_flight').length,
      notAttemptedCount: results.filter(result => result.status === 'not_attempted').length,
      definiteFailureCount: results.filter(result => result.status === 'failed').length,
      // Legacy field: previous clients read failureCount as "not confirmed complete".
      failureCount: results.length - successCount,
      results,
    }
  }

  /**
   * Create a workout template and put it on the Garmin Calendar in one
   * confirmed step.
   *
   * Both phases live in a single journaled operation, so the schedule phase
   * can never be reached through a *different* operation that happens to
   * observe the create phase as an unrelated satisfied receipt. The schedule
   * phase is only ever attempted after the create phase has been proven
   * satisfied and has recorded the workout id it was assigned.
   */
  async createAndScheduleWorkout(
    args: CreateAndScheduleWorkoutArgs,
  ): Promise<Record<string, unknown>> {
    const validationError = validateWorkoutDef(args.workout)
    if (validationError) throw new PublicToolError(`Invalid workout definition: ${validationError}`)
    const schedule = this.validateCalendarDate(args.date, args.timezone)
    const definition = args.workout as unknown as Record<string, unknown>
    const fingerprint = workoutDefinitionFingerprint(definition)
    const accountKey = this.writeAccountKey()
    const businessKey = createBusinessKey(accountKey, fingerprint)
    const canonicalRequest = {
      operation: 'create-and-schedule',
      definition: args.workout,
      date: schedule.date,
      timezone: schedule.timezone,
    }
    const coordinator = await this.writeCoordinatorReady()

    if (args.confirmed !== true) {
      const preview = await coordinator.previewCreateAndSchedule({
        request: canonicalRequest,
        idempotencyKey: assertIdempotencyKey(args.idempotencyKey),
        businessKey,
        fingerprint,
        date: schedule.date,
      })
      if (!preview.requiresConfirmation) {
        const blocked = preview.steps.find(step => step.action === 'blocked')
        if (blocked) {
          return {
            success: false,
            blocked: true,
            operationId: blocked.operationId,
            errorCode: blocked.errorCode ?? 'WRITE_OUTCOME_UNKNOWN',
            beforeCreate: preview.steps[0]?.action === 'skip_existing',
            preview: { workout: args.workout, schedule },
            message:
              'This workout or its calendar entry already has an unresolved outcome. ' +
              'Reconcile that operation before retrying.',
          }
        }
        // Both phases are already satisfied in the journal: report the durable
        // receipts instead of asking for a confirmation that would write
        // nothing.
        const createStep = preview.steps.find(step => step.kind === 'create')
        const scheduleStep = preview.steps.find(step => step.kind === 'schedule')
        return {
          success: true,
          requiresConfirmation: false,
          alreadyCreated: true,
          alreadyScheduled: true,
          workoutId: createStep?.resolvedWorkoutId ?? null,
          workoutScheduleId: scheduleStep?.workoutScheduleId ?? null,
          date: schedule.date,
          timezone: schedule.timezone,
          operationId: preview.existingOperationId ?? preview.operationId ?? null,
          preview: { workout: args.workout, schedule },
          message: 'This workout is already in the Garmin library and already on the calendar for that date.',
        }
      }
      return {
        requiresConfirmation: true,
        confirmationId: this.issueConfirmation(preview.operationId as string, preview.previewRevision ?? 0),
        operationId: preview.operationId as string,
        previewRevision: preview.previewRevision ?? 0,
        alreadyCreated: preview.steps[0]?.action === 'skip_existing',
        preview: { workout: args.workout, schedule },
        message:
          'Review this workout and its Garmin Calendar date, then call ' +
          'create_and_schedule_garmin_workout again with confirmed=true and this confirmationId. ' +
          'The schedule phase runs only if the create phase is proven to have succeeded.',
      }
    }

    const execution = await coordinator.executeCreateAndSchedule(
      this.resolveConfirmation(args.confirmationId, canonicalRequest),
      {
        addWorkout: () => this.client.addWorkout(buildGarminWorkout(args.workout)) as unknown as Promise<{ workoutId: string | number }>,
        schedule: (workoutId: string, date: string) =>
          this.client.scheduleWorkout(workoutId, date) as Promise<{ workoutScheduleId?: string | null }>,
      },
    )

    const createReceipt = execution.receipts[0]
    const scheduleReceipt = execution.receipts[1]
    const base = {
      operationId: execution.operationId,
      workoutId: createReceipt?.workoutId || null,
      date: schedule.date,
      timezone: schedule.timezone,
    }

    if (!createReceipt || !SATISFIED_STEP_STATUSES.has(createReceipt.status)) {
      const unresolved = createReceipt?.status === 'unknown' || createReceipt?.status === 'in_flight'
      return {
        ...base,
        success: false,
        blocked: Boolean(createReceipt?.manualReviewRequired),
        // `workoutCreated` answers "may a template now exist that must not be
        // re-created?". A proven success/skip says yes; an unresolved create
        // also says yes (it was dispatched and we cannot prove otherwise). A
        // proven non-application says no, and re-creating is safe.
        workoutCreated:
          createReceipt?.status === 'succeeded'
          || createReceipt?.status === 'skipped'
          || unresolved,
        errorCode: createReceipt?.errorCode,
        ...(createReceipt?.nextAction ? { nextAction: createReceipt.nextAction } : {}),
        message: unresolved
          ? `The create half has an unresolved outcome (${createReceipt?.errorCode ?? 'unknown'}). Reconcile before retrying; the schedule half was not attempted.`
          : `The workout was not created (${createReceipt?.status ?? 'unknown'}: ${createReceipt?.errorCode ?? 'unknown'}). The schedule half was not attempted.`,
      }
    }

    if (!scheduleReceipt) {
      // The schedule phase was created only for a proven-resolved workout id.
      // A missing receipt therefore means the create step did not record one.
      return {
        ...base,
        success: false,
        workoutCreated: true,
        errorCode: 'STATE_CORRUPT',
        message:
          'The workout was created but its assigned id was not recorded, so the calendar entry was not attempted. ' +
          'Reconcile this operation before scheduling it manually.',
      }
    }

    if (SATISFIED_STEP_STATUSES.has(scheduleReceipt.status)) {
      return {
        ...base,
        success: true,
        workoutCreated: true,
        workoutScheduleId: scheduleReceipt.workoutScheduleId ?? null,
        status: scheduleReceipt.status,
        evidence: scheduleReceipt.evidence,
        createOperationId: execution.operationId,
        message: scheduleReceipt.status === 'succeeded'
          ? 'Workout was created and scheduled on the Garmin Calendar.'
          : 'Workout already existed; the calendar entry was already in place.',
      }
    }

    return {
      ...base,
      success: false,
      workoutCreated: true,
      workoutScheduleId: scheduleReceipt.workoutScheduleId ?? null,
      status: scheduleReceipt.status,
      evidence: scheduleReceipt.evidence,
      errorCode: scheduleReceipt.errorCode,
      ...(scheduleReceipt.nextAction ? { nextAction: scheduleReceipt.nextAction } : {}),
      message:
        `The workout was created, but the calendar entry reported ${scheduleReceipt.status}` +
        `${scheduleReceipt.errorCode ? ` (${scheduleReceipt.errorCode})` : ''}. Do not retry blindly: ` +
        'query the operation and reconcile before scheduling again.',
    }
  }

  async unscheduleWorkout(args: UnscheduleWorkoutArgs): Promise<Record<string, unknown>> {
    const workoutScheduleId = validateOpaqueId('workoutScheduleId', args.workoutScheduleId)
    const request = { operation: 'unschedule', workoutScheduleId }
    const businessKey = unscheduleBusinessKey(this.writeAccountKey(), workoutScheduleId)
    const coordinator = await this.writeCoordinatorReady()
    if (args.confirmed !== true) {
      const preview = await coordinator.previewUnschedule({
        request,
        idempotencyKey: assertIdempotencyKey(args.idempotencyKey),
        businessKey,
        workoutScheduleId,
      })
      if (!preview.requiresConfirmation) {
        const existing = preview.steps[0]
        if (existing?.action === 'skip_existing') {
          return {
            success: true,
            workoutScheduleId,
            alreadyRemoved: true,
            operationId: existing.operationId,
            message: `Workout ${workoutScheduleId} is no longer on the Garmin Calendar.`,
          }
        }
        return {
          success: false,
          workoutScheduleId,
          blocked: true,
          operationId: existing?.operationId,
          errorCode: existing?.errorCode ?? 'WRITE_OUTCOME_UNKNOWN',
          message: 'A previous unschedule for this id has an unresolved outcome. Reconcile before retrying.',
        }
      }
      return {
        requiresConfirmation: true,
        confirmationId: this.issueConfirmation(preview.operationId as string, preview.previewRevision ?? 0),
        operationId: preview.operationId,
        previewRevision: preview.previewRevision ?? 0,
        preview: request,
        message: 'Review this Garmin Calendar removal, then call unschedule_garmin_workout again with confirmed=true and this confirmationId.',
      }
    }
    const execution = await coordinator.executeUnschedule(
      this.resolveConfirmation(args.confirmationId, request),
      { unschedule: (id: string) => this.client.unscheduleWorkout(id) },
    )
    const receipt = this.receiptAt(execution, 0, 'unschedule')
    if (receipt.status === 'succeeded') {
      return {
        success: true,
        workoutScheduleId,
        operationId: execution.operationId,
        message: 'Workout was removed from Garmin Calendar.',
      }
    }
    if (receipt.status === 'skipped') {
      return {
        success: true,
        workoutScheduleId,
        alreadyRemoved: true,
        operationId: execution.operationId,
        message: 'Workout was already removed from Garmin Calendar.',
      }
    }
    return {
      success: false,
      workoutScheduleId,
      blocked: receipt.manualReviewRequired,
      errorCode: receipt.errorCode,
      operationId: execution.operationId,
      message: receipt.manualReviewRequired
        ? `A previous unschedule for this id has an unresolved outcome (${receipt.errorCode ?? 'unknown'}). Reconcile before retrying.`
        : `Unschedule failed: ${receipt.errorCode ?? 'unknown'}`,
    }
  }

  /**
   * Mint the durable approval handle for a preview. Pure string derivation:
   * nothing is stored in this process, so the handle keeps working after a
   * restart and is invalidated in every process when the revision advances.
   */
  /**
   * A fresh, read-only Garmin Calendar read for an inclusive date range.
   *
   * Three answers that must never be confused with one another:
   *   - no verified read exists for this account  -> throws (capability error);
   *   - the read could not cover the whole range  -> snapshot with a partial
   *     result and `complete:false`, never an empty range;
   *   - the read covered the range and saw none  -> a *complete* snapshot with
   *     no entries, which is a statement about this read and no other.
   *
   * None of them says whether a specific write attempt reached Garmin. This
   * method never writes, never deletes, and never retries a write; it issues
   * exactly the reads the adapter decides are needed and stores nothing.
   */
  async getCalendarRange(args: CalendarRangeArgs = {}): Promise<CalendarSnapshot> {
    const range = validateCalendarQuery(args)
    const reader = this.calendarReader()
    if (!reader) {
      throw new CalendarCapabilityError(calendarUnsupportedMessage())
    }
    try {
      return await reader.getCalendarRange(range)
    } catch (error) {
      // The adapter refuses an unsupported region with a typed write error
      // before it sends anything. Re-raise it as a capability answer so the
      // caller learns *why* the calendar cannot be observed instead of seeing
      // the generic upstream fallback.
      if (isGarminWriteError(error) && error.code === WRITE_ERROR_CODES.CALENDAR_QUERY_UNSUPPORTED) {
        throw new CalendarCapabilityError(error.message)
      }
      throw error
    }
  }

  /**
   * Ask the coordinator to re-read what an operation is still unsure about.
   *
   * `readOnlyHint:false` is honest about what this does: it takes no Garmin
   * write, but it does record local observations. It never re-sends, never
   * deletes, and never turns an observation into a success — an `unknown`
   * attempt stays unresolved until a real receipt arrives.
   */
  async reconcileWriteOperation(
    args: ReconcileWriteOperationArgs,
  ): Promise<Record<string, unknown>> {
    const operationId = validateOpaqueId('operationId', args.operationId)
    const coordinator = await this.writeCoordinatorReady()
    const report: ReconcileReport = await coordinator.reconcile(operationId)
    return {
      operationId: report.operationId,
      kind: report.kind,
      readsIssued: report.readsIssued,
      readLimit: report.readLimit,
      budgetMs: report.budgetMs,
      maxReads: report.maxReads,
      observations: report.observations,
      unreadable: report.unreadable,
      deferred: report.deferred,
      // A read that failed is the reason the answer is "look again later". Losing
      // it here would leave the caller with a next action and no cause.
      failures: report.failures ?? [],
      candidates: report.candidates,
      refusals: report.refusals,
      manualReviewRequired: report.manualReviewRequired,
      nextAction: report.nextAction,
      nextActionDetail: report.nextActionDetail,
      wroteToGarmin: false,
      message: nextActionMessage(report.nextAction, report.nextActionDetail),
    }
  }

  /**
   * Derive the safe remaining steps of a journaled operation and, once the
   * caller approves the preview, dispatch them.
   *
   * There is no payload parameter. Dates, workout ids and template definitions
   * all come from the journal record, so a resume can never be used to move a
   * write to a different day or swap the template — that would need a new
   * preview, not a recovery.
   */
  async resumeWriteOperation(
    args: ResumeWriteOperationArgs,
  ): Promise<Record<string, unknown>> {
    const operationId = validateOpaqueId('operationId', args.operationId)
    const coordinator = await this.writeCoordinatorReady()

    if (args.confirmed !== true) {
      const preview: ResumePreview = await coordinator.resume(operationId)
      const steps = preview.steps.map(step => ({
        stepId: step.stepId,
        kind: step.kind,
        action: step.action,
        status: step.status,
        workoutId: step.workoutId,
        date: step.date,
        workoutScheduleId: step.workoutScheduleId ?? null,
        ...(step.errorCode ? { errorCode: step.errorCode } : {}),
      }))
      if (!preview.requiresConfirmation) {
        return {
          success: steps.every(step => step.action === 'skip_existing' || step.status === 'succeeded'),
          requiresConfirmation: false,
          operationId,
          previewRevision: preview.previewRevision,
          steps,
          candidates: preview.candidates,
          refusals: preview.refusals,
          message:
            'Nothing can be safely re-armed for this operation. Satisfied entries keep their '
            + 'durable receipts and unresolved ones need reconcile, not a re-send.',
        }
      }
      return {
        success: false,
        requiresConfirmation: true,
        confirmationId: this.issueConfirmation(operationId, preview.previewRevision),
        operationId,
        previewRevision: preview.previewRevision,
        preview: steps,
        candidates: preview.candidates,
        refusals: preview.refusals,
        message:
          'Review the steps this resume would arm, then call resume_garmin_write_operation '
          + 'again with confirmed=true and this confirmationId. Only steps proven never to have '
          + 'applied are armed; unknown outcomes are never re-sent.',
      }
    }

    const execution = await coordinator.executeResume(
      await this.resolveStoredConfirmation(args.confirmationId, coordinator),
      this.resumeWriter(),
      { signal: this.options.shutdownSignal },
    )
    const results = execution.receipts.map(receipt => ({
      success: receipt.success,
      stepId: receipt.stepId,
      status: receipt.status,
      evidence: receipt.evidence,
      desiredStateSatisfied: receipt.desiredStateSatisfied,
      workoutId: receipt.workoutId ?? null,
      date: receipt.date ?? null,
      workoutScheduleId: receipt.workoutScheduleId ?? null,
      canResume: receipt.canResume,
      manualReviewRequired: receipt.manualReviewRequired,
      ...(receipt.errorCode ? { errorCode: receipt.errorCode } : {}),
      ...(receipt.nextAction ? { nextAction: receipt.nextAction } : {}),
      ...(receipt.message ? { message: receipt.message } : {}),
    }))
    return {
      success: results.every(result => result.status === 'succeeded' || result.status === 'skipped'),
      operationId: execution.operationId,
      resumed: true,
      total: results.length,
      unknownCount: results.filter(result => result.status === 'unknown' || result.status === 'in_flight').length,
      notAttemptedCount: results.filter(result => result.status === 'not_attempted').length,
      results,
      message: 'Resumed steps were dispatched at most once each. Re-query the operation for the durable outcome.',
    }
  }

  /**
   * A resume confirmation names a *stored* request, not a caller-supplied one.
   *
   * The approval binding for a resume is the preview revision: `resume()` bumps
   * it, which invalidates every handle minted before it. The request hash is
   * read back from the journal precisely because the caller cannot supply a
   * payload here, so there is nothing to bind it against; the coordinator still
   * checks both fields under the lock.
   */
  private async resolveStoredConfirmation(
    confirmationId: string | undefined,
    coordinator: WriteCoordinator,
  ): Promise<WriteConfirmation> {
    const decoded = decodeConfirmationId(confirmationId)
    if (!decoded) {
      throw new PublicToolError(
        'Invalid calendar confirmation: pass the confirmationId returned by the resume preview',
      )
    }
    const operation = await coordinator.getOperation(decoded.operationId)
    if (!operation) {
      throw new PublicToolError(
        'No local write operation matches this confirmation for this account',
      )
    }
    return { ...decoded, requestHash: operation.requestHash }
  }

  /**
   * The writer a resume is allowed to use.
   *
   * All three verbs are here because a resume may re-arm a create phase, a
   * schedule phase or an unschedule — but the coordinator only ever calls the
   * verb that matches the journaled step kind, and every definition it sends
   * comes from the journal, never from this layer.
   */
  private resumeWriter(): UnifiedCalendarWriter {
    return {
      schedule: async (workoutId, date) => {
        const result = await this.client.scheduleWorkout(workoutId, date)
        const id = result?.workoutScheduleId
        return {
          workoutScheduleId: typeof id === 'string' || typeof id === 'number' ? String(id) : null,
        }
      },
      addWorkout: async definition =>
        await this.client.addWorkout(
          buildGarminWorkout(definition as unknown as WorkoutDef),
        ) as unknown as { workoutId: string | number },
      unschedule: async (workoutScheduleId) => {
        await this.client.unscheduleWorkout(workoutScheduleId)
      },
    }
  }

  private issueConfirmation(operationId: string, previewRevision: number): string {
    return encodeConfirmationId(operationId, previewRevision)
  }

  /**
   * Resolve a caller-supplied handle into the persisted approval it names.
   * Only syntax is checked here; existence, request hash and revision are
   * checked by the coordinator from disk, immediately before any dispatch.
   */
  private resolveConfirmation(
    confirmationId: string | undefined,
    request: unknown,
  ): WriteConfirmation {
    const decoded = decodeConfirmationId(confirmationId)
    if (!decoded) {
      throw new PublicToolError(
        'Invalid calendar confirmation: pass the confirmationId returned by the preview',
      )
    }
    return { ...decoded, requestHash: requestHash(request) }
  }

  private validateScheduleRequest(args: {
    workoutId?: string
    date?: string
    timezone?: string
  }): { workoutId: string; date: string; timezone: string } {
    const workoutId = validateOpaqueId('workoutId', args.workoutId)
    return { workoutId, ...this.validateCalendarDate(args.date, args.timezone) }
  }

  private validateCalendarDate(
    dateValue: unknown,
    timezoneValue: unknown,
  ): { date: string; timezone: string } {
    const timezone = validateTimezone(timezoneValue)
    const date = validateDate('date', typeof dateValue === 'string' ? dateValue : '')
    if (date < todayInTimezone(timezone)) {
      throw new PublicToolError('Invalid date: Garmin Calendar scheduling only accepts today or a future local date')
    }
    return { date, timezone }
  }

  private validateBatchScheduleRequest(
    args: BatchScheduleWorkoutArgs,
  ): { schedules: Array<{ workoutId: string; date: string }>; timezone: string } {
    if (!Array.isArray(args.schedules) || args.schedules.length < 1 || args.schedules.length > 100) {
      throw new PublicToolError('Invalid schedules: expected 1 to 100 workout calendar entries')
    }
    const timezone = validateTimezone(args.timezone)
    const seen = new Set<string>()
    const schedules = args.schedules.map((schedule, index) => {
      const normalized = this.validateScheduleRequest({ ...schedule, timezone })
      const key = `${normalized.workoutId}\u0000${normalized.date}`
      if (seen.has(key)) {
        throw new PublicToolError(`Duplicate schedule entry for workoutId ${normalized.workoutId} on ${normalized.date}`)
      }
      seen.add(key)
      return { workoutId: normalized.workoutId, date: normalized.date, index }
    })
    return { timezone, schedules: schedules.map(({ workoutId, date }) => ({ workoutId, date })) }
  }
}

function missingRunningIntakeFields(args: RunningAdviceArgs): RunningIntakeField[] {
  const warningSymptomConflict = args.hasWarningSymptoms === false
    && containsWarningSymptomTerm(args.healthConstraints)
  return RUNNING_INTAKE_FIELDS.filter((field) => {
    const value = args[field]
    if (field === 'hasWarningSymptoms') {
      return typeof value !== 'boolean' || warningSymptomConflict
    }
    if (field === 'healthConstraints' && warningSymptomConflict) return true
    if (field === 'healthConstraints' && isExplicitNoHealthConstraint(value)) {
      return false
    }
    if (field === 'trainingPreference') {
      return !isOneOf(TRAINING_LOAD_PREFERENCES, value)
    }
    if (field === 'performanceBasis') {
      return !isOneOf(PERFORMANCE_BASES, value)
        || (value !== 'no_recent_benchmark'
          && !hasRecentPerformanceFacts(args.currentPerformance))
    }
    if (field === 'maxQualitySessionsPerWeek') {
      return typeof value !== 'number'
        || !Number.isInteger(value)
        || value < 0
        || value > 7
    }
    if (field === 'intensityGuidancePreference') {
      return !isOneOf(INTENSITY_GUIDANCE_PREFERENCES, value)
    }
    if (typeof value !== 'string'
      || Array.from(value.trim()).length < minimumIntakeLength(field)
      || isFactFreePlaceholder(value)
      || containsUnresolvedPlaceholder(value)) return true
    if (field === 'goal') return !hasConcreteGoal(value)
    if (field === 'currentPerformance'
      && args.performanceBasis !== 'no_recent_benchmark') {
      return !hasRecentPerformanceFacts(value)
    }
    if (field === 'trainingBackground') return !hasTrainingBackgroundDetails(value)
    if (field === 'availability') return !hasAvailabilityDetails(value)
    if (field === 'healthConstraints') return !hasHealthConstraintDetails(value)
    return false
  })
}

function containsQuantity(value: string): boolean {
  return /\d|\b(?:one|two|three|four|five|six|seven)\b|[一二两三四五六七八九十]/iu.test(value)
}

function validIsoDates(value: string): Date[] | null {
  const dates = value.match(/\b\d{4}-\d{2}-\d{2}\b/gu) ?? []
  const parsed: Date[] = []
  for (const date of dates) {
    try {
      parsed.push(parseLocalDate(date))
    } catch {
      return null
    }
  }
  return parsed
}

function localStartOfToday(): number {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
}

function earliestRecentPerformanceDate(): number {
  const now = new Date()
  return new Date(now.getFullYear() - 2, now.getMonth(), now.getDate()).getTime()
}

function hasRecentPerformanceFacts(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const performanceDates = validIsoDates(value)
  const today = localStartOfToday()
  const earliest = earliestRecentPerformanceDate()
  const dateMatches = [...value.matchAll(/\b\d{4}-\d{2}-\d{2}\b/gu)]
  if (!performanceDates || performanceDates.length === 0
    || !performanceDates.every(date => date.getTime() <= today)
    || !dateMatches.some((dateMatch, index) => {
      const timestamp = performanceDates[index].getTime()
      if (timestamp < earliest || timestamp > today) return false
      const previousDate = dateMatches[index - 1]
      const nextDate = dateMatches[index + 1]
      const start = previousDate
        ? (previousDate.index ?? 0) + previousDate[0].length
        : 0
      const end = nextDate?.index ?? value.length
      const datedContext = value.slice(start, end)
      return hasDistanceOrEventFact(datedContext)
        && hasTimedResultFact(datedContext)
    })) return false
  return hasDistanceOrEventFact(value)
    && hasTimedResultFact(value)
    && hasPerformanceEffortContext(value)
    && hasPerformanceConditionsContext(value)
    && !isFactFreePlaceholder(value)
}

function hasConcreteGoal(value: string): boolean {
  const goalDates = validIsoDates(value)
  if (!goalDates || goalDates.length === 0
    || !goalDates.every(date => date.getTime() > localStartOfToday())
    || !hasDistanceOrEventFact(value)) return false
  const hasTimedOutcome = hasTimedResultFact(value)
  if (/(?:完赛|完成比赛|finish|complete|completion)/iu.test(value)
    && !hasTimedOutcome) {
    return true
  }
  const hasTimedGoal = /(?:目标|target|goal|跑进|低于|少于|under|\bsub[- ]?\d)/iu.test(value)
    || hasTimedOutcome
  return hasTimedGoal && hasTimedOutcome && hasLabeledTimedGoalOutcomes(value)
}

function hasLabeledTimedGoalOutcomes(value: string): boolean {
  const labelPattern = /(?:minimum acceptable|minimum|floor|最低|保底|ideal|aspirational|理想|冲击)/giu
  const labels = [...value.matchAll(labelPattern)]
  let hasIdeal = false
  let hasMinimum = false
  labels.forEach((label, index) => {
    const start = (label.index ?? 0) + label[0].length
    const end = labels[index + 1]?.index ?? value.length
    const outcome = value.slice(start, end)
    if (!hasTimedResultFact(outcome) || containsUnresolvedPlaceholder(outcome)) return
    if (/(?:ideal|aspirational|理想|冲击)/iu.test(label[0])) hasIdeal = true
    else hasMinimum = true
  })
  return hasIdeal && hasMinimum
}

function hasPerformanceEffortContext(value: string): boolean {
  return /(?:all[- ]?out|full effort|not all[- ]?out|controlled effort|\bRPE\s*\d|全力|非全力|尽力|体感\s*\d|努力程度[^,，。;；]*(?:高|中|低|全力))/iu.test(value)
}

function hasPerformanceConditionsContext(value: string): boolean {
  return /(?:no material effect|(?:hot|cold|cool|warm|humid|windy|rainy|mild|normal)\s+(?:weather|conditions?)|(?:weather|conditions?)\s+(?:was\s+)?(?:hot|cold|cool|warm|humid|windy|rainy|mild|normal)|(?:flat|rolling|hilly|trail|road|track)\s+(?:course|terrain)|(?:course|terrain)\s+(?:was\s+)?(?:flat|rolling|hilly|technical)|(?:altitude|elevation)\s*(?:was\s+)?(?:\d+\s*(?:m|ft)|high|low|sea level)|(?:calm|strong|head|tail|cross)\s*wind|天气(?:炎热|寒冷|凉爽|温暖|潮湿|正常|有雨)|(?:平坦|起伏|丘陵|越野|公路|田径场)(?:赛道|路线|地形)|(?:赛道|路线|地形)(?:平坦|起伏|丘陵|技术性强)|海拔\s*(?:\d+\s*米|较高|较低|正常|海平面)|(?:无风|大风|逆风|顺风|侧风)|无明显影响)/iu.test(value)
}

function hasTrainingBackgroundDetails(value: string): boolean {
  return containsQuantity(value)
    && hasRunningHistoryDuration(value)
    && hasPositiveLoadNearLabel(value, /(?:average|\bavg\b|平均)/giu)
    && hasPositiveLoadNearLabel(value, /(?:peak|highest|\bmax\b|最高)/giu)
    && hasWeeklyFrequencyFact(value)
    && hasPositiveLoadNearLabel(value, /(?:longest|long run|最长|长跑)/giu)
    && /(?:\b(?:one|two|three|four|five|six|seven|\d+)\b[^,，。;；]{0,20}(?:quality|threshold|interval|tempo|strides)|(?:quality|threshold|interval|tempo|strides)[^,，。;；]{0,20}\b(?:one|two|three|four|five|six|seven|\d+)\b|no quality|质量|门槛|间歇|节奏|加速跑|无质量)/iu.test(value)
    && /(?:interrupt|break|abrupt|load change|consistent|stable load|中断|突变|负荷变化|负荷稳定|无中断)/iu.test(value)
}

function hasAvailabilityDetails(value: string): boolean {
  return containsQuantity(value)
    && hasRunningSessionTimeFact(value)
    && hasWeeklyFrequencyFact(value)
    && /(?:rest day|day off|\boff\b|休息日|休息)/iu.test(value)
    && /(?:long[- ]?run day|long run|长跑日|长跑)/iu.test(value)
    && /(?:track|road|trail|treadmill|hill|facility|terrain|场地|道路|公路|越野|跑步机|坡)/iu.test(value)
    && hasStrengthAvailabilityFact(value)
    && /(?:double days?|two[- ]a[- ]days?|no doubles?|doubles? unavailable|双练)/iu.test(value)
}

function hasHealthConstraintDetails(value: string): boolean {
  return hasCurrentPainOrInjuryFact(value)
    && /(?:past year|previous year|last year|(?:past|last|previous) 12 months|过去一年|近一年|过去 12 个月|近 12 个月)/iu.test(value)
    && /(?:disease|condition|疾病|无相关疾病)/iu.test(value)
    && /(?:medication|medicine|meds?|用药|服药|无相关用药)/iu.test(value)
    && /(?:sleep|睡眠)/iu.test(value)
    && /(?:stress|压力)/iu.test(value)
    && /(?:recovery|恢复)/iu.test(value)
}

function hasWeeklyFrequencyFact(value: string): boolean {
  const numericPattern = /(?<![-\d.])([+-]?\d+)\s+(?:days?|runs?)\s+(?:a|per)\s+(?:week|wk)|(?<![-\d.])([+-]?\d+)\s*(?:x|times?)\s*(?:\/|per)\s*(?:week|wk)|每周\s*(?:可|能|有|安排)?\s*(?:跑步?|训练)?\s*(?<![-\d.])([+-]?\d+)\s*(?:天|次)/giu
  if (hasNumericMatchInRange(
    value,
    numericPattern,
    1,
    7,
    match => isRunningRelevantClause(value, match.index, match[0].length),
  )) return true

  const wordPatterns = [
    /\b(?:one|two|three|four|five|six|seven)\s+(?:days?|runs?)\s+(?:a|per)\s+(?:week|wk)\b/giu,
    /每周\s*(?:可|能|有|安排)?\s*(?:跑步?|训练)?\s*[一二两三四五六七]\s*(?:天|次)/giu,
  ]
  return wordPatterns.some(pattern => [...value.matchAll(pattern)].some(match => (
    isRunningRelevantClause(value, match.index ?? 0, match[0].length)
  )))
}

function hasRunningHistoryDuration(value: string): boolean {
  const durationPattern = /(?:running\s+for|have\s+run\s+for|runner\s+for|running\s+history\s*(?:of|[:：])|started\s+running\s+)(?:about\s+|approximately\s+)?\s*(?<![-\d.])([+-]?\d+(?:\.\d+)?)\s*(?:years?|months?|weeks?)|(?<![-\d.])([+-]?\d+(?:\.\d+)?)\s*(?:years?|months?|weeks?)\s+(?:of\s+running|as\s+a\s+runner)|(?:跑龄|跑步)[^,，。;；]{0,8}(?<![-\d.])([+-]?\d+(?:\.\d+)?)\s*(?:年|个?月|周)/giu
  if (hasPositiveNumericMatch(value, durationPattern)) return true
  if (/(?:running\s+for|have\s+run\s+for|runner\s+for|running\s+history\s*(?:of|[:：])|started\s+running\s+)(?:about\s+|approximately\s+)?\s*(?:one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:years?|months?|weeks?)/iu.test(value)) {
    return true
  }
  if (/(?:跑龄|跑步)[^,，。;；]{0,8}[一二两三四五六七八九十]+\s*(?:年|个?月)/iu.test(value)) {
    return true
  }

  const currentYear = new Date().getFullYear()
  const sincePattern = /(?:running\s+since|started\s+running\s+in)\s*(\d{4})|(?:从\s*)?(\d{4})\s*年\s*(?:开始)?跑步/giu
  let match: RegExpExecArray | null
  while ((match = sincePattern.exec(value)) !== null) {
    const year = Number(match[1] ?? match[2])
    if (year >= 1900 && year <= currentYear) return true
  }
  return false
}

function hasRunningSessionTimeFact(value: string): boolean {
  const durationPattern = /(?<![-\d.])([+-]?\d+(?:\.\d+)?)\s*(?:minutes?|mins?|hours?|hrs?)\s*(?:each\b|per\s+(?:run|running\s+day|training\s+day|session|day)\b)|(?:each(?:\s+(?:run|running\s+day|training\s+day|session|day))?|per\s+(?:run|running\s+day|training\s+day|session|day))[^,;]{0,12}(?<![-\d.])([+-]?\d+(?:\.\d+)?)\s*(?:minutes?|mins?|hours?|hrs?)|(?:每次|每个(?:跑步|训练)日|每天)[^,，。;；]{0,12}(?<![-\d.])([+-]?\d+(?:\.\d+)?)\s*(?:分钟|小时)/giu
  let duration: RegExpExecArray | null
  while ((duration = durationPattern.exec(value)) !== null) {
    if (duration.slice(1).some(capture => capture !== undefined && Number(capture) > 0)
      && isRunningRelevantClause(value, duration.index, duration[0].length)) return true
  }
  const scheduledDurationPattern = /(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|周[一二三四五六日天])[^,，。;；]{0,18}(?<![-\d.])([+-]?\d+(?:\.\d+)?)\s*(?:minutes?|mins?|hours?|hrs?|分钟|小时)/giu
  let scheduled: RegExpExecArray | null
  while ((scheduled = scheduledDurationPattern.exec(value)) !== null) {
    if (scheduled.slice(1).some(capture => capture !== undefined && Number(capture) > 0)
      && isRunningRelevantClause(value, scheduled.index, scheduled[0].length)) return true
  }
  const wordDurationPattern = /(?:one|two|three|four|five|six)\s+(?:minutes?|hours?)\s+(?:each\b|per\s+(?:run|session|day)\b)/giu
  return [...value.matchAll(wordDurationPattern)].some(match => (
    isRunningRelevantClause(value, match.index ?? 0, match[0].length)
  ))
}

function hasCurrentPainOrInjuryFact(value: string): boolean {
  const painOrInjury = /(?:pain[- ]?free|injury[- ]?free|pain(?![- ]?(?:medication|medicine|meds?|killers?))|injur(?:y|ies|ed))/iu
  const englishCurrent = /\b(?:current(?:ly)?|presently|now)\b/giu
  for (const current of value.matchAll(englishCurrent)) {
    const index = current.index ?? 0
    const before = value.slice(0, index)
    const after = value.slice(index + current[0].length)
    const clauseStart = Math.max(
      before.lastIndexOf(','),
      before.lastIndexOf(';'),
      before.lastIndexOf('.'),
    ) + 1
    const boundaryOffsets = [',', ';', '.']
      .map(boundary => after.indexOf(boundary))
      .filter(offset => offset >= 0)
    const clauseEnd = boundaryOffsets.length > 0
      ? index + current[0].length + Math.min(...boundaryOffsets)
      : value.length
    const clause = value.slice(clauseStart, clauseEnd)
    if (painOrInjury.test(clause)) return true
  }
  return /(?:目前|当前|现在)[^,，。;；]{0,24}(?:疼痛|痛|伤病|受伤|无伤)/iu.test(value)
}

function hasNumericMatchInRange(
  value: string,
  pattern: RegExp,
  minimum: number,
  maximum: number,
  acceptMatch: (match: RegExpExecArray) => boolean = () => true,
): boolean {
  let match: RegExpExecArray | null
  while ((match = pattern.exec(value)) !== null) {
    if (match.slice(1).some((capture) => {
      if (capture === undefined) return false
      const number = Number(capture)
      return Number.isInteger(number) && number >= minimum && number <= maximum
    }) && acceptMatch(match)) return true
  }
  return false
}

function isRunningRelevantClause(value: string, index: number, length: number): boolean {
  const before = value.slice(0, index)
  const after = value.slice(index + length)
  const clauseStart = Math.max(
    before.lastIndexOf(','),
    before.lastIndexOf('，'),
    before.lastIndexOf(';'),
    before.lastIndexOf('；'),
    before.lastIndexOf('.'),
    before.lastIndexOf('。'),
  ) + 1
  const boundaryOffsets = [',', '，', ';', '；', '.', '。']
    .map(boundary => after.indexOf(boundary))
    .filter(offset => offset >= 0)
  const clauseEnd = boundaryOffsets.length > 0
    ? index + length + Math.min(...boundaryOffsets)
    : value.length
  const clause = value.slice(clauseStart, clauseEnd)
  const mentionsOtherTraining = /(?:strength|resistance|cycling|biking|bike|swimming|rowing|elliptical|力量|抗阻|骑行|骑车|游泳|划船|椭圆机)/iu.test(clause)
  const mentionsRunning = /(?:\bruns?\b|\brunning\b|跑步|跑训)/iu.test(clause)
  return !mentionsOtherTraining || mentionsRunning
}

function hasPositiveLoadNearLabel(value: string, labelPattern: RegExp): boolean {
  const labels = [...value.matchAll(labelPattern)]
  return labels.some((label) => {
    const start = (label.index ?? 0) + label[0].length
    const following = value.slice(start, start + 48)
    const nextField = following.search(/[,，。;；]|\band\s+(?=(?:average|avg|peak|highest|max|longest|long run)\b)|(?=(?:平均|最高|最长))/iu)
    const fieldValue = nextField >= 0 ? following.slice(0, nextField) : following
    const loadPattern = /(?<![-\d.])([+-]?\d+(?:\.\d+)?)\s*(?:k(?:m)?|kilomet(?:er|re)s?|mi(?:le)?s?|minutes?|mins?|hours?|hrs?|公里|千米|英里|分钟|小时)/giu
    return hasPositiveNumericMatch(fieldValue, loadPattern)
  })
}

function hasStrengthAvailabilityFact(value: string): boolean {
  if (/(?:no|without|unavailable)[^,，。;；]{0,16}(?:strength|resistance)|(?:strength|resistance)[^,，。;；]{0,16}(?:unavailable|none)|(?:无|不安排)[^,，。;；]{0,12}(?:力量|抗阻)/iu.test(value)) {
    return true
  }
  const durationPattern = /(?:strength|resistance|力量|抗阻)[^,，。;；]{0,24}(?<![-\d.])([+-]?\d+(?:\.\d+)?)\s*(?:minutes?|mins?|hours?|hrs?|分钟|小时)|(?<![-\d.])([+-]?\d+(?:\.\d+)?)\s*(?:minutes?|mins?|hours?|hrs?|分钟|小时)[^,，。;；]{0,24}(?:strength|resistance|力量|抗阻)/giu
  return hasPositiveNumericMatch(value, durationPattern)
}

function hasDistanceOrEventFact(value: string): boolean {
  if (/(?:\b(?:half[- ]?marathon|marathon|mile)\b|全程马拉松|半程马拉松|全马|半马|马拉松)/iu.test(value)) {
    return true
  }
  const distancePattern = /(?<![\d.])(-?\d+(?:\.\d+)?)\s*(?:k(?:m)?|m|kilomet(?:er|re)s?|mi(?:le)?s?)\b|(?<![\d.])(-?\d+(?:\.\d+)?)\s*(?:公里|千米|英里)/giu
  return hasPositiveNumericMatch(value, distancePattern)
}

function hasTimedResultFact(value: string): boolean {
  const clockPattern = /(?<![\d.])(-?\d{1,2}):([0-5]\d)(?::([0-5]\d))?\b/gu
  let clock: RegExpExecArray | null
  while ((clock = clockPattern.exec(value)) !== null) {
    if (clock[1].startsWith('-')) continue
    const parts = clock.slice(1).filter(part => part !== undefined).map(Number)
    if (parts.some(part => part > 0)) return true
  }
  const durationPattern = /(?<![\d.])(-?\d+(?:\.\d+)?)\s*(?:hours?|hrs?|minutes?|mins?|seconds?|secs?)\b|(?<![\d.])(-?\d+(?:\.\d+)?)\s*(?:小时|分钟|分|秒)/giu
  if (hasPositiveNumericMatch(value, durationPattern)) return true
  const apostrophePacePattern = /(?<![\d.])(-?\d{1,2})\s*['′]\s*([0-5]\d)\s*["″]?/gu
  let pace: RegExpExecArray | null
  while ((pace = apostrophePacePattern.exec(value)) !== null) {
    if (pace[1].startsWith('-')) continue
    if (Number(pace[1]) > 0 || Number(pace[2]) > 0) return true
  }
  return false
}

function hasPositiveNumericMatch(value: string, pattern: RegExp): boolean {
  let match: RegExpExecArray | null
  while ((match = pattern.exec(value)) !== null) {
    if (match.slice(1).some(capture => capture !== undefined && Number(capture) > 0)) {
      return true
    }
  }
  return false
}

function isExplicitNoHealthConstraint(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const normalized = value.normalize('NFKC').trim().toLowerCase()
    .replace(/[\s?!.。,，!！?？_\-/]/gu, '')
  return new Set([
    'none',
    'noconstraints',
    'nohealthconstraints',
    '无',
    '没有',
    '无约束',
    '无健康约束',
  ]).has(normalized)
}

function containsWarningSymptomTerm(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return /(?:chest\s+(?:discomfort|pain|pressure|tightness|heaviness|aches?)|(?:pressure|pain|tightness|heaviness|aches?)\s+(?:in|across)\s+(?:my\s+|the\s+)?chest|unusual\s+breathlessness|shortness\s+of\s+breath|breathless(?:ness)?|dyspn(?:ea|oea)|cannot\s+breathe|faint(?:ing|ed)?|syncope|(?:lost|loss\s+of)\s+consciousness|dizz(?:y|iness)|light[- ]?headed(?:ness)?|pass(?:ed)?\s+out|black(?:ed)?\s+out|palpitations?|heart\s+(?:races?|racing|flutters?|fluttering|pounds?|pounding)|irregular\s+heartbeat|胸部不适|胸痛|胸闷|胸(?:口|部)(?:有|感到)?(?:压迫(?:感)?|痛|疼)|异常气短|气短|喘不过气|呼吸困难|晕厥|晕倒|昏倒|昏厥|失去意识|眼前发黑|眩晕|头晕|心悸|心慌|心跳异常|心跳过快)/iu.test(value)
}

function containsUnresolvedPlaceholder(value: string): boolean {
  return /(?:\b(?:TBD|unknown|n\/?a)\b|待定|未知|不知道)/iu.test(value)
}

function isFactFreePlaceholder(value: string): boolean {
  const normalized = value.normalize('NFKC').trim().toLowerCase()
    .replace(/[\s?!.。,，!！?？_\-/]/gu, '')
  return new Set([
    'x',
    'xx',
    'xxx',
    'none',
    'unknown',
    'tbd',
    'ok',
    'na',
    'n/a',
    '不知道',
    '未知',
    '待定',
  ]).has(normalized)
}

function minimumIntakeLength(field: RunningIntakeField): number {
  switch (field) {
    case 'goal':
    case 'currentPerformance':
    case 'trainingBackground':
    case 'availability':
    case 'healthConstraints':
      return RUNNING_INTAKE_MIN_LENGTHS[field]
    default:
      return 1
  }
}

function isOneOf<const Values extends readonly string[]>(
  values: Values,
  value: unknown,
): value is Values[number] {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
}

function runningIntakeQuestion(
  field: RunningIntakeField,
  language: CoachingLanguage,
): string {
  const questions: Record<RunningIntakeField, { 'zh-CN': string; en: string }> = {
    goal: {
      'zh-CN': '你的训练目标是什么？请说明距离或赛事、未来的 ISO YYYY-MM-DD 日期，以及目标是完赛还是目标成绩；若有成绩目标，请区分理想目标和最低可接受目标。',
      en: 'What is your goal? Include the distance or event, a future ISO YYYY-MM-DD date, and whether the aim is completion or a target time; for a time goal, distinguish the ideal from the minimum acceptable outcome.',
    },
    currentPerformance: {
      'zh-CN': '你目前的成绩水平如何？请提供近期（过去两年内）代表性的比赛或计时测试距离、成绩和不晚于今天的 ISO YYYY-MM-DD 日期，并说明是否全力以及天气、赛道或海拔是否明显影响；若没有基准也请明确说明。',
      en: 'What is your current performance level? Give a representative race or time trial from the past two years, including distance, result, a non-future ISO YYYY-MM-DD date, whether it was all-out, and any major weather, course, or altitude effect; explicitly say if no benchmark exists.',
    },
    performanceBasis: {
      'zh-CN': '当前水平依据是什么：近期比赛（recent_race）、计时测试（time_trial），还是暂无近期基准（no_recent_benchmark）？',
      en: 'What is the performance basis: a recent race (recent_race), time trial (time_trial), or no recent benchmark (no_recent_benchmark)?',
    },
    trainingBackground: {
      'zh-CN': '请说明跑龄、最近 4–8 周平均和最高周跑量或时长、每周跑步天数、最长跑、质量课，以及近三个月中断或负荷突变。',
      en: 'Describe your running history, average and peak weekly volume or time over the last 4–8 weeks, days per week, longest run, quality sessions, and interruptions or abrupt load changes in the last three months.',
    },
    availability: {
      'zh-CN': '你每周可跑几天、各天可用多久、固定休息日和长跑日是什么？有哪些场地或器材限制，能安排多少力量训练时间？双练默认不安排；若你有双练条件也请明确说明。',
      en: 'How many days and how much time can you train each week? State fixed rest and long-run days, facility or terrain limits, and available strength-training time. Double days default to unavailable; explicitly say if they are possible.',
    },
    healthConstraints: {
      'zh-CN': '请说明当前疼痛/伤病、过去一年主要跑伤、已知心血管/代谢/肾脏疾病、影响心率的用药，以及睡眠、压力和恢复；没有也请明确回答。',
      en: 'Describe current pain/injury, major running injuries in the past year, known cardiovascular/metabolic/kidney disease, medication affecting heart rate, and sleep, stress, and recovery; explicitly say none if applicable.',
    },
    hasWarningSymptoms: {
      'zh-CN': '目前是否有胸部不适、轻微活动异常气短、晕厥/眩晕或异常心悸等健康警示症状？请明确回答 true 或 false；若健康描述出现这些词但你填写 false，请澄清矛盾：存在就改为 true，确实不存在就把健康描述改写成不含歧义症状词的明确“无”。',
      en: 'Do you currently have warning symptoms such as chest discomfort, unusual breathlessness with mild activity, fainting/dizziness, or abnormal palpitations? Answer true or false explicitly; if the health text mentions these terms while the flag is false, resolve the conflict: set true when present, or restate the health answer as clearly absent without ambiguous symptom wording.',
    },
    trainingPreference: {
      'zh-CN': '你偏好哪种负荷模式：均匀稳定、艰苦日与轻松日反差明显，还是混合/无偏好？',
      en: 'Which load pattern do you prefer: steady and even, clearly separated hard/easy days, or mixed/no preference?',
    },
    maxQualitySessionsPerWeek: {
      'zh-CN': '你每周最多愿意且有条件完成几次质量课？请给出 0–7 的整数；这只是个人上限，不代表计划一定会安排这么多。',
      en: 'What is the maximum number of quality sessions you are willing and able to complete per week (integer 0–7)? This is a personal ceiling, not a prescription.',
    },
    intensityGuidancePreference: {
      'zh-CN': '你更喜欢用配速（pace）、心率（heart_rate）、RPE/体感（rpe）还是混合方式（mixed）执行强度？',
      en: 'How do you prefer intensity guidance: pace, heart rate (heart_rate), perceived effort (rpe), or mixed?',
    },
  }
  return questions[field][language]
}

function orderTrainingPhilosophies(
  preference: NonNullable<RunningAdviceArgs['trainingPreference']>,
): TrainingPhilosophy[] {
  const preferredId = preference === 'steady'
    ? 'hansons'
    : preference === 'hard_easy'
      ? 'polarized'
      : 'daniels'
  return [...TRAINING_PHILOSOPHIES].sort((left, right) => (
    Number(right.id === preferredId) - Number(left.id === preferredId)
  ))
}

class AsyncSemaphore {
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async run<T>(action: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>(resolve => this.waiters.push(resolve))
    }
    this.active += 1
    try {
      return await action()
    } finally {
      this.active -= 1
      this.waiters.shift()?.()
    }
  }
}

function validateOpaqueId(label: string, value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) {
    throw new PublicToolError(`Invalid ${label}: expected a non-empty identifier`)
  }
  return value.trim()
}

function validateTimezone(value: unknown): string {
  const timezone = value === undefined ? Intl.DateTimeFormat().resolvedOptions().timeZone : value
  if (typeof timezone !== 'string' || !timezone.trim() || timezone.length > 100) {
    throw new PublicToolError('Invalid timezone: expected an IANA timezone such as Asia/Shanghai')
  }
  try {
    Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format()
  } catch {
    throw new PublicToolError('Invalid timezone: expected an IANA timezone such as Asia/Shanghai')
  }
  return timezone
}

function todayInTimezone(timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const byType = new Map(parts.map(part => [part.type, part.value]))
  return `${byType.get('year')}-${byType.get('month')}-${byType.get('day')}`
}

function workoutName(workout: unknown): string | null {
  if (!workout || typeof workout !== 'object') return null
  const name = (workout as Record<string, unknown>).workoutName
  return typeof name === 'string' ? name : null
}

function validateDate(name: string, value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) throw invalidDate(name)

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const parsed = new Date(year, month - 1, day)
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    throw invalidDate(name)
  }

  return value
}

function invalidDate(name: string): Error {
  return new PublicToolError(`Invalid ${name}: expected a real date in YYYY-MM-DD format`)
}

/** Default and maximum page size for a local journal listing. */
export const WRITE_OPERATION_PAGE_DEFAULT_LIMIT = 20
export const WRITE_OPERATION_PAGE_MAX_LIMIT = 100

const OPERATION_CURSOR_VERSION = 1
/**
 * The cursor alphabet. It deliberately excludes `/`, `.` and whitespace, so a
 * cursor can never double as a path fragment, and it is length-bounded so a
 * caller cannot hand this build an unbounded string to decode.
 */
export const OPERATION_CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,2048}$/

interface OperationCursorPayload {
  v: typeof OPERATION_CURSOR_VERSION
  offset: number
  digest: string
}

function normalizePageLimit(limit: number | undefined): number {
  if (limit === undefined) return WRITE_OPERATION_PAGE_DEFAULT_LIMIT
  if (!Number.isInteger(limit) || limit < 1) {
    throw new PublicToolError('Invalid limit: expected a positive integer')
  }
  return Math.min(limit, WRITE_OPERATION_PAGE_MAX_LIMIT)
}

/**
 * A fingerprint of the listed journal.
 *
 * It covers identity *and* order *and* last-modified time, so any addition,
 * removal, reorder or in-place advance of a record invalidates every cursor
 * minted before it. Length is included so a truncated read cannot hash to the
 * same value as a full one.
 */
function journalDigest(
  operations: ReadonlyArray<{ operationId?: string; updatedAt?: string }>,
): string {
  const hash = createHash('sha256')
  hash.update(`garmin-write-journal-page:${operations.length}\n`)
  for (const operation of operations) {
    hash.update(`${operation.operationId ?? '?'}\u0000${operation.updatedAt ?? '?'}\n`)
  }
  return hash.digest('hex')
}

function encodeOperationCursor(payload: OperationCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

/**
 * Decode a cursor, or return `null` for anything this build cannot have minted.
 *
 * Every rejection is a `null` rather than a repair: a cursor that was edited,
 * truncated or produced by another build names an unknown position, and
 * guessing one would page through records the caller never asked for.
 */
function decodeOperationCursor(cursor: unknown): OperationCursorPayload | null {
  if (typeof cursor !== 'string' || !OPERATION_CURSOR_PATTERN.test(cursor)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const payload = parsed as Record<string, unknown>
  if (payload.v !== OPERATION_CURSOR_VERSION) return null
  if (!Number.isInteger(payload.offset) || (payload.offset as number) < 0) return null
  if ((payload.offset as number) > 1_000_000) return null
  if (typeof payload.digest !== 'string' || !/^[0-9a-f]{64}$/.test(payload.digest)) return null
  return {
    v: OPERATION_CURSOR_VERSION,
    offset: payload.offset as number,
    digest: payload.digest,
  }
}

/**
 * The host's IANA timezone, used when a calendar query omits one.
 *
 * It is only ever echoed back on the snapshot: the verified provider query
 * carries no timezone parameter, so no date is ever shifted by this value.
 */
function hostTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (typeof zone === 'string' && zone.trim()) return zone
  } catch {
    // An environment without a resolvable zone falls back below.
  }
  return 'UTC'
}

function calendarUnsupportedMessage(): string {
  return 'No verified Garmin Calendar read is ' +
    'available for this account, so the calendar cannot be observed. This is not an empty ' +
    'calendar, and no conclusion about any scheduled entry may be drawn from it.'
}

/**
 * Enforce the calendar-range contract before any read is issued.
 *
 * The adapter validates the same range, but a caller can inject a reader seam
 * that skips the adapter entirely, so this is not redundant belt-and-braces:
 * it is the only validation on that path. An over-long range is rejected rather
 * than truncated, because a silently shortened range would read as a complete
 * answer for a range nobody asked about.
 */
function validateCalendarQuery(args: CalendarRangeArgs): CalendarRange {
  const startDate = requireCalendarDate('startDate', args.startDate)
  const endDate = requireCalendarDate('endDate', args.endDate)
  if (startDate > endDate) {
    throw new CalendarRangeError(
      'CALENDAR_RANGE_INVALID',
      `Invalid date range: endDate ${endDate} is before startDate ${startDate}`,
    )
  }
  const days = calendarDayCount(startDate, endDate)
  if (days > MAX_CALENDAR_RANGE_DAYS) {
    throw new CalendarRangeError(
      'CALENDAR_RANGE_TOO_LONG',
      `Calendar range covers ${days} days; the maximum is ${MAX_CALENDAR_RANGE_DAYS}`,
    )
  }

  const timezone = args.timezone === undefined ? hostTimeZone() : args.timezone
  if (typeof timezone !== 'string' || !timezone.trim() || timezone.length > 100) {
    throw new CalendarRangeError(
      'CALENDAR_RANGE_INVALID',
      'Invalid timezone: expected a non-empty IANA timezone label such as Asia/Shanghai',
    )
  }

  return { startDate, endDate, timezone }
}

function requireCalendarDate(name: string, value: unknown): string {
  if (typeof value !== 'string' || !isValidCalendarDate(value)) {
    throw new CalendarRangeError(
      'CALENDAR_RANGE_INVALID',
      `Invalid ${name}: expected a real date in YYYY-MM-DD format`,
    )
  }
  return value
}

export function getDatesInRange(start: string, end: string): string[] {
  const current = localDate(validateDate('startDate', start))
  const last = localDate(validateDate('endDate', end))
  if (current > last) {
    throw new PublicToolError('Invalid date range: endDate must be on or after startDate')
  }

  const dates: string[] = []
  while (current <= last) {
    if (dates.length === 30) throw new PublicToolError('Date range cannot exceed 30 days')
    dates.push(localDateString(current))
    current.setDate(current.getDate() + 1)
  }
  return dates
}

function localDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day)
}

function localDateString(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let nextIndex = 0
  let failed = false
  let firstFailure: unknown

  async function worker(): Promise<void> {
    while (nextIndex < values.length && !failed) {
      const index = nextIndex
      nextIndex += 1
      try {
        results[index] = await mapper(values[index])
      } catch (error) {
        if (!failed) {
          failed = true
          firstFailure = error
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  )
  if (failed) throw firstFailure
  return results
}

export function todayLocal(): string {
  return localDateString(new Date())
}

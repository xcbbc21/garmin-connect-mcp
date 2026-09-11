/**
 * Read-only reconciliation and safe-resume planning for uncertain writes.
 *
 * This module is deliberately free of network access and of any writer. It
 * answers exactly two questions, both from data it is handed:
 *
 *   1. "Which calendar windows must be read to describe the current state of
 *      this operation's targets, and what does one read say about them?"
 *      (`planReconcile`, `classifySnapshot`, `applyObservation`)
 *
 *   2. "Which steps may a `resume` arm?" (`planResumeCandidates`)
 *
 * Two rules shape everything here, and both exist because a range read is a
 * *query conclusion*, not a receipt:
 *
 *   - A read never changes a step's `status`. `observed_present` may record
 *     `evidence: observed_present` and `desiredStateSatisfied: true`, but an
 *     `unknown` attempt keeps its `unknown` status: the read shows the target
 *     exists now, not that this attempt created it. Only a provider receipt
 *     (`evidence: response`) can retire an `unknown`.
 *   - An absence observed in a complete range is *never* converted into
 *     "the POST did not happen". It is stored as `evidence: observed_absent`,
 *     and every report that carries it says so in words.
 *
 * `planResumeCandidates` never returns an `unknown` / `in_flight` step, no
 * matter what a read reported, and it accepts no replacement payload: resume
 * can only re-arm a step that already exists in the journal.
 */

import {
  MAX_CALENDAR_RANGE_DAYS,
  calendarDayCount,
} from '../calendar/adapter'
import {
  observeCalendarTarget,
  type CalendarEntry,
  type CalendarRange,
  type CalendarSnapshot,
  type CalendarTarget,
} from '../calendar/types'
import { GarminWriteError, isGarminWriteError } from './errors'
import type { WriteErrorCode } from './errors'
import { WRITE_ERROR_CODES } from './errors'
import {
  BLOCKING_STEP_STATUSES,
  RETRYABLE_STEP_STATUSES,
  SATISFIED_STEP_STATUSES,
  type DuplicatePolicy,
  type OperationDocument,
  type StepStatus,
  type WriteEvidence,
  type WriteOperation,
  type WriteStep,
} from './types'

// Re-exported so preflight callers can name the policy without reaching into
// the journal types module.
export type { DuplicatePolicy }

/** Hard cap on provider GETs issued by one reconcile pass (spec §5.2). */
export const RECONCILE_MAX_READS = 3
/** Hard cap on wall-clock time spent reading by one reconcile pass. */
export const RECONCILE_BUDGET_MS = 20_000

/** Timezone label the journal never stores per step; reads are day-based. */
export const RECONCILE_TIMEZONE = 'UTC'

/**
 * Upper bound on how many "the target is gone" generations of one schedule
 * target are followed before the journal is reported as needing review.
 */
export const MAX_SCHEDULE_KEY_GENERATION = 32

export type ReconcileTier = 'blocking' | 'retryable' | 'satisfied'

// ---------------------------------------------------------------------------
// Read budget
// ---------------------------------------------------------------------------

/**
 * The budget is counted in provider GETs, not in `getCalendarRange` calls: one
 * call may fan out into several requests (month chunks), and the spec bounds
 * the GETs.
 */
export interface ReadBudget {
  readonly maxReads: number
  readonly budgetMs: number
  readonly startedAtMs: number
  reads: number
  exhaustedBy?: 'read_limit' | 'time_budget'
}

export function createReadBudget(options: {
  startedAtMs: number
  maxReads?: number
  budgetMs?: number
}): ReadBudget {
  return {
    startedAtMs: options.startedAtMs,
    maxReads: Math.max(0, Math.trunc(options.maxReads ?? RECONCILE_MAX_READS)),
    budgetMs: Math.max(0, Math.trunc(options.budgetMs ?? RECONCILE_BUDGET_MS)),
    reads: 0,
  }
}

/**
 * Whether one more read may be issued. A read is refused as soon as the read
 * cap is reached or the time budget has run out, and the refusal is sticky so
 * the caller stops instead of discovering the limit again per step.
 */
export function mayIssueRead(
  budget: ReadBudget,
  nowMs: number,
): { ok: true } | { ok: false; reason: 'read_limit' | 'time_budget' } {
  if (budget.exhaustedBy) return { ok: false, reason: budget.exhaustedBy }
  if (budget.reads >= budget.maxReads) {
    budget.exhaustedBy = 'read_limit'
    return { ok: false, reason: 'read_limit' }
  }
  if (nowMs - budget.startedAtMs >= budget.budgetMs) {
    budget.exhaustedBy = 'time_budget'
    return { ok: false, reason: 'time_budget' }
  }
  return { ok: true }
}

/**
 * Charge a completed read against the budget using the provider request count
 * the adapter reported. A transport that under-reports `requestsIssued` cannot
 * spend less than one GET per read, so the charge never drops below 1.
 */
export function chargeRead(budget: ReadBudget, snapshot?: { requestsIssued?: number }): void {
  const issued = Math.max(1, Math.trunc(snapshot?.requestsIssued ?? 1))
  budget.reads += issued
}

// ---------------------------------------------------------------------------
// Read planning
// ---------------------------------------------------------------------------

export interface ReconcileReadTarget {
  step: WriteStep
  tier: ReconcileTier
  /** Inclusive window that must be read for this target. */
  range: { startDate: string; endDate: string }
  target: CalendarTarget
}

export interface ReconcileWindow {
  range: { startDate: string; endDate: string; timezone: string }
  targets: ReconcileReadTarget[]
}

/** A step whose current state a range read cannot speak about at all. */
export interface UnreadableStep {
  step: WriteStep
  code: WriteErrorCode
  detail: string
}

export interface ReconcilePlan {
  windows: ReconcileWindow[]
  unreadable: UnreadableStep[]
  /** Targets left out because the read budget ran out. */
  deferred: ReconcileReadTarget[]
}

const UNREADABLE_DETAILS = {
  create:
    'A calendar range read lists scheduled entries, not workout-library templates, '
    + 'so it cannot confirm whether this template was created.',
  unschedule:
    'This journal holds no calendar day for the schedule id, so a range read has no '
    + 'window to inspect; a schedule id can only be identified by reading the day it '
    + 'was scheduled on.',
} as const

/**
 * Decide which windows to read, in priority order, within the read budget.
 *
 * Priority is blocking > retryable > satisfied, so a pass that runs out of
 * budget still spends its reads on the steps that block new writes. Steps that
 * were never dispatched (`prepared`) need no observation and are excluded.
 *
 * Concurrent dates are merged into contiguous windows because the provider
 * charges per range read, not per day: a 20-day batch costs one read.
 */
export function planReconcile(
  operation: WriteOperation,
  document: OperationDocument,
  options: { maxReads?: number } = {},
): ReconcilePlan {
  const maxReads = Math.max(0, Math.trunc(options.maxReads ?? RECONCILE_MAX_READS))
  const targets: ReconcileReadTarget[] = []
  const unreadable: UnreadableStep[] = []

  for (const step of operation.steps) {
    const tier = tierOf(step)
    if (!tier) continue
    const target = targetOf(step, document)
    if (typeof target === 'string') {
      unreadable.push({ step, code: unreadableCodeFor(step), detail: target })
      continue
    }
    if (!target) continue
    targets.push({ step, tier, ...target })
  }

  return buildWindows(targets, unreadable, maxReads)
}

function tierOf(step: WriteStep): ReconcileTier | undefined {
  if (BLOCKING_STEP_STATUSES.has(step.status)) return 'blocking'
  if (RETRYABLE_STEP_STATUSES.has(step.status)) {
    // `prepared` is retryable for dispatch, but it was never sent, so a read
    // adds nothing: there is no uncertain outcome to describe.
    return step.status === 'prepared' ? undefined : 'retryable'
  }
  if (SATISFIED_STEP_STATUSES.has(step.status)) return 'satisfied'
  return undefined
}

function unreadableCodeFor(step: WriteStep): WriteErrorCode {
  return step.kind === 'unschedule'
    ? WRITE_ERROR_CODES.SCHEDULE_LOOKUP_UNSUPPORTED
    : WRITE_ERROR_CODES.CALENDAR_QUERY_UNSUPPORTED
}

/** Returns a target, `undefined` for "nothing to read", or a detail string. */
function targetOf(
  step: WriteStep,
  document: OperationDocument,
): { range: { startDate: string; endDate: string }; target: CalendarTarget } | string | undefined {
  if (step.kind === 'create') return UNREADABLE_DETAILS.create
  if (step.kind === 'unschedule') {
    const scheduleId = normalizeId(step.workoutScheduleId)
    if (!scheduleId) return UNREADABLE_DETAILS.unschedule
    const day = dayOfScheduleId(document, scheduleId)
    if (!day) return UNREADABLE_DETAILS.unschedule
    return { range: { startDate: day, endDate: day }, target: { workoutScheduleId: scheduleId } }
  }
  const workoutId = normalizeId(step.workoutId)
  const date = normalizeId(step.date)
  if (!workoutId || !date) return undefined
  return { range: { startDate: date, endDate: date }, target: { workoutId } }
}

/**
 * The calendar day a schedule id was scheduled on, taken from any journal step
 * that recorded both. This is evidence, not a guess: a step only ever records a
 * `workoutScheduleId` from a provider receipt, and a `date` from the request
 * that created that receipt.
 */
function dayOfScheduleId(document: OperationDocument, scheduleId: string): string | undefined {
  for (const operation of Object.values(document.operations)) {
    for (const step of operation.steps) {
      if (step.workoutScheduleId !== scheduleId) continue
      const date = normalizeId(step.date)
      if (date) return date
    }
  }
  return undefined
}

function buildWindows(
  targets: ReconcileReadTarget[],
  unreadable: UnreadableStep[],
  maxReads: number,
): ReconcilePlan {
  const tierOrder: ReconcileTier[] = ['blocking', 'retryable', 'satisfied']
  const ordered = [...targets].sort(
    (left, right) => tierOrder.indexOf(left.tier) - tierOrder.indexOf(right.tier),
  )

  const windows: ReconcileWindow[] = []
  const deferred: ReconcileReadTarget[] = []

  for (const target of ordered) {
    const existing = windows.find(window => covers(window, target))
    if (existing) {
      existing.targets.push(target)
      continue
    }
    const extendable = windows.find(window => canExtend(window, target))
    if (extendable) {
      extendable.range.startDate = minDate(extendable.range.startDate, target.range.startDate)
      extendable.range.endDate = maxDate(extendable.range.endDate, target.range.endDate)
      extendable.targets.push(target)
      continue
    }
    if (windows.length >= maxReads) {
      deferred.push(target)
      continue
    }
    windows.push({
      range: { startDate: target.range.startDate, endDate: target.range.endDate, timezone: RECONCILE_TIMEZONE },
      targets: [target],
    })
  }

  return { windows, unreadable, deferred }
}

function covers(window: ReconcileWindow, target: ReconcileReadTarget): boolean {
  return target.range.startDate >= window.range.startDate && target.range.endDate <= window.range.endDate
}

/** Extending is only allowed while the window still fits the provider maximum. */
function canExtend(window: ReconcileWindow, target: ReconcileReadTarget): boolean {
  const start = minDate(window.range.startDate, target.range.startDate)
  const end = maxDate(window.range.endDate, target.range.endDate)
  return calendarDayCount(start, end) <= MAX_CALENDAR_RANGE_DAYS
}

function minDate(left: string, right: string): string {
  return left < right ? left : right
}

function maxDate(left: string, right: string): string {
  return left > right ? left : right
}

function normalizeId(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined
  const trimmed = String(value).trim()
  return trimmed.length > 0 ? trimmed : undefined
}

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

export type ReconcileObservationKind =
  | 'observed_present'
  | 'duplicate_existing'
  | 'observed_absent'
  | 'undetermined'
  | 'not_read'

export interface ClassifiedObservation {
  kind: ReconcileObservationKind
  matches: CalendarEntry[]
  complete: boolean
  detail: string
}

/**
 * Turn one snapshot into a verdict for one target.
 *
 * `duplicate_existing` is its own kind rather than a flavour of
 * `observed_present`: more than one entry means the desired state holds *and*
 * the calendar can no longer be addressed unambiguously, which the caller must
 * see even though no write is needed.
 */
export function classifySnapshot(
  snapshot: CalendarSnapshot,
  target: CalendarTarget,
): ClassifiedObservation {
  const observation = observeCalendarTarget(snapshot, target)
  if (observation.kind === 'observed_present') {
    const matches = observation.matches
    return {
      kind: matches.length > 1 ? 'duplicate_existing' : 'observed_present',
      matches,
      complete: observation.complete,
      detail: matches.length > 1
        ? `${matches.length} matching calendar entries already exist; none of them were removed.`
        : 'The target is on the calendar now.',
    }
  }
  if (observation.kind === 'not_observed_in_complete_range') {
    return {
      kind: 'observed_absent',
      matches: [],
      complete: true,
      detail:
        'The complete range read did not show this target. That is a statement about '
        + 'this read only: it does not show that any write attempt failed to apply.',
    }
  }
  return {
    kind: 'undetermined',
    matches: [],
    complete: false,
    detail: observation.reasons.join('; '),
  }
}

/**
 * Record an observation on a step without ever changing its `status`.
 *
 * Only two fields move: `evidence`/`observedAt`, and `desiredStateSatisfied`.
 * `errorCode` is left alone, so a step that was refused for a specific reason
 * still reports that reason next time.
 */
export function applyObservation(
  step: WriteStep,
  observation: ClassifiedObservation,
  observedAt: string,
): void {
  const nextEvidence: WriteEvidence | undefined =
    observation.kind === 'observed_present' || observation.kind === 'duplicate_existing'
      ? 'observed_present'
      : observation.kind === 'observed_absent'
        ? 'observed_absent'
        : undefined
  if (nextEvidence) step.evidence = nextEvidence
  step.observedAt = observedAt
  if (observation.kind === 'observed_present' || observation.kind === 'duplicate_existing') {
    step.desiredStateSatisfied = true
  }
}

// ---------------------------------------------------------------------------
// Resume planning
// ---------------------------------------------------------------------------

export type ResumeCandidateReason =
  | 'never_dispatched'
  | 'proven_not_applied'
  | 'create_succeeded_schedule_pending'

export interface ResumeCandidate {
  step: WriteStep
  reason: ResumeCandidateReason
}

export interface ResumeRefusal {
  step: WriteStep
  code: WriteErrorCode
  detail: string
}

export interface ResumePlan {
  candidates: ResumeCandidate[]
  refusals: ResumeRefusal[]
  satisfied: WriteStep[]
}

const UNKNOWN_REFUSAL =
  'This attempt has an unknown outcome. It is never re-armed: reconcile it and '
  + 'wait for a reliable receipt before reusing this business key.'

/**
 * The steps a `resume` may arm, and the steps it must refuse.
 *
 * A candidate has to be *proven* not to have applied: `not_attempted` (the
 * request was never built) or `failed` (the failure was classified
 * `not_applied`). `prepared` is included because this journal persists
 * `in_flight` before the single dispatch, so a step still `prepared` provably
 * never reached the network.
 *
 * `unknown` and `in_flight` are refusals, unconditionally. So is a step whose
 * business key is claimed by another record — the caller checks that, because
 * it needs the whole document to do so.
 */
export function planResumeCandidates(operation: WriteOperation): ResumePlan {
  const candidates: ResumeCandidate[] = []
  const refusals: ResumeRefusal[] = []
  const satisfied: WriteStep[] = []
  const createSucceeded = operation.steps.some(
    step => step.kind === 'create' && SATISFIED_STEP_STATUSES.has(step.status),
  )
  const createUnknown = operation.steps.some(
    step => step.kind === 'create' && BLOCKING_STEP_STATUSES.has(step.status),
  )

  for (const step of operation.steps) {
    if (BLOCKING_STEP_STATUSES.has(step.status)) {
      refusals.push({
        step,
        code: (step.errorCode as WriteErrorCode | undefined) ?? WRITE_ERROR_CODES.WRITE_OUTCOME_UNKNOWN,
        detail: UNKNOWN_REFUSAL,
      })
      continue
    }
    if (SATISFIED_STEP_STATUSES.has(step.status)) {
      satisfied.push(step)
      continue
    }
    if (step.status === 'not_attempted' || step.status === 'prepared') {
      if (createUnknown && step.kind !== 'create') {
        // The schedule phase addresses a template id the create phase never
        // resolved. Re-arming it would schedule "some id" nobody recorded.
        refusals.push({
          step,
          code: WRITE_ERROR_CODES.WRITE_OUTCOME_UNKNOWN,
          detail:
            'The create phase of this operation has an unknown outcome, so the workout id '
            + 'this step would schedule is not known. Reconcile the create step first.',
        })
        continue
      }
      candidates.push({
        step,
        reason: createSucceeded && step.kind === 'schedule'
          ? 'create_succeeded_schedule_pending'
          : 'never_dispatched',
      })
      continue
    }
    if (step.status === 'failed') {
      candidates.push({ step, reason: 'proven_not_applied' })
      continue
    }
    refusals.push({
      step,
      code: WRITE_ERROR_CODES.SCHEDULE_LOOKUP_UNSUPPORTED,
      detail: `Step status ${step.status} needs manual review before it can be resumed.`,
    })
  }

  return { candidates, refusals, satisfied }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface ReconcileStepReport {
  stepId: string
  businessKey: string
  kind: WriteStep['kind']
  status: StepStatus
  workoutId?: string
  date?: string
  workoutScheduleId?: string | null
  observation: ReconcileObservationKind
  matchCount: number
  matchedScheduleIds: Array<string | null>
  evidence: WriteEvidence
  observedAt?: string
  desiredStateSatisfied: boolean
  /** The original attempt outcome is still unresolved after this read. */
  unresolved: boolean
  /** Proven not to have applied (or never dispatched): `resume` may arm it. */
  resumable: boolean
  complete: boolean
  detail: string
}

export interface ReconcileReport {
  operationId: string
  kind: WriteOperation['kind']
  readsIssued: number
  /** Set when a read was refused because the budget ran out. */
  readLimit: 'read_limit' | 'time_budget' | null
  budgetMs: number
  maxReads: number
  observations: ReconcileStepReport[]
  unreadable: Array<{ stepId: string; kind: WriteStep['kind']; code: WriteErrorCode; detail: string }>
  deferred: Array<{ stepId: string; detail: string }>
  candidates: Array<{
    stepId: string
    kind: WriteStep['kind']
    date?: string
    workoutId?: string
    reason: ResumeCandidateReason
  }>
  /** Reads that failed at the provider; their steps stay undetermined. */
  failures?: ReconcileReadFailure[]
  /** Steps a resume would refuse to arm, with the reason. */
  refusals: Array<{ stepId: string; code: WriteErrorCode; detail: string }>
  manualReviewRequired: boolean
  nextAction: ReconcileNextAction
  nextActionDetail: string
}

export type ReconcileNextAction =
  | 'resume_garmin_write_operation'
  | 'reconcile_garmin_write_operation'
  | 'manual_review'
  | 'none'

export function buildStepReport(
  step: WriteStep,
  observation: ClassifiedObservation,
  resumable: boolean,
): ReconcileStepReport {
  const unresolved = BLOCKING_STEP_STATUSES.has(step.status)
  return {
    stepId: step.stepId,
    businessKey: step.businessKey,
    kind: step.kind,
    status: step.status,
    ...(step.workoutId ? { workoutId: step.workoutId } : {}),
    ...(step.date ? { date: step.date } : {}),
    workoutScheduleId: step.workoutScheduleId ?? null,
    observation: observation.kind,
    matchCount: observation.matches.length,
    matchedScheduleIds: observation.matches.map(entry => entry.workoutScheduleId),
    evidence: step.evidence,
    ...(step.observedAt ? { observedAt: step.observedAt } : {}),
    desiredStateSatisfied: step.desiredStateSatisfied === true,
    unresolved,
    resumable,
    complete: observation.complete,
    detail: observation.detail,
  }
}

/** The `nextAction` the caller should follow, derived from a finished plan. */
export function nextActionFor(input: {
  unresolved: number
  candidates: number
  manualReviewRequired: boolean
  /**
   * True when no read could be taken for a blocking step because the calendar
   * itself is unreadable here. Re-reading is then not the next move: the same
   * refusal would come back, so the caller is told to review it.
   */
  readsUnavailable?: boolean
}): { action: ReconcileNextAction; detail: string } {
  if (input.unresolved > 0) {
    if (input.readsUnavailable) {
      return {
        action: 'manual_review',
        detail:
          `${input.unresolved} step(s) have an unknown outcome and this account cannot read ` +
          'the Garmin Calendar, so no observation is available. Resolve the read capability '
          + 'first; never re-send the write.',
      }
    }
    return {
      action: 'reconcile_garmin_write_operation',
      // A read has already been taken by the time this is produced, so the
      // instruction is "read again later", never "retry the write".
      detail:
        `${input.unresolved} step(s) still have an unknown outcome. Re-read later; `
        + 'never re-send the write.',
    }
  }
  if (input.manualReviewRequired) {
    return {
      action: 'manual_review',
      detail: 'The local journal cannot describe these steps well enough to act on them automatically.',
    }
  }
  if (input.candidates > 0) {
    return {
      action: 'resume_garmin_write_operation',
      detail: `${input.candidates} safe remaining step(s) can be previewed and confirmed.`,
    }
  }
  return { action: 'none', detail: 'Nothing to reconcile and nothing to resume.' }
}

// ---------------------------------------------------------------------------
// Reading: the one place this module touches the outside world
// ---------------------------------------------------------------------------

/**
 * The only external capability reconcile and preflight need.
 *
 * Structurally identical to `CalendarReader`; declared here so this module
 * imports no transport and so the coordinator can be handed a reader without
 * being handed a writer. Nothing in this file can schedule, create or
 * unschedule: the interface has no such method.
 */
export interface CalendarLookup {
  getCalendarRange(range: CalendarRange): Promise<CalendarSnapshot>
}

export interface ReconcileReadFailure {
  stepId: string
  code: WriteErrorCode
  detail: string
}

export interface ReconcileReadOutcome {
  /** One verdict per step that was planned for reading. */
  byStepId: Map<string, ClassifiedObservation>
  readsIssued: number
  /** Set when a read was refused before it was sent, because the budget ran out. */
  readLimit: 'read_limit' | 'time_budget' | null
  /** Reads that failed at the provider. Their steps are `undetermined`. */
  failures: ReconcileReadFailure[]
  /** True when no read could be taken at all (no reader, or all reads refused). */
  readsUnavailable: boolean
  observedAt: string
}

const NO_READER_DETAIL =
  'No Garmin Calendar reader is configured for this account, so no observation ' +
  'was taken. Nothing is assumed about the calendar: an unread calendar is not ' +
  'an empty one.'

/**
 * Execute a read plan. Never writes, never retries a write, never extends the
 * budget it was given.
 *
 * A window that fails leaves every target in it `undetermined`; a window that
 * is never reached because the budget ran out leaves its targets with no
 * verdict at all, which the caller reports as `deferred`.
 */
export async function runReconcileReads(input: {
  plan: ReconcilePlan
  reader: CalendarLookup | undefined
  now: () => Date
  budget?: ReadBudget
  maxReads?: number
}): Promise<ReconcileReadOutcome> {
  const budget = input.budget
    ?? createReadBudget({ startedAtMs: input.now().getTime(), maxReads: input.maxReads ?? RECONCILE_MAX_READS })
  const byStepId = new Map<string, ClassifiedObservation>()
  const failures: ReconcileReadFailure[] = []
  let readsIssued = 0
  let readLimit: 'read_limit' | 'time_budget' | null = null
  const observedAt = input.now().toISOString()

  if (!input.reader) {
    return {
      byStepId,
      readsIssued: 0,
      readLimit: null,
      failures: input.plan.windows.flatMap(window => window.targets.map(target => ({
        stepId: target.step.stepId,
        code: WRITE_ERROR_CODES.CALENDAR_QUERY_UNSUPPORTED,
        detail: NO_READER_DETAIL,
      }))),
      readsUnavailable: input.plan.windows.length > 0,
      observedAt,
    }
  }

  let blocked = false
  for (const window of input.plan.windows) {
    if (blocked) break
    const verdict = mayIssueRead(budget, input.now().getTime())
    if (!verdict.ok) {
      readLimit = verdict.reason
      blocked = true
      break
    }
    let snapshot: CalendarSnapshot | undefined
    let failureCode: WriteErrorCode | undefined
    let failureDetail = ''
    try {
      snapshot = await input.reader.getCalendarRange(window.range)
    } catch (error) {
      failureCode = isGarminWriteError(error)
        ? error.code
        : WRITE_ERROR_CODES.CALENDAR_INCOMPLETE
      failureDetail = error instanceof Error ? error.message : String(error)
    }
    chargeRead(budget, snapshot)
    readsIssued += Math.max(1, Math.trunc(snapshot?.requestsIssued ?? 1))
    for (const target of window.targets) {
      if (snapshot) {
        byStepId.set(target.step.stepId, classifySnapshot(snapshot, target.target))
        continue
      }
      byStepId.set(target.step.stepId, {
        kind: 'undetermined',
        matches: [],
        complete: false,
        detail: failureDetail || 'The range read did not complete.',
      })
      failures.push({
        stepId: target.step.stepId,
        code: failureCode ?? WRITE_ERROR_CODES.CALENDAR_INCOMPLETE,
        detail: failureDetail || 'The range read did not complete.',
      })
    }
  }

  const readsUnavailable = input.plan.windows.length > 0 && readsIssued === 0
  return { byStepId, readsIssued, readLimit, failures, readsUnavailable, observedAt }
}

// ---------------------------------------------------------------------------
// Preflight: the fresh read a new dispatch depends on
// ---------------------------------------------------------------------------

export type PreflightOutcome =
  /** A complete read of the target day did not show the target. */
  | { kind: 'clear'; readAt: string }
  /** Exactly one identical entry is already there; no POST is needed. */
  | { kind: 'skip_existing'; observation: ClassifiedObservation; readAt: string }
  /**
   * More than one identical entry exists, or the caller asked for `error` and
   * found one. Either way nothing is deleted and nothing is written.
   */
  | { kind: 'duplicate_existing'; observation: ClassifiedObservation; readAt: string }
  /** The read could not be taken or was incomplete. No POST may be issued. */
  | { kind: 'blocked'; code: WriteErrorCode; detail: string; readAt: string }

export const PREFLIGHT_DUPLICATE_DETAIL =
  'More than one matching calendar entry already exists, so the target cannot be ' +
  'addressed unambiguously. None of them was removed and no write was issued.'

/**
 * The fresh, uncached read that stands in front of one new dispatch.
 *
 * The contract is asymmetric on purpose:
 *
 *   - a *positive* match is usable even from an incomplete read — seeing the
 *     target proves it is there, and the answer is "do not write";
 *   - a *negative* is only usable from a complete read — "not seen" must never
 *     be spent as "not there", and an incomplete read therefore blocks the
 *     write instead of authorising it.
 */
export async function preflightTarget(input: {
  reader: CalendarLookup | undefined
  workoutId?: string | null
  workoutScheduleId?: string | null
  date: string
  timezone: string
  now: () => Date
  duplicatePolicy?: DuplicatePolicy
}): Promise<PreflightOutcome> {
  const readAt = input.now().toISOString()
  if (!input.reader) {
    return {
      kind: 'blocked',
      code: WRITE_ERROR_CODES.CALENDAR_QUERY_UNSUPPORTED,
      detail: NO_READER_DETAIL,
      readAt,
    }
  }

  const target: CalendarTarget = input.workoutScheduleId
    ? { workoutScheduleId: input.workoutScheduleId }
    : { workoutId: input.workoutId }

  let snapshot: CalendarSnapshot
  try {
    snapshot = await input.reader.getCalendarRange({
      startDate: input.date,
      endDate: input.date,
      timezone: input.timezone,
    })
  } catch (error) {
    // A refused read is a refusal, not an empty calendar. The provider gate and
    // the adapter both refuse before building a request for a region without a
    // verified read, and that refusal must block the write.
    const code = error instanceof GarminWriteError
      ? error.code
      : WRITE_ERROR_CODES.CALENDAR_INCOMPLETE
    return {
      kind: 'blocked',
      code,
      detail: error instanceof Error ? error.message : String(error),
      readAt,
    }
  }

  const observation = classifySnapshot(snapshot, target)
  if (observation.kind === 'observed_absent') return { kind: 'clear', readAt }
  if (observation.kind === 'undetermined') {
    return {
      kind: 'blocked',
      code: WRITE_ERROR_CODES.CALENDAR_INCOMPLETE,
      detail: observation.detail,
      readAt,
    }
  }
  if (observation.kind === 'duplicate_existing') {
    return { kind: 'duplicate_existing', observation, readAt }
  }
  if (input.duplicatePolicy === 'error') {
    // The caller asked to be told about an existing entry rather than have it
    // silently skipped. Nothing is deleted either way.
    return { kind: 'duplicate_existing', observation, readAt }
  }
  return { kind: 'skip_existing', observation, readAt }
}

/**
 * Was this step skipped because the *calendar* currently shows the target,
 * rather than because the journal already holds a satisfying receipt?
 *
 * The discriminator is the `reference` field, and it is an enforced invariant
 * rather than a convention: every journal-derived skip pins a read-only
 * `reference` to the step that satisfies the business key, so a `skipped` step
 * with no `reference` can only have been skipped from a fresh observation. That
 * distinction matters because a journal-based skip is permanent while a
 * calendar-based one is a fact about *now* — and a fact about now must be
 * rechecked before it is allowed to justify not writing.
 */
export function isCalendarObservedSkip(step: WriteStep): boolean {
  return step.status === 'skipped' && step.reference === undefined
}

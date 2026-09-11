/**
 * Read-only Garmin Calendar query contract.
 *
 * Two facts are deliberately kept apart, because conflating them is how a
 * recovery flow turns into a duplicate write:
 *
 *  1. "A complete read of a date range did not observe the target" — this is a
 *     *query conclusion* about what the provider returned for that range.
 *     `CalendarObservation` models it. Every variant carries the literal
 *     `provesWriteDidNotHappen: false` so no caller can read more out of it.
 *  2. "An unknown write definitely never happened" — this is a statement about
 *     a specific local attempt, and it requires explicit attempt evidence.
 *     `WriteNotAppliedProof` models it. There is intentionally **no** function
 *     in this module that derives it from a `CalendarSnapshot`: an empty range
 *     result cannot prove that a timed-out POST was never applied, and a
 *     non-empty result cannot prove which attempt created an entry.
 *
 * A provider read may also be incomplete (`complete: false`). An incomplete
 * read supports only the weaker conclusion "not observed", and never a
 * negative one.
 */

import { PublicToolError } from '../utils/errors'

/** Inclusive calendar-date range. Dates are real proleptic Gregorian days. */
export interface CalendarRange {
  /** `YYYY-MM-DD`, inclusive. */
  startDate: string
  /** `YYYY-MM-DD`, inclusive. */
  endDate: string
  /**
   * Caller-supplied label. The verified request carries no timezone parameter
   * (see docs/calendar-api-verification.md), so this is echoed for the caller
   * and never used to shift a date.
   */
  timezone: string
}

/** Sub-range of the requested range that could not be read completely. */
export interface CalendarMissingRange {
  startDate: string
  endDate: string
}

/**
 * `workout` means the provider item is identified by a workout-library id.
 * `other` covers everything else that still belongs to the calendar day
 * (training-plan / rest / race items). Anything we cannot identify at all is
 * never silently dropped: it is reported as an incomplete read instead.
 */
export type CalendarEntryKind = 'workout' | 'other'

export interface CalendarEntry {
  /** `YYYY-MM-DD` as reported by the provider (calendar day, not an instant). */
  date: string
  kind: CalendarEntryKind
  /** Workout-library template id. Never inferred from any other field. */
  workoutId: string | null
  /**
   * Calendar-entry (schedule instance) id — the value an unschedule targets.
   *
   * Populated only from an id the provider actually named: the range read's
   * `scheduledWorkoutId` field, or the schedule POST's `workoutScheduleId`
   * field (see docs/calendar-api-verification.md). It is never derived from
   * `workoutId`, from a generic `id`, or from a workout UUID — those are
   * different identities and mixing them would make an unschedule target
   * ambiguous. An item whose two id fields disagree leaves this `null` and is
   * reported through `ITEM_ID_CONFLICT`, because picking one would risk
   * deleting a different calendar entry.
   */
  workoutScheduleId: string | null
  title: string | null
  /** Template UUID, kept separate from both ids above. */
  workoutUuid: string | null
  /** Training-plan name when the provider item belongs to a plan. */
  planName: string | null
  restDay: boolean
  race: boolean
  /** Provider sport key (e.g. `running`) when present. */
  sport: string | null
}

export interface CalendarSnapshot {
  /** The range the caller asked for (inclusive). */
  range: CalendarRange
  /**
   * The range actually sent to the provider. It is padded by one day on each
   * side of every slice because boundary inclusivity of the provider query is
   * unverified; entries outside `range` are ignored, so the pad can only ever
   * add evidence, never claim it.
   */
  probedRange: CalendarRange
  /** Entries whose `date` falls inside `range`, in provider order. */
  entries: CalendarEntry[]
  /** ISO instant of the read. */
  fetchedAt: string
  /**
   * `true` only when every part of `range` was read and every item the provider
   * returned was understood well enough to be classified or retained. `false`
   * means the result may be missing entries; it never means "the target is
   * absent".
   *
   * An item that cannot be understood clears this even when its date falls in
   * the padded area outside `range`. That is deliberate: the adapter is
   * fail-closed, and an unreadable provider item is a reason to trust the rest
   * of the slice less, not more.
   *
   * A complete read that found nothing is `complete: true`. That is a statement
   * about this read and this range only — it is not, and cannot be, evidence
   * about whether a specific write attempt reached Garmin.
   */
  complete: boolean
  /**
   * Slices of `range` that were not read in full. Only coverage problems are
   * listed here; an individual item that could not be classified also sets
   * `complete:false` but is reported through `warnings` instead, because it is
   * not a range-coverage fact.
   */
  missingRanges: CalendarMissingRange[]
  /** Human-readable notes, each prefixed with a stable `[CODE]` token. */
  warnings: string[]
  /** Number of provider requests issued for this snapshot (loop bound proof). */
  requestsIssued: number
}

export interface CalendarReader {
  getCalendarRange(range: CalendarRange): Promise<CalendarSnapshot>
}

/** Stable warning tokens. Match on these instead of on prose. */
export const CALENDAR_WARNING_CODES = {
  BOUNDARY_PADDING_APPLIED: 'BOUNDARY_PADDING_APPLIED',
  TIMEZONE_NOT_IN_VERIFIED_PROTOCOL: 'TIMEZONE_NOT_IN_VERIFIED_PROTOCOL',
  CHUNK_LIMIT_EXCEEDED: 'CHUNK_LIMIT_EXCEEDED',
  CHUNK_READ_FAILED: 'CHUNK_READ_FAILED',
  PAGE_LIMIT_EXCEEDED: 'PAGE_LIMIT_EXCEEDED',
  CURSOR_LOOP_DETECTED: 'CURSOR_LOOP_DETECTED',
  RESPONSE_UNREADABLE: 'RESPONSE_UNREADABLE',
  RESPONSE_TRUNCATED: 'RESPONSE_TRUNCATED',
  NULL_RESULT_TREATED_AS_EMPTY: 'NULL_RESULT_TREATED_AS_EMPTY',
  ITEMS_LIMIT_EXCEEDED: 'ITEMS_LIMIT_EXCEEDED',
  UNREADABLE_ITEM: 'UNREADABLE_ITEM',
  ITEM_DATE_INVALID: 'ITEM_DATE_INVALID',
  ITEM_ID_INVALID: 'ITEM_ID_INVALID',
  /** The item carries two different calendar-entry ids; neither is used. */
  ITEM_ID_CONFLICT: 'ITEM_ID_CONFLICT',
  UNKNOWN_ITEM_KIND: 'UNKNOWN_ITEM_KIND',
  UNMAPPED_ITEM_IDENTIFIER: 'UNMAPPED_ITEM_IDENTIFIER',
} as const

export type CalendarWarningCode =
  typeof CALENDAR_WARNING_CODES[keyof typeof CALENDAR_WARNING_CODES]

export function calendarWarning(code: CalendarWarningCode, detail: string): string {
  return `[${code}] ${detail}`
}

export function hasCalendarWarning(
  snapshot: Pick<CalendarSnapshot, 'warnings'>,
  code: CalendarWarningCode,
): boolean {
  const prefix = `[${code}]`
  return snapshot.warnings.some((warning) => warning.startsWith(prefix))
}

/** Rejections of the requested range itself; raised before any network read. */
export class CalendarRangeError extends PublicToolError {
  override name = 'CalendarRangeError'
  readonly code: 'CALENDAR_RANGE_INVALID' | 'CALENDAR_RANGE_TOO_LONG'

  constructor(
    code: 'CALENDAR_RANGE_INVALID' | 'CALENDAR_RANGE_TOO_LONG',
    message: string,
  ) {
    super(message)
    this.code = code
  }
}

/** Rejections of a target selector, i.e. an ambiguous or empty identity. */
export class CalendarTargetError extends PublicToolError {
  override name = 'CalendarTargetError'
  readonly code = 'CALENDAR_TARGET_INVALID' as const

  constructor(message: string) {
    super(message)
  }
}

/**
 * What the caller wants to look for. Exactly one identifier must be supplied:
 * a library workout id (a template) or a calendar schedule id (one instance).
 */
export interface CalendarTarget {
  workoutId?: string | null
  workoutScheduleId?: string | null
}

/**
 * Result of asking a snapshot about a target. Read this as a *query*
 * conclusion. `provesWriteDidNotHappen` is a literal `false` on every variant:
 * the absence of an observed entry is not evidence about any write attempt.
 */
export type CalendarObservation =
  | {
      kind: 'observed_present'
      target: CalendarTarget
      /** One or more matching entries. More than one means duplicates exist. */
      matches: CalendarEntry[]
      /** Present even when the rest of the read was incomplete. */
      complete: boolean
      provesWriteDidNotHappen: false
      note: string
    }
  | {
      kind: 'not_observed_in_complete_range'
      target: CalendarTarget
      range: CalendarRange
      provesWriteDidNotHappen: false
      note: string
    }
  | {
      kind: 'undetermined'
      target: CalendarTarget
      reasons: string[]
      provesWriteDidNotHappen: false
      note: string
    }

const OBSERVATION_NOTE =
  'A range read is a query conclusion only. It never shows whether a specific ' +
  'write attempt reached Garmin; an unknown attempt stays unknown until a ' +
  'reliable receipt exists.'

/**
 * Classify what a snapshot says about one target.
 *
 * - A clear match proves the target exists *now*, even if other parts of the
 *   read failed.
 * - A complete read with no match proves only that this range did not show the
 *   target.
 * - An incomplete read without a match proves nothing.
 * - A `workoutScheduleId` lookup is weaker still: this adapter has no
 *   verified by-id read, so "not seen in this range" cannot be turned into
 *   "this schedule instance does not exist" (it may have been moved outside
 *   the range).
 */
export function observeCalendarTarget(
  snapshot: CalendarSnapshot,
  target: CalendarTarget,
): CalendarObservation {
  const workoutId = normalizeTargetId(target.workoutId)
  const scheduleId = normalizeTargetId(target.workoutScheduleId)
  if ((workoutId === null) === (scheduleId === null)) {
    throw new CalendarTargetError(
      'Provide exactly one of workoutId or workoutScheduleId',
    )
  }

  const matches = scheduleId !== null
    ? snapshot.entries.filter((entry) => entry.workoutScheduleId === scheduleId)
    : snapshot.entries.filter((entry) => entry.workoutId === workoutId)

  if (matches.length > 0) {
    return {
      kind: 'observed_present',
      target: { workoutId, workoutScheduleId: scheduleId },
      matches,
      complete: snapshot.complete,
      provesWriteDidNotHappen: false,
      note:
        'The target is scheduled now. That does not show which attempt created ' +
        'it, so any earlier unknown attempt keeps its unknown status.',
    }
  }

  if (scheduleId !== null) {
    return {
      kind: 'undetermined',
      target: { workoutId: null, workoutScheduleId: scheduleId },
      reasons: ['SCHEDULE_ID_LOOKUP_UNSUPPORTED'],
      provesWriteDidNotHappen: false,
      note:
        'This adapter has no verified schedule-id read, so a range read cannot ' +
        `show that entry ${scheduleId} does not exist outside the queried range.`,
    }
  }

  if (!snapshot.complete) {
    return {
      kind: 'undetermined',
      target: { workoutId, workoutScheduleId: null },
      reasons: ['INCOMPLETE_RANGE_READ'],
      provesWriteDidNotHappen: false,
      note: `The read was incomplete (${snapshot.missingRanges.length} missing ` +
        'range slice(s)), so no negative conclusion is available.',
    }
  }

  return {
    kind: 'not_observed_in_complete_range',
    target: { workoutId, workoutScheduleId: null },
    range: snapshot.range,
    provesWriteDidNotHappen: false,
    note: `${OBSERVATION_NOTE} This variant only says the complete read of ` +
      `${snapshot.range.startDate}..${snapshot.range.endDate} did not show ` +
      `workout ${workoutId}.`,
  }
}

function normalizeTargetId(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const trimmed = String(value).trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Where a `not_applied` proof comes from. A snapshot is never a source. */
export type WriteNotAppliedEvidenceSource =
  | 'local_pre_dispatch_validation'
  | 'provider_receipt'
  | 'provider_error_response'

export interface WriteAttemptEvidence {
  operationId: string
  stepId: string
  attempt: number
  source: WriteNotAppliedEvidenceSource
  detail: string
}

/**
 * A statement about one local attempt: it provably never reached Garmin.
 *
 * The constructor takes attempt evidence only. No function here accepts a
 * `CalendarSnapshot`, which is the point: the absence of an observed calendar
 * entry cannot be converted into "the unknown POST never happened".
 */
export interface WriteNotAppliedProof {
  kind: 'not_applied'
  provesWriteDidNotHappen: true
  operationId: string
  stepId: string
  attempt: number
  source: WriteNotAppliedEvidenceSource
  detail: string
}

export function writeNotAppliedProof(
  evidence: WriteAttemptEvidence,
): WriteNotAppliedProof {
  return {
    kind: 'not_applied',
    provesWriteDidNotHappen: true,
    operationId: evidence.operationId,
    stepId: evidence.stepId,
    attempt: evidence.attempt,
    source: evidence.source,
    detail: evidence.detail,
  }
}

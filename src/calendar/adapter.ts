/**
 * Evidence-backed Garmin Calendar range adapter.
 *
 * ## What is implemented, and why only this
 *
 * The only calendar *read* protocol this project has first-hand evidence for
 * is Garmin's GraphQL gateway query
 * `workoutScheduleSummariesScalar(startDate, endDate)` (URLs, commits and
 * fields: docs/calendar-api-verification.md). Six independent public
 * implementations agree on the request shape, on the response envelope
 * `{"data":{"workoutScheduleSummariesScalar":[...]}}` and on the item field set.
 * Two of those agreements are guarded here rather than assumed:
 *
 * - the field is a JSON *array*, not a JSON-encoded string, in every source we
 *   read; the string form is still accepted as defence in depth, but it is not
 *   an evidenced shape;
 * - a non-empty GraphQL `errors` array is a failure even when `data` carries
 *   items — two sources treat it as one, so an error response can never be read
 *   as "the calendar is empty".
 *
 * The item's calendar-entry id arrives as `scheduledWorkoutId` on this read,
 * while the schedule POST answers with `workoutScheduleId`. Both names are
 * accepted and mapped to one field; a response that carries both with different
 * values is unreadable rather than guessed.
 *
 * That query takes an inclusive-looking date range in `YYYY-MM-DD`, so this
 * adapter slices the requested range into calendar months, issues one query per
 * slice and never invents a pagination cursor it has no evidence for: no source
 * documents a pagination input at all. If a provider *does* return a cursor,
 * this adapter follows it through the transport while every loop stays bounded,
 * and the production transport (`GarminClient.calendarTransport`) refuses that
 * request outright because it has no verified parameter name to send it under —
 * so a paging provider ends as a slice reported incomplete, never as a slice
 * assembled from a guessed page.
 *
 * Three things are deliberately **not** implemented, and are reported as
 * unsupported capabilities instead of being faked:
 *
 * - the `calendar-service/year/{year}/month/{month-1}` month feed: the path is
 *   documented by two sources, but only for event/race items — no first-hand
 *   source documents the workout item shape of that feed, and this adapter has
 *   no REST transport;
 * - a by-schedule-id read (`GET /workout-service/schedule/{id}`): the path is
 *   documented by two sources, its response shape is documented by none;
 * - the `trainingPlanScalar` coach window, which returns a different item shape
 *   than the range query this adapter maps.
 *
 * Region is gated by evidence, not by string substitution: every first-hand
 * source above covers the global (`garmin.com`) hosts only. `garmin.cn` appears
 * there only as a configurable base domain, which is a code-level claim about
 * routing and not a verified response, so the `cn` region throws
 * `CALENDAR_QUERY_UNSUPPORTED` before any request is built.
 *
 * ## Date arithmetic
 *
 * All date maths is done on `YYYY-MM-DD` strings using UTC fields only, so a
 * local DST transition can never add or drop a day. `toISOString()` is never
 * used to derive a calendar date.
 */

import {
  GarminWriteError,
  WRITE_ERROR_CODES,
  notAppliedWriteError,
} from '../write-operations/errors'
import {
  CALENDAR_WARNING_CODES,
  CalendarRangeError,
  CalendarEntry,
  CalendarMissingRange,
  CalendarRange,
  CalendarSnapshot,
  CalendarReader,
  CalendarWarningCode,
  calendarWarning,
} from './types'

/** Public single-query limit from the implementation plan. */
export const MAX_CALENDAR_RANGE_DAYS = 366

/**
 * Every slice is probed with one extra day on each side. Boundary
 * inclusivity of the provider query is unverified, and guessing it in the
 * exclusive direction could hide an entry on the requested end date — the one
 * error direction that could later cause a duplicate write.
 */
export const CALENDAR_BOUNDARY_PAD_DAYS = 1

export const DEFAULT_MAX_CHUNKS = 14
export const DEFAULT_MAX_PAGES_PER_CHUNK = 12
export const DEFAULT_MAX_ITEMS = 20000

/** Regions with a first-hand verified calendar read. Everything else is blocked. */
export const CALENDAR_SUPPORTED_REGIONS = ['global'] as const

/**
 * Request envelope for the verified GraphQL query. `cursor` is *not* part of
 * the verified contract; the adapter only ever populates it when a response
 * actually returned a cursor, and whether it can be sent is the transport's
 * call — the production transport refuses it (no verified parameter name).
 */
export interface CalendarGraphqlRequest {
  query: string
  cursor?: string
}

export interface CalendarGraphqlTransport {
  /** POST the body to the region's GraphQL gateway and return the parsed JSON. */
  query(request: CalendarGraphqlRequest): Promise<unknown>
}

export interface CalendarCapability {
  region: string
  supported: boolean
  /** The one read this adapter implements. */
  rangeQuery: {
    status: 'verified' | 'unsupported'
    method: 'POST'
    path: 'graphql-gateway/graphql'
    evidence: string
  }
  /** Documented-but-not-implemented protocol surface. */
  monthSliceQuery: {
    status: 'unsupported'
    path: 'calendar-service/year/{year}/month/{month-1}'
    reason: string
  }
  scheduleIdLookup: {
    status: 'unsupported'
    reason: string
  }
  pagination: {
    status: 'unverified_defensive_cursor'
    reason: string
  }
  reason: string
}

const RANGE_QUERY_EVIDENCE =
  'Request shape: python-garminconnect@384c666412e535435cc7fcd587be770c9770f3f4 ' +
  'docs/graphql_queries.txt:42 ("query{{workoutScheduleSummariesScalar(' +
  'startDate:\'{startDate}\', endDate:\'{endDate}\')}}", both params YYYY-MM-DD) and ' +
  'garminconnect/__init__.py:3663-3688 (query_garmin_graphql POSTs to ' +
  'graphql-gateway/graphql on connectapi). Envelope/fields: ' +
  'Taxuspt/garmin_mcp@655efb8f src/garmin_mcp/workouts.py:544-592 and ' +
  'tests/integration/test_workouts_tools.py:1220-1245; ' +
  'tamcore/garmin-mcp@a9440718 internal/garmin/api/calendar.go:35-72 and ' +
  'calendar_test.go:19-25; ' +
  'serhiitroinin/serene@d822d696 apps/web/src/server/sources/garmin.ts:363-392; ' +
  'brunosantos/garmin-workouts-mcp@753b72581fdb5a80c105c8c52acaf568b1aa60d7 ' +
  'src/garmin_workouts_mcp/workouts.py:517-551'

const SCHEDULE_ID_LOOKUP_REASON =
  'No verified response shape for a by-schedule-id read: two sources name the ' +
  'path (python-garminconnect@384c666 garminconnect/__init__.py:3598-3608 ' +
  'GET /workout-service/schedule/{id}; serhiitroinin/serene@d822d696 ' +
  'product/research/garmin-training-plan-api.md:30 GET ' +
  '/workout-service/schedule/{scheduledId}), and this adapter has no REST ' +
  'transport, so no request is built. The verified sources only document the ' +
  'POST/DELETE writes on that path. A range read cannot prove an entry does not ' +
  'exist outside the queried range (see docs/calendar-api-verification.md).'

const MONTH_SLICE_REASON =
  'The month path is documented (python-garminconnect@384c666 ' +
  'garminconnect/__init__.py:3581-3608 GET ' +
  '/calendar-service/year/{year}/month/{month-1}, zero-based month; ' +
  'barnes-c/go-garminconnect@fde79fa garminconnect/workouts.go:60-64 the same ' +
  'path), and so is the shape of its event items (tamcore/garmin-mcp@a9440718 ' +
  'internal/garmin/api/calendarevents.go:66-95 reads calendarItems with ' +
  'itemType/title/date). No first-hand source documents the workout item shape ' +
  'of that feed, and this adapter has no REST transport, so it is not implemented.'

const PAGINATION_REASON =
  'No cursor/pagination parameter is documented for workoutScheduleSummariesScalar ' +
  'by any source we read; the field is never sent as an input. This adapter follows ' +
  'a returned cursor defensively through the transport and bounds every loop, but the ' +
  'production transport refuses a cursor request because there is no verified ' +
  'parameter name for it, so a paging provider yields an incomplete slice instead ' +
  'of a guessed next page.'

/** The calendar-entry id as the range read names it. Source: see RANGE_QUERY_EVIDENCE. */
const CALENDAR_ENTRY_ID_FIELD = 'scheduledWorkoutId'

/**
 * The calendar-entry id as the schedule POST response names it. Source:
 * drkostas/hevy2garmin@99a1d73 src/hevy2garmin/garmin.py:487-505 reads
 * `data.get("workoutScheduleId")` from POST /workout-service/schedule/{workoutId}
 * and feeds it back into DELETE on the same path. Kept as an accepted alias
 * because this project's schedule receipt uses that name.
 */
const CALENDAR_ENTRY_ID_ALIAS_FIELD = 'workoutScheduleId'

/** Report what is actually supported, so callers can branch instead of guessing. */
export function describeCalendarCapability(region: string): CalendarCapability {
  const supported = (CALENDAR_SUPPORTED_REGIONS as readonly string[]).includes(region)
  return {
    region,
    supported,
    rangeQuery: {
      status: supported ? 'verified' : 'unsupported',
      method: 'POST',
      path: 'graphql-gateway/graphql',
      evidence: RANGE_QUERY_EVIDENCE,
    },
    monthSliceQuery: {
      status: 'unsupported',
      path: 'calendar-service/year/{year}/month/{month-1}',
      reason: MONTH_SLICE_REASON,
    },
    scheduleIdLookup: {
      status: 'unsupported',
      reason: SCHEDULE_ID_LOOKUP_REASON,
    },
    pagination: {
      status: 'unverified_defensive_cursor',
      reason: PAGINATION_REASON,
    },
    reason: supported
      ? 'First-hand evidence covers the global garmin.com hosts only; no live account check was performed.'
      : `No first-hand calendar-read evidence exists for region '${region}': the ` +
        'public sources name garmin.cn only as a configurable base domain ' +
        '(python-garminconnect@384c666 garminconnect/__init__.py:617, ' +
        'matin/garth@f99159a docs/configuration.md:10-14), which is a routing ' +
        'claim and not a verified response, so the range query is blocked instead ' +
        'of assumed to work on a different hostname.',
  }
}

// ---------------------------------------------------------------------------
// Calendar date helpers (string in, string out; UTC fields only)
// ---------------------------------------------------------------------------

interface CalendarDateParts {
  year: number
  month: number
  day: number
}

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

function parseCalendardateParts(value: unknown): CalendarDateParts | null {
  if (typeof value !== 'string') return null
  const match = ISO_DATE_PATTERN.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12) return null
  if (day < 1 || day > 31) return null
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (
    probe.getUTCFullYear() !== year
    || probe.getUTCMonth() !== month - 1
    || probe.getUTCDate() !== day
  ) {
    return null
  }
  return { year, month, day }
}

function formatCalendarDate(parts: CalendarDateParts): string {
  const month = String(parts.month).padStart(2, '0')
  const day = String(parts.day).padStart(2, '0')
  return `${String(parts.year).padStart(4, '0')}-${month}-${day}`
}

/** Strict real-Gregorian `YYYY-MM-DD` check (rejects 2026-02-30, 2026-13-01). */
export function isValidCalendarDate(value: unknown): value is string {
  return parseCalendardateParts(value) !== null
}

/** Shift a calendar date by whole days without touching local time. */
export function addCalendarDays(date: string, delta: number): string {
  const parts = parseCalendardateParts(date)
  if (!parts) throw new CalendarRangeError('CALENDAR_RANGE_INVALID', `Invalid date: ${date}`)
  if (!Number.isInteger(delta)) {
    throw new CalendarRangeError('CALENDAR_RANGE_INVALID', `Invalid day offset: ${delta}`)
  }
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day))
  shifted.setUTCDate(shifted.getUTCDate() + delta)
  return formatCalendarDate({
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  })
}

/** Inclusive day count between two calendar dates. */
export function calendarDayCount(startDate: string, endDate: string): number {
  const start = parseCalendardateParts(startDate)
  const end = parseCalendardateParts(endDate)
  if (!start || !end) {
    throw new CalendarRangeError('CALENDAR_RANGE_INVALID', 'Range dates must be YYYY-MM-DD')
  }
  const startUtc = Date.UTC(start.year, start.month - 1, start.day)
  const endUtc = Date.UTC(end.year, end.month - 1, end.day)
  return Math.round((endUtc - startUtc) / 86400000) + 1
}

/**
 * Split an inclusive range into consecutive calendar-month slices, so a sparse
 * 366-day request is never turned into 366 daily reads nor into one unbounded
 * request.
 */
export function enumerateMonthChunks(
  startDate: string,
  endDate: string,
): Array<{ startDate: string; endDate: string }> {
  if (!isValidCalendarDate(startDate) || !isValidCalendarDate(endDate)) {
    throw new CalendarRangeError('CALENDAR_RANGE_INVALID', 'Range dates must be YYYY-MM-DD')
  }
  if (startDate > endDate) {
    throw new CalendarRangeError(
      'CALENDAR_RANGE_INVALID',
      `Range start ${startDate} is after end ${endDate}`,
    )
  }
  const chunks: Array<{ startDate: string; endDate: string }> = []
  let cursor = startDate
  while (cursor <= endDate) {
    const parts = parseCalendardateParts(cursor)!
    const monthEnd = formatCalendarDate({
      year: parts.year,
      month: parts.month,
      day: new Date(Date.UTC(parts.year, parts.month, 0)).getUTCDate(),
    })
    const chunkEnd = monthEnd < endDate ? monthEnd : endDate
    chunks.push({ startDate: cursor, endDate: chunkEnd })
    cursor = addCalendarDays(chunkEnd, 1)
  }
  return chunks
}

/** Pad a slice so an exclusive boundary rule cannot hide the requested days. */
export function padChunk(chunk: { startDate: string; endDate: string }): {
  startDate: string
  endDate: string
} {
  return {
    startDate: addCalendarDays(chunk.startDate, -CALENDAR_BOUNDARY_PAD_DAYS),
    endDate: addCalendarDays(chunk.endDate, CALENDAR_BOUNDARY_PAD_DAYS),
  }
}

/** The verified query body, byte-for-byte the shape the sources document. */
export function buildScheduleSummaryQuery(startDate: string, endDate: string): string {
  return `query{workoutScheduleSummariesScalar(startDate:"${startDate}", endDate:"${endDate}")}`
}

// ---------------------------------------------------------------------------
// Provider response parsing
// ---------------------------------------------------------------------------

export type ProviderIdParse =
  | { status: 'absent' }
  | { status: 'ok'; value: string; numeric: boolean }
  | { status: 'invalid'; detail: string }

const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/**
 * Ids stay strings end to end. A numeric id above `Number.MAX_SAFE_INTEGER` is
 * rejected rather than silently rounded: a calendar id that quietly changed
 * value would make an unschedule target wrong.
 */
export function parseProviderId(candidate: unknown): ProviderIdParse {
  if (candidate === undefined || candidate === null) return { status: 'absent' }
  if (typeof candidate === 'number') {
    if (!Number.isSafeInteger(candidate) || candidate > Number.MAX_SAFE_INTEGER) {
      return {
        status: 'invalid',
        detail: `numeric id ${candidate} exceeds exact integer precision; use the string form`,
      }
    }
    if (candidate <= 0) return { status: 'invalid', detail: `numeric id ${candidate} is not positive` }
    return { status: 'ok', value: String(candidate), numeric: true }
  }
  if (typeof candidate === 'string') {
    const trimmed = candidate.trim()
    if (!trimmed) return { status: 'invalid', detail: 'empty id string' }
    if (POSITIVE_INTEGER_PATTERN.test(trimmed)) {
      return { status: 'ok', value: trimmed, numeric: true }
    }
    if (UUID_PATTERN.test(trimmed)) return { status: 'ok', value: trimmed, numeric: false }
    return {
      status: 'invalid',
      detail: `unrecognized id string ${JSON.stringify(trimmed.slice(0, 40))}`,
    }
  }
  return { status: 'invalid', detail: `unrecognized id type ${typeof candidate}` }
}

export interface ExtractedCalendarPage {
  status: 'items' | 'empty' | 'unreadable'
  items: unknown[]
  nextCursor: string | null
  truncated: boolean
  detail: string | null
}

const EMPTY_PAGE: ExtractedCalendarPage = {
  status: 'empty',
  items: [],
  nextCursor: null,
  truncated: false,
  detail: null,
}

function unreadablePage(detail: string): ExtractedCalendarPage {
  return { status: 'unreadable', items: [], nextCursor: null, truncated: false, detail }
}

/** One GraphQL error rendered for a local warning: collapsed, bounded, nameless. */
function describeGraphqlError(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message
  if (typeof message !== 'string' || !message.trim()) return 'unnamed GraphQL error'
  const collapsed = message.replace(/\s+/g, ' ').trim()
  return collapsed.length > 80 ? `${collapsed.slice(0, 80)}…` : collapsed
}

/**
 * Accept the documented GraphQL envelope, a bare array, and a JSON string
 * (`...Scalar` fields arrive as a JSON-encoded string in the sources we read).
 * Anything else is reported as unreadable instead of being treated as empty.
 */
export function extractCalendarPage(response: unknown): ExtractedCalendarPage {
  if (typeof response === 'string') {
    const trimmed = response.trim()
    if (!trimmed) return EMPTY_PAGE
    try {
      return extractCalendarPage(JSON.parse(trimmed))
    } catch {
      return unreadablePage('response string is not valid JSON')
    }
  }
  if (Array.isArray(response)) {
    return { ...EMPTY_PAGE, status: response.length > 0 ? 'items' : 'empty', items: response }
  }
  if (typeof response !== 'object' || response === null) {
    return unreadablePage(`unexpected response type ${response === null ? 'null' : typeof response}`)
  }
  const record = response as Record<string, unknown>
  // A GraphQL gateway can answer with part of the data *and* an `errors` array.
  // Two sources treat that as a failure — tamcore/garmin-mcp@a9440718
  // internal/garmin/api/calendar_test.go:200-217 expects a failure for
  // `{"data":{"workoutScheduleSummariesScalar":[]},"errors":[...]}`, and
  // serhiitroinin/serene@d822d696 apps/web/src/server/sources/garmin.ts:387-389
  // throws on a non-empty `errors`. Reading it as "an empty slice" would turn a
  // refused query into a complete empty calendar, so it is unreadable here.
  const reportedErrors = record.errors
  if (Array.isArray(reportedErrors) && reportedErrors.length > 0) {
    return unreadablePage(
      `response carries ${reportedErrors.length} GraphQL error(s): ` +
      `${reportedErrors.slice(0, 3).map(describeGraphqlError).join('; ')}`,
    )
  }
  if ('data' in record) {
    return extractCalendarPage(record.data)
  }
  if ('workoutScheduleSummariesScalar' in record) {
    const scalar = record.workoutScheduleSummariesScalar
    // A present-but-null field is treated as "no items for this slice" with a
    // warning. Treating it as unreadable would make an empty calendar day
    // permanently unverifiable, which the plan explicitly rejects.
    if (scalar === null) {
      return {
        ...EMPTY_PAGE,
        detail: 'workoutScheduleSummariesScalar was null; treated as an empty slice',
      }
    }
    const inner = extractCalendarPage(scalar)
    return inner
  }
  if ('items' in record) {
    if (!Array.isArray(record.items)) {
      return unreadablePage('items envelope without an array')
    }
    const cursor = record.nextCursor
    return {
      status: record.items.length > 0 ? 'items' : 'empty',
      items: record.items,
      nextCursor: typeof cursor === 'string' && cursor.trim() ? cursor : null,
      truncated: record.truncated === true,
      detail: record.truncated === true ? 'provider reported a truncated page' : null,
    }
  }
  return unreadablePage('response has no recognized items field')
}

export interface MappedCalendarItem {
  entry: CalendarEntry | null
  warnings: string[]
  /** True when the item could not be classified well enough to claim a complete read. */
  incomplete: boolean
}

const IDENTIFIER_FIELDS_WITHOUT_VERIFIED_MEANING = [
  'id',
  'scheduleId',
  'calendarItemId',
  'workoutScheduleUuid',
  'calendarEventId',
]

export interface CalendarEntryIdParse {
  status: 'ok' | 'absent' | 'invalid' | 'conflict'
  value: string | null
  detail: string
}

/**
 * The calendar-entry (schedule instance) id of one provider item.
 *
 * Two provider field names carry it, and they are not interchangeable names for
 * one response shape: the range read answers with `scheduledWorkoutId` (see
 * RANGE_QUERY_EVIDENCE), while the schedule POST answers with
 * `workoutScheduleId` (see CALENDAR_ENTRY_ID_ALIAS_FIELD). Both are accepted so
 * that an item from either shape maps, but a response that carries both names
 * with different values is a conflict rather than a preference order: either
 * value could be the entry that a later DELETE would remove, so no id is
 * returned and the item is reported as unreadable instead of guessed.
 */
export function parseCalendarEntryId(item: Record<string, unknown>): CalendarEntryIdParse {
  const primary = parseProviderId(item[CALENDAR_ENTRY_ID_FIELD])
  const alias = parseProviderId(item[CALENDAR_ENTRY_ID_ALIAS_FIELD])
  if (primary.status === 'invalid') {
    return {
      status: 'invalid',
      value: null,
      detail: `${CALENDAR_ENTRY_ID_FIELD} is unusable: ${primary.detail}`,
    }
  }
  if (alias.status === 'invalid') {
    return {
      status: 'invalid',
      value: null,
      detail: `${CALENDAR_ENTRY_ID_ALIAS_FIELD} is unusable: ${alias.detail}`,
    }
  }
  if (primary.status === 'ok' && alias.status === 'ok' && primary.value !== alias.value) {
    return {
      status: 'conflict',
      value: null,
      detail: `${CALENDAR_ENTRY_ID_FIELD}=${primary.value} and ` +
        `${CALENDAR_ENTRY_ID_ALIAS_FIELD}=${alias.value} disagree`,
    }
  }
  if (primary.status === 'ok') return { status: 'ok', value: primary.value, detail: '' }
  if (alias.status === 'ok') return { status: 'ok', value: alias.value, detail: '' }
  return { status: 'absent', value: null, detail: '' }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * Map one provider item.
 *
 * `workoutId` (the workout template) and `workoutScheduleId` (the calendar
 * entry) are filled only from their own field names — for the entry id that
 * means `scheduledWorkoutId` or its write-path alias, never a generic `id`,
 * which is never promoted into either of them. Turning an unknown identifier
 * into an unschedule target would be exactly the "guess an ID" failure the plan
 * forbids.
 */
export function mapCalendarItem(raw: unknown): MappedCalendarItem {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      entry: null,
      warnings: [calendarWarning(
        CALENDAR_WARNING_CODES.UNREADABLE_ITEM,
        `provider item is not an object (${raw === null ? 'null' : typeof raw})`,
      )],
      incomplete: true,
    }
  }
  const item = raw as Record<string, unknown>
  const warnings: string[] = []
  let incomplete = false

  const dateCandidate = item.scheduleDate ?? item.date
  if (dateCandidate === undefined || dateCandidate === null) {
    return {
      entry: null,
      warnings: [calendarWarning(
        CALENDAR_WARNING_CODES.UNREADABLE_ITEM,
        'provider item has no date field',
      )],
      incomplete: true,
    }
  }
  if (!isValidCalendarDate(dateCandidate)) {
    return {
      entry: null,
      warnings: [calendarWarning(
        CALENDAR_WARNING_CODES.ITEM_DATE_INVALID,
        `provider item date ${JSON.stringify(String(dateCandidate).slice(0, 30))} is not YYYY-MM-DD`,
      )],
      incomplete: true,
    }
  }

  let workoutId: string | null = null
  const workoutIdParse = parseProviderId(item.workoutId)
  if (workoutIdParse.status === 'ok') {
    if (workoutIdParse.numeric) {
      workoutId = workoutIdParse.value
    } else {
      incomplete = true
      warnings.push(calendarWarning(
        CALENDAR_WARNING_CODES.ITEM_ID_INVALID,
        'workoutId is not a numeric library id; treating this item as unclassified',
      ))
    }
  } else if (workoutIdParse.status === 'invalid') {
    incomplete = true
    warnings.push(calendarWarning(
      CALENDAR_WARNING_CODES.ITEM_ID_INVALID,
      `workoutId is unusable: ${workoutIdParse.detail}`,
    ))
  }

  let workoutScheduleId: string | null = null
  const entryId = parseCalendarEntryId(item)
  if (entryId.status === 'ok') {
    workoutScheduleId = entryId.value
  } else if (entryId.status === 'invalid') {
    incomplete = true
    warnings.push(calendarWarning(CALENDAR_WARNING_CODES.ITEM_ID_INVALID, entryId.detail))
  } else if (entryId.status === 'conflict') {
    // Two different entry ids on one item: unscheduling the wrong one would
    // remove someone else's calendar entry, so neither is used.
    incomplete = true
    warnings.push(calendarWarning(
      CALENDAR_WARNING_CODES.ITEM_ID_CONFLICT,
      `${entryId.detail}; no schedule id is derived from this item`,
    ))
  } else {
    const unmapped = IDENTIFIER_FIELDS_WITHOUT_VERIFIED_MEANING.filter(
      (field) => item[field] !== undefined && item[field] !== null,
    )
    if (unmapped.length > 0) {
      // Identity we can see but cannot use: retained and reported, never
      // promoted into an id we would later act on.
      warnings.push(calendarWarning(
        CALENDAR_WARNING_CODES.UNMAPPED_ITEM_IDENTIFIER,
        `item exposes ${unmapped.join(', ')} but no schedule id; ` +
        'no verified mapping exists, so no schedule id is derived',
      ))
    }
  }

  const planName = stringOrNull(item.tpPlanName)
  const workoutUuid = stringOrNull(item.workoutUuid)
  const sport = stringOrNull(item.workoutType)
  const restDay = item.isRestDay === true
  const race = item.race === true
  const title = stringOrNull(item.workoutName) ?? stringOrNull(item.title)

  if (
    workoutId === null
    && entryId.status !== 'ok'
    && planName === null
    && workoutUuid === null
    && !restDay
    && !race
    && sport === null
  ) {
    incomplete = true
    warnings.push(calendarWarning(
      CALENDAR_WARNING_CODES.UNKNOWN_ITEM_KIND,
      `item on ${dateCandidate} has no recognizable workout or plan identity`,
    ))
  }

  return {
    entry: {
      date: dateCandidate,
      kind: workoutId !== null ? 'workout' : 'other',
      workoutId,
      workoutScheduleId,
      title,
      workoutUuid,
      planName,
      restDay,
      race,
      sport,
    },
    warnings,
    incomplete,
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface CalendarAdapterOptions {
  region: string
  transport: CalendarGraphqlTransport
  now?: () => Date
  maxChunks?: number
  maxPagesPerChunk?: number
  maxItems?: number
  maxRangeDays?: number
}

export interface CalendarAdapter extends CalendarReader {
  readonly region: string
  readonly capability: CalendarCapability
}

function entryIdentity(entry: CalendarEntry): string {
  return [
    entry.date,
    entry.kind,
    entry.workoutId ?? '',
    entry.workoutScheduleId ?? '',
    entry.workoutUuid ?? '',
  ].join('|')
}

function intersectRange(
  chunk: { startDate: string; endDate: string },
  range: CalendarRange,
): CalendarMissingRange | null {
  const startDate = chunk.startDate > range.startDate ? chunk.startDate : range.startDate
  const endDate = chunk.endDate < range.endDate ? chunk.endDate : range.endDate
  if (startDate > endDate) return null
  return { startDate, endDate }
}

export function createCalendarAdapter(options: CalendarAdapterOptions): CalendarAdapter {
  const region = options.region
  const capability = describeCalendarCapability(region)
  const transport = options.transport
  const now = options.now ?? (() => new Date())
  const maxChunks = options.maxChunks ?? DEFAULT_MAX_CHUNKS
  const maxPagesPerChunk = options.maxPagesPerChunk ?? DEFAULT_MAX_PAGES_PER_CHUNK
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS
  const maxRangeDays = options.maxRangeDays ?? MAX_CALENDAR_RANGE_DAYS

  async function getCalendarRange(range: CalendarRange): Promise<CalendarSnapshot> {
    // Capability gate first: an unsupported region must not build or send a
    // request, and must not return an empty snapshot that looks like evidence.
    if (!capability.supported) {
      const error = notAppliedWriteError(
        WRITE_ERROR_CODES.CALENDAR_QUERY_UNSUPPORTED,
        `Garmin Calendar range queries are not supported for region '${region}': ` +
        capability.reason,
      ) as GarminWriteError
      throw error
    }

    validateRange(range, maxRangeDays)

    const fetchedAt = now().toISOString()
    const warnings: string[] = [calendarWarning(
      CALENDAR_WARNING_CODES.BOUNDARY_PADDING_APPLIED,
      `provider date-range inclusivity is unverified; every slice is probed with ` +
      `${CALENDAR_BOUNDARY_PAD_DAYS} extra day on each side and entries outside the ` +
      'requested range are ignored',
    )]
    if (!isUtcLabel(range.timezone)) {
      warnings.push(calendarWarning(
        CALENDAR_WARNING_CODES.TIMEZONE_NOT_IN_VERIFIED_PROTOCOL,
        `timezone '${range.timezone}' is echoed only: the verified query carries no ` +
        'timezone parameter, and no date is shifted',
      ))
    }

    const chunks = enumerateMonthChunks(range.startDate, range.endDate)
    let complete = true
    let requestsIssued = 0
    const missingRanges: CalendarMissingRange[] = []
    const entries: CalendarEntry[] = []
    const seenIdentities = new Set<string>()

    if (chunks.length > maxChunks) {
      warnings.push(calendarWarning(
        CALENDAR_WARNING_CODES.CHUNK_LIMIT_EXCEEDED,
        `range needs ${chunks.length} slices, limit is ${maxChunks}; nothing was read`,
      ))
      missingRanges.push({ startDate: range.startDate, endDate: range.endDate })
      complete = false
      return snapshot(range, fetchedAt, range, entries, complete, missingRanges, warnings, requestsIssued)
    }

    // Every slice actually sent to the provider, so the reported `probedRange`
    // is a fact about this read rather than a recomputation that could drift.
    const probedSlices: Array<{ startDate: string; endDate: string }> = []
    let stop = false

    for (const chunk of chunks) {
      if (stop) {
        const missing = intersectRange(chunk, range)
        if (missing) missingRanges.push(missing)
        complete = false
        continue
      }
      const probed = padChunk(chunk)
      probedSlices.push(probed)
      const query = buildScheduleSummaryQuery(probed.startDate, probed.endDate)
      const seenCursors = new Set<string>()
      let cursor: string | undefined
      let pageDone = false
      let pageFailure: string | null = null
      // A slice whose pages were usable but knowingly partial (provider said
      // truncated, or a cursor loop was cut short) still belongs in
      // `missingRanges`: "we did not read all of it" is a range-level fact.
      let partialSlice = false

      for (let page = 0; page < maxPagesPerChunk; page += 1) {
        requestsIssued += 1
        let response: unknown
        try {
          response = await transport.query(cursor === undefined ? { query } : { query, cursor })
        } catch (error) {
          pageFailure = `request failed: ${error instanceof Error ? error.message : String(error)}`
          break
        }
        const extracted = extractCalendarPage(response)
        if (extracted.status === 'unreadable') {
          pageFailure = extracted.detail ?? 'unreadable response'
          warnings.push(calendarWarning(
            CALENDAR_WARNING_CODES.RESPONSE_UNREADABLE,
            `slice ${probed.startDate}..${probed.endDate}: ${pageFailure}`,
          ))
          break
        }
        if (extracted.detail && extracted.status === 'empty') {
          warnings.push(calendarWarning(
            CALENDAR_WARNING_CODES.NULL_RESULT_TREATED_AS_EMPTY,
            `slice ${probed.startDate}..${probed.endDate}: ${extracted.detail}`,
          ))
        }
        const preexisting = new Set(seenIdentities)
        for (const raw of extracted.items) {
          const mapped = mapCalendarItem(raw)
          warnings.push(...mapped.warnings)
          if (mapped.incomplete) complete = false
          if (!mapped.entry) continue
          if (mapped.entry.date < range.startDate || mapped.entry.date > range.endDate) continue
          const identity = entryIdentity(mapped.entry)
          // A page repeats what an earlier page already returned (padding
          // overlap or a provider that re-sends a page): collapse it. Two
          // genuinely separate entries inside one page are both kept.
          if (preexisting.has(identity)) continue
          seenIdentities.add(identity)
          entries.push(mapped.entry)
          // Hard cap: stop inside the page instead of letting one oversized
          // page blow past the limit.
          if (entries.length > maxItems) break
        }
        if (entries.length > maxItems) {
          warnings.push(calendarWarning(
            CALENDAR_WARNING_CODES.ITEMS_LIMIT_EXCEEDED,
            `collected more than ${maxItems} entries; stopping the read`,
          ))
          complete = false
          stop = true
          // The slice was not read to its end, so it is both partial and
          // missing from `missingRanges`; mark it done so the page-limit
          // warning below is not raised for a loop we left on purpose.
          pageDone = true
          partialSlice = true
          break
        }
        if (extracted.truncated) {
          warnings.push(calendarWarning(
            CALENDAR_WARNING_CODES.RESPONSE_TRUNCATED,
            `slice ${probed.startDate}..${probed.endDate} was truncated by the provider`,
          ))
          complete = false
          pageFailure = null
          pageDone = true
          partialSlice = true
          break
        }
        if (extracted.nextCursor === null) {
          pageDone = true
          break
        }
        if (seenCursors.has(extracted.nextCursor)) {
          warnings.push(calendarWarning(
            CALENDAR_WARNING_CODES.CURSOR_LOOP_DETECTED,
            `slice ${probed.startDate}..${probed.endDate} repeated cursor ` +
            `${JSON.stringify(extracted.nextCursor)}; stopping instead of looping`,
          ))
          complete = false
          pageFailure = null
          pageDone = true
          partialSlice = true
          break
        }
        seenCursors.add(extracted.nextCursor)
        cursor = extracted.nextCursor
      }

      if (!pageDone && pageFailure === null) {
        warnings.push(calendarWarning(
          CALENDAR_WARNING_CODES.PAGE_LIMIT_EXCEEDED,
          `slice ${probed.startDate}..${probed.endDate} exceeded ${maxPagesPerChunk} pages`,
        ))
        complete = false
      }
      if (pageFailure !== null) {
        warnings.push(calendarWarning(
          CALENDAR_WARNING_CODES.CHUNK_READ_FAILED,
          `slice ${probed.startDate}..${probed.endDate}: ${pageFailure}`,
        ))
        const missing = intersectRange(chunk, range)
        if (missing) missingRanges.push(missing)
        complete = false
      } else if (!pageDone || partialSlice) {
        const missing = intersectRange(chunk, range)
        if (missing) missingRanges.push(missing)
      }
    }

    return snapshot(
      range,
      fetchedAt,
      probedRangeOf(probedSlices, range),
      entries,
      complete,
      missingRanges,
      warnings,
      requestsIssued,
    )
  }

  return { region, capability, getCalendarRange }
}

/** Smallest probed start / largest probed end, or the requested range if none. */
function probedRangeOf(
  slices: Array<{ startDate: string; endDate: string }>,
  range: CalendarRange,
): CalendarRange {
  if (slices.length === 0) return { ...range }
  let startDate = slices[0].startDate
  let endDate = slices[0].endDate
  for (const slice of slices) {
    if (slice.startDate < startDate) startDate = slice.startDate
    if (slice.endDate > endDate) endDate = slice.endDate
  }
  return { startDate, endDate, timezone: range.timezone }
}

function isUtcLabel(timezone: string): boolean {
  return timezone === 'UTC' || timezone === 'GMT' || timezone === 'Etc/UTC'
}

function validateRange(range: CalendarRange, maxRangeDays: number): void {
  if (typeof range !== 'object' || range === null) {
    throw new CalendarRangeError('CALENDAR_RANGE_INVALID', 'A calendar range is required')
  }
  if (!isValidCalendarDate(range.startDate) || !isValidCalendarDate(range.endDate)) {
    throw new CalendarRangeError(
      'CALENDAR_RANGE_INVALID',
      'Calendar range dates must be real proleptic Gregorian dates in YYYY-MM-DD',
    )
  }
  if (range.startDate > range.endDate) {
    throw new CalendarRangeError(
      'CALENDAR_RANGE_INVALID',
      `Range start ${range.startDate} is after end ${range.endDate}`,
    )
  }
  if (typeof range.timezone !== 'string' || !range.timezone.trim()) {
    throw new CalendarRangeError('CALENDAR_RANGE_INVALID', 'A non-empty timezone label is required')
  }
  const days = calendarDayCount(range.startDate, range.endDate)
  if (days > maxRangeDays) {
    throw new CalendarRangeError(
      'CALENDAR_RANGE_TOO_LONG',
      `Calendar range covers ${days} days; the maximum is ${maxRangeDays}`,
    )
  }
}

function snapshot(
  range: CalendarRange,
  fetchedAt: string,
  probedRange: CalendarRange,
  entries: CalendarEntry[],
  complete: boolean,
  missingRanges: CalendarMissingRange[],
  warnings: string[],
  requestsIssued: number,
): CalendarSnapshot {
  return {
    range,
    probedRange,
    entries,
    fetchedAt,
    complete,
    missingRanges: mergeRanges(missingRanges),
    warnings,
    requestsIssued,
  }
}

function mergeRanges(ranges: CalendarMissingRange[]): CalendarMissingRange[] {
  const sorted = [...ranges].sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0))
  const merged: CalendarMissingRange[] = []
  for (const current of sorted) {
    const last = merged[merged.length - 1]
    if (last && current.startDate <= addCalendarDays(last.endDate, 1)) {
      if (current.endDate > last.endDate) last.endDate = current.endDate
      continue
    }
    merged.push({ ...current })
  }
  return merged
}

/** Warning code lookup re-exported so tests and callers share one vocabulary. */
export { CALENDAR_WARNING_CODES }
export type { CalendarWarningCode }

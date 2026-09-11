/**
 * Calendar range query tests (C6).
 *
 * The adapter under test is a *read* surface, and the whole point of the
 * contract is that a read can never be turned into a statement about a write
 * attempt. These tests therefore come in four groups:
 *
 *  1. date arithmetic that must not depend on the host clock or timezone
 *     (leap days, DST transitions, 366/367-day limits);
 *  2. request construction that must stay inside verified evidence, with the
 *     unsupported regions/capabilities refused *before* a request exists;
 *  3. response handling that must never invent evidence: an unreadable or
 *     partial read is `complete:false`, an item whose identity we cannot map
 *     is reported instead of guessed;
 *  4. the type-level separation between "a complete read did not show the
 *     target" and "an unknown write definitely never happened".
 *
 * Every fixture below is either hand-written from the documented provider
 * response shape (see docs/calendar-api-verification.md) or a deliberately
 * hostile variant of it. `fixtures/calendar/workout-schedule-summaries.synthetic.json`
 * carries one whole envelope in the field set the public sources agree on; it is
 * a synthesis of those sources, **not** a capture from a live account, and no
 * assertion here may depend on a real Garmin response.
 */
import {
  CALENDAR_WARNING_CODES,
  CalendarObservation,
  CalendarRange,
  CalendarRangeError,
  CalendarSnapshot,
  CalendarTargetError,
  hasCalendarWarning,
  observeCalendarTarget,
  writeNotAppliedProof,
} from '../src/calendar/types'
import {
  CALENDAR_BOUNDARY_PAD_DAYS,
  CalendarGraphqlRequest,
  CalendarGraphqlTransport,
  MAX_CALENDAR_RANGE_DAYS,
  addCalendarDays,
  buildScheduleSummaryQuery,
  calendarDayCount,
  createCalendarAdapter,
  describeCalendarCapability,
  enumerateMonthChunks,
  extractCalendarPage,
  isValidCalendarDate,
  mapCalendarItem,
  padChunk,
  parseProviderId,
} from '../src/calendar/adapter'
import { GarminWriteError, WRITE_ERROR_CODES } from '../src/write-operations/errors'

const UTC = 'UTC'

/**
 * One whole envelope in the field set the public sources agree on (see
 * docs/calendar-api-verification.md §4). Synthesized from those sources, not
 * captured from an account: every id, name and date in it is invented.
 */
const SYNTHETIC_ENVELOPE = require(
  './fixtures/calendar/workout-schedule-summaries.synthetic.json',
) as { data: { workoutScheduleSummariesScalar: unknown[] } }

function range(startDate: string, endDate: string, timezone = UTC): CalendarRange {
  return { startDate, endDate, timezone }
}

interface Recorder {
  transport: CalendarGraphqlTransport
  requests: CalendarGraphqlRequest[]
}

/** A transport that records the exact envelopes it is asked to send. */
function recordingTransport(
  responder: (request: CalendarGraphqlRequest, index: number) => unknown,
): Recorder {
  const requests: CalendarGraphqlRequest[] = []
  const transport: CalendarGraphqlTransport = {
    query: jest.fn(async (request: CalendarGraphqlRequest) => {
      requests.push(request)
      return responder(request, requests.length - 1)
    }),
  }
  return { transport, requests }
}

/** Every slice of a slice-based responder, so assertions can check coverage. */
function sliceResponder(byDate: Record<string, unknown[]>): (request: CalendarGraphqlRequest) => unknown {
  return (request) => {
    const match = /startDate:"(\d{4}-\d{2}-\d{2})"/.exec(request.query)
    if (!match) throw new Error(`unexpected query: ${request.query}`)
    if (!(match[1] in byDate)) throw new Error(`unexpected slice start ${match[1]}`)
    return { data: { workoutScheduleSummariesScalar: byDate[match[1]] } }
  }
}

function adapterFor(
  responder: (request: CalendarGraphqlRequest, index: number) => unknown,
  options: Partial<Parameters<typeof createCalendarAdapter>[0]> = {},
) {
  const recorder = recordingTransport(responder)
  const adapter = createCalendarAdapter({
    region: 'global',
    transport: recorder.transport,
    ...options,
  })
  return { adapter, ...recorder }
}

// ---------------------------------------------------------------------------
// 1. Date arithmetic
// ---------------------------------------------------------------------------

describe('calendar date helpers', () => {
  it('accepts only real proleptic Gregorian YYYY-MM-DD days', () => {
    for (const value of [
      '2026-09-10',
      '2024-02-29',
      '2028-02-29',
      '2000-02-29',
      '2026-12-31',
    ]) {
      expect(isValidCalendarDate(value)).toBe(true)
    }
    for (const value of [
      '2026-02-29', // 2026 is not a leap year
      '2100-02-29', // century non-leap
      '2026-02-30',
      '2026-04-31',
      '2026-13-01',
      '2026-00-10',
      '2026-09-00',
      '2026-9-1',
      '2026-09-10T00:00:00Z',
      '20260910',
      '',
      '  ',
    ]) {
      expect(isValidCalendarDate(value)).toBe(false)
    }
    expect(isValidCalendarDate(null)).toBe(false)
    expect(isValidCalendarDate(20260910)).toBe(false)
  })

  it('shifts across leap days, month ends and year ends', () => {
    expect(addCalendarDays('2024-02-28', 1)).toBe('2024-02-29')
    expect(addCalendarDays('2024-02-29', 1)).toBe('2024-03-01')
    expect(addCalendarDays('2024-03-01', -1)).toBe('2024-02-29')
    expect(addCalendarDays('2026-02-28', 1)).toBe('2026-03-01')
    expect(addCalendarDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addCalendarDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(addCalendarDays('2026-09-10', 0)).toBe('2026-09-10')
    expect(addCalendarDays('2026-09-10', 366)).toBe('2027-09-11')
  })

  it('refuses a shift it cannot represent instead of guessing', () => {
    expect(() => addCalendarDays('2026-02-30', 1)).toThrow(CalendarRangeError)
    expect(() => addCalendarDays('not-a-date', 1)).toThrow(/Invalid date/)
    expect(() => addCalendarDays('2026-09-10', 1.5)).toThrow(/Invalid day offset/)
  })

  it('counts inclusive days without leaning on local time', () => {
    expect(calendarDayCount('2026-09-10', '2026-09-10')).toBe(1)
    expect(calendarDayCount('2024-02-01', '2024-02-29')).toBe(29)
    expect(calendarDayCount('2026-02-01', '2026-02-28')).toBe(28)
    expect(calendarDayCount('2024-01-01', '2024-12-31')).toBe(366)
    expect(calendarDayCount('2024-01-01', '2025-01-01')).toBe(367)
    // Order is validated by the range gate, not here; a reversed range is 0 days.
    expect(calendarDayCount('2024-01-02', '2024-01-01')).toBe(0)
    expect(() => calendarDayCount('2024-01-01', '2024-1-2')).toThrow(CalendarRangeError)
  })

  it('counts exactly across a spring-forward and an autumn-back day', () => {
    // US spring forward 2026-03-08, EU autumn back 2026-10-25. A local-time
    // implementation would see a 23- or 25-hour day here.
    expect(calendarDayCount('2026-03-07', '2026-03-09')).toBe(3)
    expect(calendarDayCount('2026-03-08', '2026-03-08')).toBe(1)
    expect(calendarDayCount('2026-10-24', '2026-10-26')).toBe(3)
    expect(addCalendarDays('2026-03-08', 1)).toBe('2026-03-09')
    expect(addCalendarDays('2026-10-25', 1)).toBe('2026-10-26')
    expect(enumerateMonthChunks('2026-03-01', '2026-04-30')).toEqual([
      { startDate: '2026-03-01', endDate: '2026-03-31' },
      { startDate: '2026-04-01', endDate: '2026-04-30' },
    ])
  })

  it('produces identical results when the host timezone is a DST zone', () => {
    // If the runtime ignores the TZ change these assertions still hold; if it
    // honours it, an implementation that used local dates would break here.
    const original = process.env.TZ
    try {
      process.env.TZ = 'Pacific/Chatham' // +12:45/+13:45, a half-hour DST zone
      expect(addCalendarDays('2026-03-08', 1)).toBe('2026-03-09')
      expect(calendarDayCount('2026-09-01', '2026-09-30')).toBe(30)
      expect(enumerateMonthChunks('2026-02-27', '2026-03-02')).toEqual([
        { startDate: '2026-02-27', endDate: '2026-02-28' },
        { startDate: '2026-03-01', endDate: '2026-03-02' },
      ])
    } finally {
      if (original === undefined) delete process.env.TZ
      else process.env.TZ = original
    }
  })

  it('splits a range into contiguous month slices, including across years', () => {
    expect(enumerateMonthChunks('2026-09-10', '2026-09-12')).toEqual([
      { startDate: '2026-09-10', endDate: '2026-09-12' },
    ])
    expect(enumerateMonthChunks('2026-01-31', '2026-02-02')).toEqual([
      { startDate: '2026-01-31', endDate: '2026-01-31' },
      { startDate: '2026-02-01', endDate: '2026-02-02' },
    ])
    expect(enumerateMonthChunks('2025-12-30', '2026-01-02')).toEqual([
      { startDate: '2025-12-30', endDate: '2025-12-31' },
      { startDate: '2026-01-01', endDate: '2026-01-02' },
    ])
    expect(enumerateMonthChunks('2024-02-28', '2024-03-01')).toEqual([
      { startDate: '2024-02-28', endDate: '2024-02-29' },
      { startDate: '2024-03-01', endDate: '2024-03-01' },
    ])
  })

  it('covers a whole leap year exactly once, with no gap and no overlap', () => {
    const chunks = enumerateMonthChunks('2024-01-01', '2024-12-31')
    expect(chunks).toHaveLength(12)
    expect(chunks[0]).toEqual({ startDate: '2024-01-01', endDate: '2024-01-31' })
    expect(chunks[11]).toEqual({ startDate: '2024-12-01', endDate: '2024-12-31' })
    expect(chunks.flatMap((chunk) => [chunk.startDate, chunk.endDate])).toContain('2024-02-29')
    let covered = 0
    for (const [index, chunk] of chunks.entries()) {
      if (index > 0) expect(chunk.startDate).toBe(addCalendarDays(chunks[index - 1].endDate, 1))
      covered += calendarDayCount(chunk.startDate, chunk.endDate)
    }
    expect(covered).toBe(366)
    expect(calendarDayCount(chunks[0].startDate, chunks[chunks.length - 1].endDate)).toBe(366)
  })

  it('rejects unusable chunk enumerations instead of returning a partial plan', () => {
    expect(() => enumerateMonthChunks('2026-09-12', '2026-09-10'))
      .toThrow(/after end/)
    expect(() => enumerateMonthChunks('2026-02-30', '2026-03-01'))
      .toThrow(CalendarRangeError)
  })

  it('pads a slice by one day on each side, wrapping month and year ends', () => {
    expect(CALENDAR_BOUNDARY_PAD_DAYS).toBe(1)
    expect(padChunk({ startDate: '2026-09-10', endDate: '2026-09-12' }))
      .toEqual({ startDate: '2026-09-09', endDate: '2026-09-13' })
    expect(padChunk({ startDate: '2026-03-01', endDate: '2026-03-31' }))
      .toEqual({ startDate: '2026-02-28', endDate: '2026-04-01' })
    expect(padChunk({ startDate: '2025-12-01', endDate: '2025-12-31' }))
      .toEqual({ startDate: '2025-11-30', endDate: '2026-01-01' })
  })

  it('builds the documented query shape verbatim', () => {
    expect(buildScheduleSummaryQuery('2026-09-09', '2026-09-13')).toBe(
      'query{workoutScheduleSummariesScalar(startDate:"2026-09-09", endDate:"2026-09-13")}',
    )
  })
})

// ---------------------------------------------------------------------------
// 2. Evidence gating: regions and unsupported capabilities
// ---------------------------------------------------------------------------

describe('calendar capability gating', () => {
  it('reports the one verified read for the global region', () => {
    const capability = describeCalendarCapability('global')
    expect(capability.supported).toBe(true)
    expect(capability.rangeQuery).toMatchObject({
      status: 'verified',
      method: 'POST',
      path: 'graphql-gateway/graphql',
    })
    expect(capability.rangeQuery.evidence).toContain('workoutScheduleSummariesScalar')
    expect(capability.rangeQuery.evidence).toContain('python-garminconnect@')
    // The envelope and the item field set are confirmed by independent sources,
    // not by one library, so the evidence names more than one of them.
    expect(capability.rangeQuery.evidence).toContain('Taxuspt/garmin_mcp@')
    expect(capability.rangeQuery.evidence).toContain('tamcore/garmin-mcp@')
  })

  it('declares the unverified surfaces as unsupported rather than pretending', () => {
    for (const region of ['global', 'cn']) {
      const capability = describeCalendarCapability(region)
      expect(capability.monthSliceQuery.status).toBe('unsupported')
      // Garmin numbers the month from zero on the wire; the path we report is
      // the one the sources actually name.
      expect(capability.monthSliceQuery.path).toBe('calendar-service/year/{year}/month/{month-1}')
      expect(capability.monthSliceQuery.reason).toMatch(/No first-hand source documents/)
      expect(capability.monthSliceQuery.reason).toMatch(/no REST transport/)
      expect(capability.scheduleIdLookup.status).toBe('unsupported')
      expect(capability.scheduleIdLookup.reason).toMatch(/response shape/)
      expect(capability.pagination.status).toBe('unverified_defensive_cursor')
      expect(capability.pagination.reason).toMatch(/never sent as an input/)
    }
  })

  it('says why the cn region is blocked without claiming a different hostname works', () => {
    const capability = describeCalendarCapability('cn')
    expect(capability.supported).toBe(false)
    expect(capability.reason).toContain('garmin.cn')
    expect(capability.reason).toMatch(/routing/)
  })

  it('refuses a region that has no first-hand calendar-read evidence', async () => {
    for (const region of ['cn', 'eu', '']) {
      const { adapter, requests } = adapterFor(
        () => ({ data: { workoutScheduleSummariesScalar: [] } }),
        { region },
      )
      expect(adapter.capability.supported).toBe(false)
      expect(adapter.capability.rangeQuery.status).toBe('unsupported')
      await expect(adapter.getCalendarRange(range('2026-09-10', '2026-09-12')))
        .rejects.toMatchObject({
          name: 'GarminWriteError',
          code: WRITE_ERROR_CODES.CALENDAR_QUERY_UNSUPPORTED,
          outcome: 'not_applied',
        })
      // No request may be built, let alone sent, for an unsupported region.
      expect(requests).toHaveLength(0)
    }
  })

  it('does not fall back to an empty snapshot for an unsupported region', async () => {
    const { adapter } = adapterFor(
      () => ({ data: { workoutScheduleSummariesScalar: [] } }),
      { region: 'cn' },
    )
    const outcome = await adapter.getCalendarRange(range('2026-09-10', '2026-09-12'))
      .then(() => 'resolved', (error: unknown) => error)
    expect(outcome).toBeInstanceOf(GarminWriteError)
    expect((outcome as GarminWriteError).message).toContain("region 'cn'")
  })

  it('gates the region before it validates the range it was given', async () => {
    const { adapter, requests } = adapterFor(
      () => ({ data: { workoutScheduleSummariesScalar: [] } }),
      { region: 'cn' },
    )
    await expect(adapter.getCalendarRange(range('2026-09-12', '2026-09-10')))
      .rejects.toMatchObject({ code: WRITE_ERROR_CODES.CALENDAR_QUERY_UNSUPPORTED })
    expect(requests).toHaveLength(0)
  })

  it('never builds a request for the unverified month endpoint', async () => {
    const { adapter, requests } = adapterFor(() => ({ data: { workoutScheduleSummariesScalar: [] } }))
    await adapter.getCalendarRange(range('2026-01-31', '2026-02-02'))
    expect(requests).toHaveLength(2)
    for (const request of requests) {
      expect(request.query).toMatch(/^query\{workoutScheduleSummariesScalar/)
      expect(request.query).not.toContain('calendar-service')
    }
  })
})

// ---------------------------------------------------------------------------
// 3. Response parsing
// ---------------------------------------------------------------------------

const ITEM = { scheduleDate: '2026-09-10', workoutId: 42, workoutName: 'Easy run' }

describe('provider response parsing', () => {
  it('reads the GraphQL envelope, a bare array and a JSON-encoded scalar', () => {
    const expected = {
      status: 'items',
      items: [ITEM],
      nextCursor: null,
      truncated: false,
      detail: null,
    }
    expect(extractCalendarPage({ data: { workoutScheduleSummariesScalar: [ITEM] } }))
      .toEqual(expected)
    expect(extractCalendarPage({ workoutScheduleSummariesScalar: [ITEM] })).toEqual(expected)
    expect(extractCalendarPage([ITEM])).toEqual(expected)
    expect(extractCalendarPage(JSON.stringify([ITEM]))).toEqual(expected)
    expect(extractCalendarPage(JSON.stringify({ data: { workoutScheduleSummariesScalar: [ITEM] } })))
      .toEqual(expected)
  })

  it('treats a null scalar as an empty slice and says so', () => {
    const empty = extractCalendarPage({ data: { workoutScheduleSummariesScalar: null } })
    expect(empty.status).toBe('empty')
    expect(empty.items).toEqual([])
    expect(empty.detail).toContain('treated as an empty slice')
    expect(extractCalendarPage({ data: { workoutScheduleSummariesScalar: [] } }).detail).toBeNull()
    expect(extractCalendarPage('   ').status).toBe('empty')
    expect(extractCalendarPage('   ').detail).toBeNull()
  })

  it('surfaces a cursor and a truncation flag when the provider sends them', () => {
    expect(extractCalendarPage({ items: [ITEM], nextCursor: 'page-2' })).toMatchObject({
      status: 'items',
      nextCursor: 'page-2',
      truncated: false,
    })
    expect(extractCalendarPage({ items: [ITEM], nextCursor: '   ' }).nextCursor).toBeNull()
    expect(extractCalendarPage({ items: [ITEM], truncated: true })).toMatchObject({
      truncated: true,
      detail: expect.stringContaining('truncated'),
    })
  })

  it('reports an unrecognised response as unreadable instead of empty', () => {
    for (const response of [
      42,
      null,
      {},
      { items: 'not-an-array' },
      { unexpected: [] },
      '{not json',
      undefined,
    ]) {
      const page = extractCalendarPage(response)
      expect(page.status).toBe('unreadable')
      expect(page.items).toEqual([])
      expect(page.detail).toBeTruthy()
    }
  })

  it('treats a reported GraphQL error as a failure, never as an empty calendar', () => {
    // A gateway can answer with part of the data and an `errors` array. Two
    // public implementations treat that as a failure; reading an empty array
    // plus errors as "the calendar is empty" would be the one wrong reading.
    const withEmptyData = extractCalendarPage({
      data: { workoutScheduleSummariesScalar: [] },
      errors: [{ message: 'gateway refused the query' }],
    })
    expect(withEmptyData.status).toBe('unreadable')
    expect(withEmptyData.items).toEqual([])
    expect(withEmptyData.detail).toContain('1 GraphQL error(s)')
    expect(withEmptyData.detail).toContain('gateway refused the query')

    const withItems = extractCalendarPage({
      data: { workoutScheduleSummariesScalar: [ITEM] },
      errors: [{ message: 'partial failure' }],
    })
    expect(withItems.status).toBe('unreadable')

    // An empty or absent errors array is not an error.
    expect(extractCalendarPage({ data: { workoutScheduleSummariesScalar: [] }, errors: [] }).status)
      .toBe('empty')
    const long = extractCalendarPage({
      data: { workoutScheduleSummariesScalar: [] },
      errors: [{ message: `${'x'.repeat(200)}` }, { message: '' }],
    })
    // The upstream text is reported bounded and with whitespace collapsed.
    expect(long.detail).toContain('…')
    expect(long.detail).toContain('unnamed GraphQL error')
  })
})

describe('provider item mapping', () => {
  it('keeps ids as strings and fills only their own fields', () => {
    const mapped = mapCalendarItem({
      scheduleDate: '2026-09-10',
      workoutId: 123456789,
      workoutScheduleId: 987654321,
      workoutUuid: '3f1c9e6a-1d2b-4c3d-8e4f-5a6b7c8d9e0f',
      workoutName: 'Tempo 8k',
      workoutType: 'running',
    })
    expect(mapped.incomplete).toBe(false)
    expect(mapped.warnings).toEqual([])
    expect(mapped.entry).toMatchObject({
      date: '2026-09-10',
      kind: 'workout',
      workoutId: '123456789',
      workoutScheduleId: '987654321',
      workoutUuid: '3f1c9e6a-1d2b-4c3d-8e4f-5a6b7c8d9e0f',
      title: 'Tempo 8k',
      sport: 'running',
    })
  })

  it('rejects a numeric id that would silently lose precision', () => {
    expect(parseProviderId(Number.MAX_SAFE_INTEGER))
      .toEqual({ status: 'ok', value: String(Number.MAX_SAFE_INTEGER), numeric: true })
    expect(parseProviderId(Number.MAX_SAFE_INTEGER + 1)).toMatchObject({
      status: 'invalid',
      detail: expect.stringContaining('precision'),
    })
    expect(parseProviderId(0)).toMatchObject({ status: 'invalid' })
    expect(parseProviderId(-5)).toMatchObject({ status: 'invalid' })

    // The string form survives: no rounding, no Number() conversion.
    const huge = '9007199254740993'
    expect(parseProviderId(huge)).toEqual({ status: 'ok', value: huge, numeric: true })
    const mapped = mapCalendarItem({
      scheduleDate: '2026-09-10',
      workoutId: huge,
      workoutScheduleId: huge,
    })
    expect(mapped.entry).toMatchObject({ workoutId: huge, workoutScheduleId: huge })
    expect(mapped.incomplete).toBe(false)
  })

  it('flags an unusable id instead of coercing it', () => {
    for (const workoutId of ['', '   ', 'abc', { nested: true }, Number.MAX_SAFE_INTEGER + 1]) {
      const mapped = mapCalendarItem({ scheduleDate: '2026-09-10', workoutId })
      expect(mapped.incomplete).toBe(true)
      expect(mapped.entry?.workoutId).toBeNull()
      expect(hasCalendarWarning({ warnings: mapped.warnings }, CALENDAR_WARNING_CODES.ITEM_ID_INVALID))
        .toBe(true)
    }
    expect(parseProviderId(undefined)).toEqual({ status: 'absent' })
    expect(parseProviderId(null)).toEqual({ status: 'absent' })
    expect(parseProviderId({})).toMatchObject({ status: 'invalid', detail: expect.stringContaining('type') })
  })

  it('never promotes a generic id into workoutId or workoutScheduleId', () => {
    const mapped = mapCalendarItem({
      scheduleDate: '2026-09-10',
      id: 555,
      scheduleId: 777,
      calendarItemId: 888,
      workoutUuid: '3f1c9e6a-1d2b-4c3d-8e4f-5a6b7c8d9e0f',
    })
    expect(mapped.entry?.workoutScheduleId).toBeNull()
    expect(mapped.entry?.workoutId).toBeNull()
    expect(mapped.warnings.some((warning) =>
      warning.includes(CALENDAR_WARNING_CODES.UNMAPPED_ITEM_IDENTIFIER))).toBe(true)
    expect(mapped.warnings.some((warning) =>
      warning.includes('scheduleId'))).toBe(true)
  })

  it('accepts a schedule id on its own as a calendar item', () => {
    const mapped = mapCalendarItem({ scheduleDate: '2026-09-10', workoutScheduleId: 987654321 })
    expect(mapped.incomplete).toBe(false)
    expect(mapped.entry).toMatchObject({
      kind: 'other',
      workoutId: null,
      workoutScheduleId: '987654321',
    })
  })

  it('maps the range read\'s own entry-id field name', () => {
    // `scheduledWorkoutId` is the name the range query answers with; the POST
    // response uses `workoutScheduleId`. Both must land in the same field, or a
    // real read would hand back no unschedulable id at all.
    const scheduled = mapCalendarItem({
      scheduleDate: '2026-09-10',
      scheduledWorkoutId: 9001,
      workoutId: 42,
      workoutName: 'Easy Run',
    })
    expect(scheduled.incomplete).toBe(false)
    expect(scheduled.warnings).toEqual([])
    expect(scheduled.entry).toMatchObject({
      kind: 'workout',
      workoutId: '42',
      workoutScheduleId: '9001',
    })

    // ...and keeps exactness for the string form, as it does for workoutId.
    const huge = '9007199254740993'
    const big = mapCalendarItem({ scheduleDate: '2026-09-10', scheduledWorkoutId: huge })
    expect(big.incomplete).toBe(false)
    expect(big.entry?.workoutScheduleId).toBe(huge)

    // A coach entry can carry no entry id at all; that is not a failure.
    const coach = mapCalendarItem({
      scheduleDate: '2026-09-11',
      scheduledWorkoutId: null,
      workoutUuid: '3f1c9e6a-1d2b-4c3d-8e4f-5a6b7c8d9e0f',
    })
    expect(coach.incomplete).toBe(false)
    expect(coach.entry?.workoutScheduleId).toBeNull()
  })

  it('refuses two disagreeing entry ids instead of picking one', () => {
    const conflict = mapCalendarItem({
      scheduleDate: '2026-09-10',
      scheduledWorkoutId: 9001,
      workoutScheduleId: 9002,
      workoutId: 42,
    })
    expect(conflict.incomplete).toBe(true)
    expect(conflict.entry?.workoutScheduleId).toBeNull()
    expect(hasCalendarWarning(
      { warnings: conflict.warnings },
      CALENDAR_WARNING_CODES.ITEM_ID_CONFLICT,
    )).toBe(true)
    expect(conflict.warnings.join(' ')).toContain('9001')
    expect(conflict.warnings.join(' ')).toContain('9002')

    // Agreeing names are not a conflict, and an unusable value is still an
    // id problem rather than a conflict.
    const agree = mapCalendarItem({
      scheduleDate: '2026-09-10',
      scheduledWorkoutId: 9001,
      workoutScheduleId: '9001',
    })
    expect(agree.incomplete).toBe(false)
    expect(agree.entry?.workoutScheduleId).toBe('9001')

    const broken = mapCalendarItem({
      scheduleDate: '2026-09-10',
      scheduledWorkoutId: 'not-an-id',
      workoutId: 42,
    })
    expect(broken.incomplete).toBe(true)
    expect(hasCalendarWarning(
      { warnings: broken.warnings },
      CALENDAR_WARNING_CODES.ITEM_ID_INVALID,
    )).toBe(true)
  })

  it('keeps plan, rest-day, race and sport items distinguishable', () => {
    const plan = mapCalendarItem({
      scheduleDate: '2026-09-10',
      tpPlanName: 'Marathon block W3',
      workoutId: 42,
    })
    expect(plan.incomplete).toBe(false)
    expect(plan.entry).toMatchObject({
      kind: 'workout',
      workoutId: '42',
      planName: 'Marathon block W3',
      restDay: false,
      race: false,
    })

    const rest = mapCalendarItem({ date: '2026-09-11', isRestDay: true })
    expect(rest.incomplete).toBe(false)
    expect(rest.entry).toMatchObject({ date: '2026-09-11', restDay: true, kind: 'other' })

    const race = mapCalendarItem({ scheduleDate: '2026-10-01', race: true, workoutId: 43 })
    expect(race.entry).toMatchObject({ race: true, kind: 'workout', workoutId: '43' })

    const other = mapCalendarItem({
      scheduleDate: '2026-09-12',
      workoutType: 'cycling',
      title: 'Ride',
    })
    expect(other.entry).toMatchObject({ sport: 'cycling', title: 'Ride', kind: 'other' })
  })

  it('reports items it cannot read or classify instead of dropping them silently', () => {
    for (const raw of [null, 'text', 42, [ITEM]]) {
      const mapped = mapCalendarItem(raw)
      expect(mapped.entry).toBeNull()
      expect(mapped.incomplete).toBe(true)
      expect(hasCalendarWarning({ warnings: mapped.warnings }, CALENDAR_WARNING_CODES.UNREADABLE_ITEM))
        .toBe(true)
    }

    const noDate = mapCalendarItem({ workoutId: 42 })
    expect(noDate.entry).toBeNull()
    expect(noDate.incomplete).toBe(true)

    const badDate = mapCalendarItem({ scheduleDate: '2026-02-30', workoutId: 42 })
    expect(badDate.entry).toBeNull()
    expect(hasCalendarWarning(
      { warnings: badDate.warnings },
      CALENDAR_WARNING_CODES.ITEM_DATE_INVALID,
    )).toBe(true)

    const unknownKind = mapCalendarItem({ scheduleDate: '2026-09-10', somethingElse: true })
    expect(unknownKind.incomplete).toBe(true)
    expect(hasCalendarWarning(
      { warnings: unknownKind.warnings },
      CALENDAR_WARNING_CODES.UNKNOWN_ITEM_KIND,
    )).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3b. One whole envelope from the fixture, end to end
// ---------------------------------------------------------------------------

describe('synthetic provider envelope', () => {
  it('maps every item of a documented envelope without inventing one', async () => {
    const { adapter, requests } = adapterFor(() => SYNTHETIC_ENVELOPE)
    const snapshot = await adapter.getCalendarRange(range('2026-09-10', '2026-09-14'))

    expect(requests).toHaveLength(1)
    expect(requests[0].query).toBe(buildScheduleSummaryQuery('2026-09-09', '2026-09-15'))
    expect(snapshot.complete).toBe(true)
    expect(snapshot.missingRanges).toEqual([])
    expect(snapshot.entries.map((entry) => [
      entry.date,
      entry.kind,
      entry.workoutId,
      entry.workoutScheduleId,
    ])).toEqual([
      ['2026-09-10', 'workout', '1234567', '9001'],
      // A coach/plan item with no library id and no entry id is still an entry.
      ['2026-09-11', 'other', null, null],
      // A string id above Number.MAX_SAFE_INTEGER survives verbatim; a numeric
      // one would have been refused rather than rounded (see parseProviderId).
      ['2026-09-12', 'workout', '9007199254740993', null],
      ['2026-09-13', 'other', null, null],
      ['2026-09-14', 'workout', '4242', '9005'],
    ])

    expect(snapshot.entries[1]).toMatchObject({
      planName: '5K Training Plan',
      workoutUuid: '3f1c9e6a-1d2b-4c3d-8e4f-5a6b7c8d9e0f',
      sport: 'running',
      title: 'Base Run',
      restDay: false,
      race: false,
    })
    expect(snapshot.entries[3]).toMatchObject({
      restDay: true,
      race: false,
      title: null,
      sport: null,
      planName: null,
    })
    expect(snapshot.entries[4]).toMatchObject({
      race: true,
      restDay: false,
      sport: 'running',
      title: 'City Half Marathon',
    })

    // The only warning is the padding note: a rich item (plan, rest day, race,
    // unknown extra field) must not trip a fail-closed item warning.
    expect(snapshot.warnings).toHaveLength(1)
    expect(hasCalendarWarning(snapshot, CALENDAR_WARNING_CODES.BOUNDARY_PADDING_APPLIED)).toBe(true)
    for (const code of [
      CALENDAR_WARNING_CODES.UNREADABLE_ITEM,
      CALENDAR_WARNING_CODES.ITEM_DATE_INVALID,
      CALENDAR_WARNING_CODES.ITEM_ID_INVALID,
      CALENDAR_WARNING_CODES.ITEM_ID_CONFLICT,
      CALENDAR_WARNING_CODES.UNKNOWN_ITEM_KIND,
      CALENDAR_WARNING_CODES.UNMAPPED_ITEM_IDENTIFIER,
    ]) {
      expect(hasCalendarWarning(snapshot, code)).toBe(false)
    }
  })

  it('keeps only the entries inside the asked range, padding or not', async () => {
    const { adapter } = adapterFor(() => SYNTHETIC_ENVELOPE)
    const snapshot = await adapter.getCalendarRange(range('2026-09-11', '2026-09-12'))

    // The slice is probed a day wider on each side, and the provider hands back
    // entries outside the range; they are dropped, not reported.
    expect(snapshot.probedRange).toEqual(range('2026-09-10', '2026-09-13'))
    expect(snapshot.entries.map((entry) => entry.date)).toEqual(['2026-09-11', '2026-09-12'])
    expect(snapshot.complete).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4. Range reads
// ---------------------------------------------------------------------------

describe('calendar range read', () => {
  it('sends one padded query per month slice and keeps only in-range entries', async () => {
    const { adapter, requests } = adapterFor(sliceResponder({
      '2026-01-30': [
        { scheduleDate: '2026-01-30', workoutId: 1 }, // padding: before the range
        { scheduleDate: '2026-01-31', workoutId: 2 },
      ],
      '2026-01-31': [
        { scheduleDate: '2026-01-31', workoutId: 2 }, // overlap between slices
        { scheduleDate: '2026-02-01', workoutId: 3 },
        { scheduleDate: '2026-02-03', workoutId: 4 }, // padding: after the range
      ],
    }))

    const snapshot = await adapter.getCalendarRange(range('2026-01-31', '2026-02-02'))

    expect(requests.map((request) => request.query)).toEqual([
      buildScheduleSummaryQuery('2026-01-30', '2026-02-01'),
      buildScheduleSummaryQuery('2026-01-31', '2026-02-03'),
    ])
    expect(requests.every((request) => request.cursor === undefined)).toBe(true)
    expect(snapshot.range).toEqual(range('2026-01-31', '2026-02-02'))
    expect(snapshot.probedRange).toEqual(range('2026-01-30', '2026-02-03'))
    expect(snapshot.entries.map((entry) => [entry.date, entry.workoutId])).toEqual([
      ['2026-01-31', '2'],
      ['2026-02-01', '3'],
    ])
    expect(snapshot.complete).toBe(true)
    expect(snapshot.missingRanges).toEqual([])
    expect(snapshot.requestsIssued).toBe(2)
    expect(hasCalendarWarning(snapshot, CALENDAR_WARNING_CODES.BOUNDARY_PADDING_APPLIED)).toBe(true)
  })

  it('reads across a year boundary without losing or duplicating an entry', async () => {
    const { adapter, requests } = adapterFor(sliceResponder({
      '2025-12-29': [{ scheduleDate: '2025-12-31', workoutId: 10 }],
      '2025-12-31': [
        { scheduleDate: '2025-12-31', workoutId: 10 },
        { scheduleDate: '2026-01-01', workoutId: 11 },
      ],
    }))

    const snapshot = await adapter.getCalendarRange(range('2025-12-30', '2026-01-02'))
    expect(requests).toHaveLength(2)
    expect(snapshot.entries.map((entry) => entry.date)).toEqual(['2025-12-31', '2026-01-01'])
    expect(snapshot.complete).toBe(true)
  })

  it('keeps a leap day that only exists in the padded slice boundaries', async () => {
    const { adapter, requests } = adapterFor(sliceResponder({
      '2024-02-27': [{ scheduleDate: '2024-02-29', workoutId: 20 }],
      '2024-02-29': [],
    }))

    const snapshot = await adapter.getCalendarRange(range('2024-02-28', '2024-03-01'))
    expect(requests.map((request) => request.query)).toEqual([
      buildScheduleSummaryQuery('2024-02-27', '2024-03-01'),
      buildScheduleSummaryQuery('2024-02-29', '2024-03-02'),
    ])
    expect(snapshot.entries).toEqual([
      expect.objectContaining({ date: '2024-02-29', workoutId: '20' }),
    ])
  })

  it('reports an empty calendar day as a complete read, not as a failure', async () => {
    const { adapter } = adapterFor(() => ({ data: { workoutScheduleSummariesScalar: null } }))
    const snapshot = await adapter.getCalendarRange(range('2026-09-10', '2026-09-12'))
    expect(snapshot.entries).toEqual([])
    expect(snapshot.complete).toBe(true)
    expect(snapshot.missingRanges).toEqual([])
    expect(snapshot.requestsIssued).toBe(1)
    expect(hasCalendarWarning(snapshot, CALENDAR_WARNING_CODES.NULL_RESULT_TREATED_AS_EMPTY)).toBe(true)
  })

  it('echoes the timezone label and warns that it is not part of the protocol', async () => {
    const responder = () => ({ data: { workoutScheduleSummariesScalar: [] } })
    const utc = await adapterFor(responder).adapter
      .getCalendarRange(range('2026-09-10', '2026-09-12'))
    const { adapter, requests } = adapterFor(responder)
    const shanghai = await adapter.getCalendarRange(range('2026-09-10', '2026-09-12', 'Asia/Shanghai'))

    expect(hasCalendarWarning(utc, CALENDAR_WARNING_CODES.TIMEZONE_NOT_IN_VERIFIED_PROTOCOL)).toBe(false)
    expect(hasCalendarWarning(shanghai, CALENDAR_WARNING_CODES.TIMEZONE_NOT_IN_VERIFIED_PROTOCOL)).toBe(true)
    expect(shanghai.range.timezone).toBe('Asia/Shanghai')
    // The label never moves a date: the outgoing query is byte-identical.
    expect(requests[0].query).toBe(buildScheduleSummaryQuery('2026-09-09', '2026-09-13'))
  })

  it('stamps the snapshot from the injected clock', async () => {
    const { adapter } = adapterFor(
      () => ({ data: { workoutScheduleSummariesScalar: [] } }),
      { now: () => new Date('2026-09-11T00:00:00.000Z') },
    )
    const snapshot = await adapter.getCalendarRange(range('2026-09-10', '2026-09-12'))
    expect(snapshot.fetchedAt).toBe('2026-09-11T00:00:00.000Z')
  })

  it('reads a wholly past and a wholly future range, because the query has no clock', async () => {
    // The verified query carries two dates and nothing else: no "today", no
    // default window, no lower bound on the start date. A validator that
    // rejected the past (or the future) would refuse a valid recovery read, so
    // both directions are asserted against a frozen clock.
    const { adapter, requests } = adapterFor(
      () => ({ data: { workoutScheduleSummariesScalar: [] } }),
      { now: () => new Date('2026-09-11T00:00:00.000Z') },
    )

    const past = await adapter.getCalendarRange(range('2019-01-01', '2019-01-02'))
    const future = await adapter.getCalendarRange(range('2031-12-30', '2032-01-02'))

    expect(past.complete).toBe(true)
    expect(future.complete).toBe(true)
    expect(past.fetchedAt).toBe('2026-09-11T00:00:00.000Z')
    expect(future.fetchedAt).toBe('2026-09-11T00:00:00.000Z')
    expect(future.probedRange).toEqual(range('2031-12-29', '2032-01-03'))
    expect(requests.map((request) => request.query)).toEqual([
      buildScheduleSummaryQuery('2018-12-31', '2019-01-03'),
      buildScheduleSummaryQuery('2031-12-29', '2032-01-01'),
      buildScheduleSummaryQuery('2031-12-31', '2032-01-03'),
    ])
  })

  it('collapses a page the provider re-sends but keeps two separate entries', async () => {
    const { adapter } = adapterFor((_request, index) => index === 0
      ? {
        items: [
          { scheduleDate: '2026-09-10', workoutId: 7, workoutScheduleId: 100 },
          { scheduleDate: '2026-09-10', workoutId: 7, workoutScheduleId: 101 },
        ],
        nextCursor: 'page-2',
      }
      : { items: [{ scheduleDate: '2026-09-10', workoutId: 7, workoutScheduleId: 100 }] })

    const snapshot = await adapter.getCalendarRange(range('2026-09-10', '2026-09-10'))
    expect(snapshot.requestsIssued).toBe(2)
    expect(snapshot.entries.map((entry) => entry.workoutScheduleId)).toEqual(['100', '101'])
    expect(snapshot.complete).toBe(true)
  })

  it('follows a returned cursor and stops when the cursor repeats', async () => {
    const { adapter, requests } = adapterFor(() => ({
      items: [{ scheduleDate: '2026-09-10', workoutId: 7 }],
      nextCursor: 'same-cursor',
    }))

    const snapshot = await adapter.getCalendarRange(range('2026-09-10', '2026-09-10'))

    expect(requests[0].cursor).toBeUndefined()
    expect(requests[1].cursor).toBe('same-cursor')
    expect(snapshot.requestsIssued).toBe(2) // bounded: the loop stops itself
    expect(hasCalendarWarning(snapshot, CALENDAR_WARNING_CODES.CURSOR_LOOP_DETECTED)).toBe(true)
    expect(snapshot.entries).toHaveLength(1)
    expect(snapshot.complete).toBe(false)
    expect(snapshot.missingRanges).toEqual([{ startDate: '2026-09-10', endDate: '2026-09-10' }])
  })

  it('bounds the page loop even when every page returns a fresh cursor', async () => {
    const { adapter } = adapterFor(
      (_request, index) => ({
        items: [{ scheduleDate: '2026-09-10', workoutId: 100 + index }],
        nextCursor: `page-${index}`,
      }),
      { maxPagesPerChunk: 3 },
    )

    const snapshot = await adapter.getCalendarRange(range('2026-09-10', '2026-09-10'))
    expect(snapshot.requestsIssued).toBe(3)
    expect(hasCalendarWarning(snapshot, CALENDAR_WARNING_CODES.PAGE_LIMIT_EXCEEDED)).toBe(true)
    expect(snapshot.complete).toBe(false)
    expect(snapshot.missingRanges).toHaveLength(1)
  })

  it('marks a truncated page incomplete and records the unread slice', async () => {
    const { adapter } = adapterFor(() => ({
      items: [{ scheduleDate: '2026-09-10', workoutId: 7 }],
      truncated: true,
    }))

    const snapshot = await adapter.getCalendarRange(range('2026-09-10', '2026-09-12'))
    expect(hasCalendarWarning(snapshot, CALENDAR_WARNING_CODES.RESPONSE_TRUNCATED)).toBe(true)
    expect(snapshot.complete).toBe(false)
    expect(snapshot.missingRanges).toEqual([{ startDate: '2026-09-10', endDate: '2026-09-12' }])
  })

  it('keeps the slices it could read when a later slice fails', async () => {
    const { adapter, requests } = adapterFor((_request, index) => {
      if (index === 1) throw new Error('socket hang up')
      return { data: { workoutScheduleSummariesScalar: [{ scheduleDate: '2026-01-31', workoutId: 11 }] } }
    })

    const snapshot = await adapter.getCalendarRange(range('2026-01-31', '2026-02-02'))
    expect(requests).toHaveLength(2)
    expect(snapshot.entries.map((entry) => entry.date)).toEqual(['2026-01-31'])
    expect(snapshot.complete).toBe(false)
    expect(snapshot.missingRanges).toEqual([{ startDate: '2026-02-01', endDate: '2026-02-02' }])
    expect(hasCalendarWarning(snapshot, CALENDAR_WARNING_CODES.CHUNK_READ_FAILED)).toBe(true)
  })

  it('treats an unreadable response as a failed slice, never as no entries', async () => {
    const { adapter } = adapterFor(() => 42)
    const snapshot = await adapter.getCalendarRange(range('2026-09-10', '2026-09-12'))
    expect(snapshot.entries).toEqual([])
    expect(snapshot.complete).toBe(false)
    expect(hasCalendarWarning(snapshot, CALENDAR_WARNING_CODES.RESPONSE_UNREADABLE)).toBe(true)
    expect(hasCalendarWarning(snapshot, CALENDAR_WARNING_CODES.CHUNK_READ_FAILED)).toBe(true)
  })

  it('marks the whole snapshot incomplete when an item cannot be classified', async () => {
    const { adapter } = adapterFor(sliceResponder({
      '2026-09-09': [{ scheduleDate: '2026-09-10', somethingElse: true }],
    }))
    const snapshot = await adapter.getCalendarRange(range('2026-09-10', '2026-09-12'))
    expect(snapshot.complete).toBe(false)
    expect(hasCalendarWarning(snapshot, CALENDAR_WARNING_CODES.UNKNOWN_ITEM_KIND)).toBe(true)
    expect(snapshot.entries).toHaveLength(1) // retained, not dropped
  })

  it('reads nothing at all when the range needs more slices than the limit allows', async () => {
    const { adapter, requests } = adapterFor(
      () => ({ data: { workoutScheduleSummariesScalar: [] } }),
      { maxChunks: 2 },
    )

    const snapshot = await adapter.getCalendarRange(range('2026-01-01', '2026-12-31'))
    expect(requests).toHaveLength(0)
    expect(snapshot.requestsIssued).toBe(0)
    expect(snapshot.complete).toBe(false)
    expect(snapshot.missingRanges).toEqual([{ startDate: '2026-01-01', endDate: '2026-12-31' }])
    expect(snapshot.probedRange).toEqual(range('2026-01-01', '2026-12-31'))
    expect(hasCalendarWarning(snapshot, CALENDAR_WARNING_CODES.CHUNK_LIMIT_EXCEEDED)).toBe(true)
  })

  it('stops before collecting an unbounded number of entries', async () => {
    const items = [1, 2, 3, 4].map((id) => ({ scheduleDate: '2026-09-10', workoutId: id }))
    const { adapter } = adapterFor(
      () => ({ data: { workoutScheduleSummariesScalar: items } }),
      { maxItems: 2 },
    )

    const snapshot = await adapter.getCalendarRange(range('2026-09-10', '2026-09-12'))
    expect(snapshot.entries).toHaveLength(3) // the item that crossed the limit is kept
    expect(hasCalendarWarning(snapshot, CALENDAR_WARNING_CODES.ITEMS_LIMIT_EXCEEDED)).toBe(true)
    expect(snapshot.complete).toBe(false)
    expect(snapshot.missingRanges).toEqual([{ startDate: '2026-09-10', endDate: '2026-09-12' }])
  })

  it('accepts a 366-day range exactly at the limit', async () => {
    const { adapter, requests } = adapterFor(() => ({ data: { workoutScheduleSummariesScalar: [] } }))
    const snapshot = await adapter.getCalendarRange(range('2024-01-01', '2024-12-31'))
    expect(MAX_CALENDAR_RANGE_DAYS).toBe(366)
    expect(requests).toHaveLength(12)
    expect(snapshot.complete).toBe(true)
    expect(snapshot.requestsIssued).toBe(12)
    expect(requests[0].query).toBe(buildScheduleSummaryQuery('2023-12-31', '2024-02-01'))
    expect(requests[11].query).toBe(buildScheduleSummaryQuery('2024-11-30', '2025-01-01'))
  })

  it('refuses a 367-day range before sending anything', async () => {
    const { adapter, requests } = adapterFor(() => ({ data: { workoutScheduleSummariesScalar: [] } }))
    expect(calendarDayCount('2024-01-01', '2025-01-01')).toBe(367)
    await expect(adapter.getCalendarRange(range('2024-01-01', '2025-01-01')))
      .rejects.toMatchObject({ name: 'CalendarRangeError', code: 'CALENDAR_RANGE_TOO_LONG' })
    expect(requests).toHaveLength(0)
  })

  it('refuses a malformed range before sending anything', async () => {
    const { adapter, requests } = adapterFor(() => ({ data: { workoutScheduleSummariesScalar: [] } }))
    await expect(adapter.getCalendarRange(range('2026-09-12', '2026-09-10')))
      .rejects.toMatchObject({ code: 'CALENDAR_RANGE_INVALID' })
    await expect(adapter.getCalendarRange(range('2026-02-30', '2026-03-01')))
      .rejects.toMatchObject({ code: 'CALENDAR_RANGE_INVALID' })
    await expect(adapter.getCalendarRange(range('2026-09-10', '2026-09-12', '')))
      .rejects.toMatchObject({ code: 'CALENDAR_RANGE_INVALID' })
    await expect(adapter.getCalendarRange(undefined as unknown as CalendarRange))
      .rejects.toMatchObject({ code: 'CALENDAR_RANGE_INVALID' })
    expect(requests).toHaveLength(0)
  })

  it('merges adjacent unread slices into one missing range', async () => {
    const { adapter } = adapterFor(
      () => { throw new Error('offline') },
      { maxChunks: 14 },
    )
    const snapshot = await adapter.getCalendarRange(range('2026-01-31', '2026-03-02'))
    expect(snapshot.complete).toBe(false)
    expect(snapshot.missingRanges).toEqual([{ startDate: '2026-01-31', endDate: '2026-03-02' }])
    expect(snapshot.requestsIssued).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// 5. Query conclusion vs. write-attempt proof
// ---------------------------------------------------------------------------

async function completeSnapshot(
  items: unknown[],
  query: CalendarRange = range('2026-09-10', '2026-09-12'),
): Promise<CalendarSnapshot> {
  const { adapter } = adapterFor(() => ({ data: { workoutScheduleSummariesScalar: items } }))
  return adapter.getCalendarRange(query)
}

describe('query conclusion vs. write proof', () => {
  it('reports an observed target without claiming anything about a write', async () => {
    const snapshot = await completeSnapshot([
      { scheduleDate: '2026-09-11', workoutId: 42, workoutScheduleId: 9001 },
    ])
    const observation = observeCalendarTarget(snapshot, { workoutId: '42' })
    expect(observation.kind).toBe('observed_present')
    expect(observation.provesWriteDidNotHappen).toBe(false)
    if (observation.kind !== 'observed_present') throw new Error('unreachable')
    expect(observation.matches).toHaveLength(1)
    expect(observation.complete).toBe(true)

    const bySchedule = observeCalendarTarget(snapshot, { workoutScheduleId: '9001' })
    expect(bySchedule.kind).toBe('observed_present')
    expect(bySchedule.provesWriteDidNotHappen).toBe(false)

    const other = observeCalendarTarget(snapshot, { workoutId: '43' })
    expect(other.kind).toBe('not_observed_in_complete_range')
  })

  it('says only "not observed" for a complete read with no match', async () => {
    const snapshot = await completeSnapshot([{ scheduleDate: '2026-09-11', workoutId: 42 }])
    const observation = observeCalendarTarget(snapshot, { workoutId: '777' })
    expect(observation.kind).toBe('not_observed_in_complete_range')
    expect(observation.provesWriteDidNotHappen).toBe(false)
    if (observation.kind !== 'not_observed_in_complete_range') throw new Error('unreachable')
    expect(observation.range).toEqual(range('2026-09-10', '2026-09-12'))
    expect(observation.note).toContain('2026-09-10..2026-09-12')
  })

  it('says nothing at all when the read was incomplete', async () => {
    const { adapter } = adapterFor(() => { throw new Error('offline') })
    const snapshot = await adapter.getCalendarRange(range('2026-09-10', '2026-09-12'))
    expect(snapshot.complete).toBe(false)
    const observation = observeCalendarTarget(snapshot, { workoutId: '777' })
    expect(observation.kind).toBe('undetermined')
    expect(observation.provesWriteDidNotHappen).toBe(false)
    if (observation.kind !== 'undetermined') throw new Error('unreachable')
    expect(observation.reasons).toContain('INCOMPLETE_RANGE_READ')
  })

  it('cannot turn a schedule-id miss into absence, because that read is unverified', async () => {
    const snapshot = await completeSnapshot([{ scheduleDate: '2026-09-11', workoutId: 42 }])
    const observation = observeCalendarTarget(snapshot, { workoutScheduleId: '9001' })
    expect(observation.kind).toBe('undetermined')
    expect(observation.provesWriteDidNotHappen).toBe(false)
    if (observation.kind !== 'undetermined') throw new Error('unreachable')
    expect(observation.reasons).toContain('SCHEDULE_ID_LOOKUP_UNSUPPORTED')
  })

  it('every observation variant carries the literal false proof flag', async () => {
    const complete = await completeSnapshot([{ scheduleDate: '2026-09-11', workoutId: 42 }])
    const { adapter } = adapterFor(() => { throw new Error('offline') })
    const incomplete = await adapter.getCalendarRange(range('2026-09-10', '2026-09-12'))
    const observations = [
      observeCalendarTarget(complete, { workoutId: '42' }),
      observeCalendarTarget(complete, { workoutId: 'nope' }),
      observeCalendarTarget(complete, { workoutScheduleId: '9001' }),
      observeCalendarTarget(incomplete, { workoutId: '42' }),
    ]
    for (const observation of observations) {
      expect(observation.provesWriteDidNotHappen).toBe(false)
    }
  })

  it('demands exactly one target identifier', async () => {
    const snapshot = await completeSnapshot([])
    expect(() => observeCalendarTarget(snapshot, {}))
      .toThrow(CalendarTargetError)
    expect(() => observeCalendarTarget(snapshot, { workoutId: '42', workoutScheduleId: '9001' }))
      .toThrow(CalendarTargetError)
    expect(() => observeCalendarTarget(snapshot, { workoutId: '   ' }))
      .toThrow(CalendarTargetError)
    expect(() => observeCalendarTarget(snapshot, { workoutId: '42' })).not.toThrow()
  })

  it('derives a not-applied proof from attempt evidence, never from a snapshot', async () => {
    const snapshot = await completeSnapshot([])
    const proof = writeNotAppliedProof({
      operationId: 'op-1',
      stepId: 'step-1',
      attempt: 1,
      source: 'local_pre_dispatch_validation',
      detail: 'date failed local validation before dispatch',
    })
    expect(proof).toMatchObject({
      kind: 'not_applied',
      provesWriteDidNotHappen: true,
      source: 'local_pre_dispatch_validation',
      attempt: 1,
    })

    // A snapshot carries no proof field at all, and the proof constructor must
    // stay unreachable from it: if `WriteAttemptEvidence` ever became
    // assignable from `CalendarSnapshot`, "the range came back empty" could be
    // laundered into "the POST never happened".
    const snapshotHasNoProofFlag = !('provesWriteDidNotHappen' in snapshot)
    expect(snapshotHasNoProofFlag).toBe(true)
    const snapshotIsNotEvidence: CalendarSnapshot extends Parameters<typeof writeNotAppliedProof>[0]
      ? never
      : true = true
    expect(snapshotIsNotEvidence).toBe(true)
    // The observation flag must stay the literal `false`, not `boolean`.
    const observationFlagIsLiteral: boolean extends CalendarObservation['provesWriteDidNotHappen']
      ? never
      : true = true
    expect(observationFlagIsLiteral).toBe(true)
  })
})

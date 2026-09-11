import {
  CALENDAR_PROBE_ENV, CALENDAR_PROBE_RANGE, calendarProbeHint, integrationExitCode,
  runCalendarReadProbe, runReadOnlyChecks,
} from '../scripts/integration-test'
import { CalendarCapabilityError } from '../src/calendar/types'
import { CalendarRangeError } from '../src/index'

it('runs only public read methods and reports partial failures without sensitive errors', async () => {
  const service = {
    getActivities: jest.fn().mockResolvedValue([]),
    getSleep: jest.fn().mockRejectedValue(new Error('secret account response')),
    getSteps: jest.fn().mockResolvedValue([]),
    getHeartRate: jest.fn().mockResolvedValue([]),
    getWeight: jest.fn().mockResolvedValue([]),
    getWorkouts: jest.fn().mockResolvedValue([]),
    getProfile: jest.fn().mockResolvedValue({}),
    createWorkout: jest.fn(),
    scheduleWorkout: jest.fn(),
  }
  const report = jest.fn()
  expect(await runReadOnlyChecks(service, report)).toEqual({ passed: 6, failed: 1 })
  expect(report).toHaveBeenCalledTimes(7)
  expect(report).toHaveBeenCalledWith('sleep', false)
  expect(JSON.stringify(report.mock.calls)).not.toContain('secret account response')
  expect(service.createWorkout).not.toHaveBeenCalled()
  expect(service.scheduleWorkout).not.toHaveBeenCalled()
})

function calendarService(overrides: Record<string, unknown> = {}) {
  return {
    getCalendarRange: jest.fn().mockResolvedValue({
      range: { startDate: '2026-09-14', endDate: '2026-09-16' },
      probedRange: { startDate: '2026-09-13', endDate: '2026-09-17' },
      entries: [
        { date: '2026-09-14', workoutScheduleId: '1' },
        { date: '2026-09-16', workoutScheduleId: null },
      ],
      complete: true,
      requestsIssued: 1,
      missingRanges: [],
      warnings: ['[BOUNDARY_PADDING_APPLIED] padded'],
    }),
    createWorkout: jest.fn(),
    scheduleWorkout: jest.fn(),
    createAndScheduleWorkout: jest.fn(),
    unscheduleWorkout: jest.fn(),
    ...overrides,
  }
}

/** No probe outcome may ever cause a write, whichever path it took. */
function expectNoWrites(service: ReturnType<typeof calendarService>) {
  expect(service.createWorkout).not.toHaveBeenCalled()
  expect(service.scheduleWorkout).not.toHaveBeenCalled()
  expect(service.createAndScheduleWorkout).not.toHaveBeenCalled()
  expect(service.unscheduleWorkout).not.toHaveBeenCalled()
}

/**
 * Captures anything written outside the injected `report`.
 *
 * The probe hands its payloads to `report` so the caller controls them, but a
 * stray `console.error(rawValue)` would bypass that contract entirely and land
 * an account value in operator logs. Asserting only on `report` cannot see it.
 */
function captureProcessWrites() {
  const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true)
  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined)
  const error = jest.spyOn(console, 'error').mockImplementation(() => undefined)
  return {
    written: () => JSON.stringify(stdout.mock.calls) + JSON.stringify(stderr.mock.calls) +
      JSON.stringify(log.mock.calls) + JSON.stringify(error.mock.calls),
    restore: () => { stdout.mockRestore(); stderr.mockRestore(); log.mockRestore(); error.mockRestore() },
  }
}

describe('integrationExitCode', () => {
  it.each([
    [0, 'passed', 0],
    [0, 'skipped', 0],
    [0, 'failed', 1],
    [0, 'refused', 1],
    [1, 'passed', 1],
    [1, 'skipped', 1],
  ] as const)('read-only failures=%i, calendar=%s -> exit %i', (failed, calendar, expected) => {
    expect(integrationExitCode(failed, calendar)).toBe(expected)
  })

  it('treats skipped as a non-pass that still does not fail the command', () => {
    // Both halves matter: a skipped probe read nothing, so it must not fail a
    // run; and it must still be visible, which `calendarProbeHint` guarantees.
    expect(integrationExitCode(0, 'skipped')).toBe(0)
    expect(calendarProbeHint('skipped')).toContain(CALENDAR_PROBE_ENV)
  })
})

describe('calendarProbeHint', () => {
  it('explains a skip, a refusal, and stays silent on a pass or a failure', () => {
    expect(calendarProbeHint('skipped')).toContain('to read one range')
    expect(calendarProbeHint('refused')).toContain('nothing was sent')
    expect(calendarProbeHint('passed')).toBeNull()
    expect(calendarProbeHint('failed')).toBeNull()
  })
})

describe('CALENDAR_PROBE_RANGE', () => {
  it('accepts only a full inclusive date pair and captures both ends', () => {
    const match = CALENDAR_PROBE_RANGE.exec('2026-09-14..2026-09-16')
    expect(match?.slice(1)).toEqual(['2026-09-14', '2026-09-16'])
    expect(CALENDAR_PROBE_RANGE.test('2026-9-14..2026-09-16')).toBe(false)
    expect(CALENDAR_PROBE_RANGE.test(' 2026-09-14..2026-09-16')).toBe(false)
  })
})

it('skips the calendar probe and reads nothing when no range is authorised', async () => {
  const service = calendarService()
  const report = jest.fn()

  // An unset variable is "not authorised", never "the calendar is empty".
  expect(await runCalendarReadProbe(service, report, {})).toBe('skipped')
  expect(await runCalendarReadProbe(service, report, { [CALENDAR_PROBE_ENV]: '   ' })).toBe('skipped')

  expect(service.getCalendarRange).not.toHaveBeenCalled()
  expect(report).not.toHaveBeenCalled()
})

it('reads exactly the authorised range and reports the snapshot without writing', async () => {
  const service = calendarService()
  const report = jest.fn()

  const outcome = await runCalendarReadProbe(service, report, {
    [CALENDAR_PROBE_ENV]: '2026-09-14..2026-09-16',
  })

  expect(outcome).toBe('passed')
  expect(service.getCalendarRange).toHaveBeenCalledTimes(1)
  expect(service.getCalendarRange).toHaveBeenCalledWith({
    startDate: '2026-09-14', endDate: '2026-09-16',
  })
  const [, success, value] = report.mock.calls[0]
  expect(report).toHaveBeenCalledTimes(1)
  expect(report.mock.calls[0][0]).toBe('calendarRange')
  expect(success).toBe(true)
  // The two open §4.1 questions are reported as observations: whether the read
  // was complete, and whether a real entry ever omits the schedule id.
  expect(value).toMatchObject({
    complete: true, requestsIssued: 1, entries: 2, entryScheduleIds: ['1', null], readFailures: [],
  })
  expectNoWrites(service)
})

it.each([
  ['a bare date', '2026-09-14'],
  ['words', 'today..tomorrow'],
  ['three ends', '2026-09-14..2026-09-16..2026-09-18'],
  ['a day-first pair the format check cannot accept', '16-09-2026..14-09-2026'],
])('refuses %s as a probe range without reading, echoing or logging it', async (_label, value) => {
  const service = calendarService()
  const report = jest.fn()
  const captured = captureProcessWrites()
  try {
    expect(await runCalendarReadProbe(service, report, { [CALENDAR_PROBE_ENV]: value })).toBe('failed')
    // The operator's raw value must not reach stdout or stderr either: this
    // report path is shared with account responses, so a stray log would leak
    // whatever the operator pasted.
    expect(captured.written()).not.toContain(value)
  } finally {
    captured.restore()
  }

  expect(service.getCalendarRange).not.toHaveBeenCalled()
  expect(report).toHaveBeenCalledWith(
    expect.stringContaining('expected YYYY-MM-DD..YYYY-MM-DD'), false,
  )
  expect(JSON.stringify(report.mock.calls)).not.toContain(value)
})

it('reports a resolved-but-incomplete read as a failure, not a pass', async () => {
  // This is the shape a gateway 500 actually takes. The adapter does not reject
  // on a transport failure: it records `[CHUNK_READ_FAILED]` and resolves. A
  // probe keyed on "the call resolved" would report the one thing it exists to
  // rule out, so the warning codes are the verdict.
  const service = calendarService({
    getCalendarRange: jest.fn().mockResolvedValue({
      range: { startDate: '2026-09-14', endDate: '2026-09-16' },
      probedRange: { startDate: '2026-09-13', endDate: '2026-09-17' },
      entries: [],
      complete: false,
      requestsIssued: 1,
      missingRanges: [{ startDate: '2026-09-14', endDate: '2026-09-16' }],
      warnings: [
        '[BOUNDARY_PADDING_APPLIED] padded',
        '[CHUNK_READ_FAILED] transport query failed for 2026-09-14..2026-09-16',
      ],
    }),
  })
  const report = jest.fn()

  const outcome = await runCalendarReadProbe(service, report, {
    [CALENDAR_PROBE_ENV]: '2026-09-14..2026-09-16',
  })

  expect(outcome).toBe('failed')
  expect(integrationExitCode(0, outcome)).toBe(1)
  expect(report).toHaveBeenCalledTimes(1)
  expect(report.mock.calls[0][1]).toBe(false)
  expect(report.mock.calls[0][2]).toMatchObject({
    readFailures: ['[CHUNK_READ_FAILED] transport query failed for 2026-09-14..2026-09-16'],
  })
  expectNoWrites(service)
})

it('does not fail a read that resolved cleanly but could not understand an item', async () => {
  // `complete:false` alone is not a failed read: one unreadable item clears it
  // too, and that is an observation about the data. Keying the verdict on
  // `complete` would turn an ordinary data finding into a false alarm.
  const service = calendarService({
    getCalendarRange: jest.fn().mockResolvedValue({
      range: { startDate: '2026-09-14', endDate: '2026-09-16' },
      probedRange: { startDate: '2026-09-13', endDate: '2026-09-17' },
      entries: [],
      complete: false,
      requestsIssued: 1,
      missingRanges: [],
      warnings: [
        '[BOUNDARY_PADDING_APPLIED] padded',
        '[UNREADABLE_ITEM] entry 2 has no usable date',
      ],
    }),
  })
  const report = jest.fn()

  const outcome = await runCalendarReadProbe(service, report, {
    [CALENDAR_PROBE_ENV]: '2026-09-14..2026-09-16',
  })

  expect(outcome).toBe('passed')
  expect(report.mock.calls[0][1]).toBe(true)
  expect(report.mock.calls[0][2]).toMatchObject({ complete: false, readFailures: [] })
})

// The rejection below is a defensive shape rather than the one a real account
// produces: the adapter converts a transport failure into a resolved snapshot
// carrying a read-failure warning, and that reachable shape has its own test
// above. This case pins what happens if a read rejects anyway — reported as a
// failure, attempted once, and without echoing the rejection text anywhere.
it('reports a failed calendar read as a failure without leaking or retrying', async () => {
  const service = calendarService({
    getCalendarRange: jest.fn().mockRejectedValue(new Error('secret calendar response')),
  })
  const report = jest.fn()
  const captured = captureProcessWrites()
  try {
    const outcome = await runCalendarReadProbe(service, report, {
      [CALENDAR_PROBE_ENV]: '2026-09-14..2026-09-16',
    })
    expect(outcome).toBe('failed')
    expect(captured.written()).not.toContain('secret calendar response')
  } finally {
    captured.restore()
  }

  // Exactly one read: the failure path must not retry, and a retry would also
  // multiply whatever caused the failure against the live account.
  expect(service.getCalendarRange).toHaveBeenCalledTimes(1)
  expect(report).toHaveBeenCalledTimes(1)
  expect(report).toHaveBeenCalledWith('calendarRange', false)
  expectNoWrites(service)
})

it('reports a capability refusal as refused rather than as a failed read', async () => {
  // An unsupported region (or no calendar transport) is rejected before the
  // adapter builds a request, so nothing was sent. Calling that `failed` would
  // read as "the service refused", which is a different and unsupported claim.
  const service = calendarService({
    getCalendarRange: jest.fn().mockRejectedValue(
      new CalendarCapabilityError("Garmin Calendar range queries are not supported for region 'cn'"),
    ),
  })
  const report = jest.fn()

  const outcome = await runCalendarReadProbe(service, report, {
    [CALENDAR_PROBE_ENV]: '2026-09-14..2026-09-16',
  })

  expect(outcome).toBe('refused')
  expect(integrationExitCode(0, outcome)).toBe(1)
  expect(service.getCalendarRange).toHaveBeenCalledTimes(1)
  expect(report).toHaveBeenCalledTimes(1)
  expect(report.mock.calls[0][0]).toContain('not supported for this account or region')
  expect(report.mock.calls[0][1]).toBe(false)
  // The refusal text itself is not echoed: it is an account/region attribute.
  expect(JSON.stringify(report.mock.calls)).not.toContain("region 'cn'")
  expectNoWrites(service)
})

it('passes a format-valid but reversed range through verbatim instead of silently fixing it', async () => {
  // `2026-09-16..2026-09-14` satisfies the probe's format check, so only the
  // service decides it is invalid (`validateCalendarQuery`). The probe must not
  // sort the pair or swap the ends: rewriting the operator's range would read
  // back as evidence about a range nobody authorised.
  const service = calendarService({
    getCalendarRange: jest.fn().mockRejectedValue(
      new CalendarRangeError('CALENDAR_RANGE_INVALID', 'endDate is before startDate'),
    ),
  })
  const report = jest.fn()

  const outcome = await runCalendarReadProbe(service, report, {
    [CALENDAR_PROBE_ENV]: '2026-09-16..2026-09-14',
  })

  // A rejected *range* is a failed attempt, not a refusal: the service was
  // asked and answered about the operator's range.
  expect(outcome).toBe('failed')
  expect(integrationExitCode(0, outcome)).toBe(1)
  expect(service.getCalendarRange).toHaveBeenCalledWith({
    startDate: '2026-09-16', endDate: '2026-09-14',
  })
  expect(report).toHaveBeenCalledWith('calendarRange', false)
})

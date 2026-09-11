import {
  CALENDAR_PROBE_ENV, runCalendarReadProbe, runReadOnlyChecks,
} from '../scripts/integration-test'

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
    unscheduleWorkout: jest.fn(),
    ...overrides,
  }
}

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
    complete: true, requestsIssued: 1, entries: 2, entryScheduleIds: ['1', null],
  })
  expect(service.createWorkout).not.toHaveBeenCalled()
  expect(service.scheduleWorkout).not.toHaveBeenCalled()
  expect(service.unscheduleWorkout).not.toHaveBeenCalled()
})

it.each([
  ['a bare date', '2026-09-14'],
  ['words', 'today..tomorrow'],
  ['three ends', '2026-09-14..2026-09-16..2026-09-18'],
  ['a day-first pair the format check cannot accept', '16-09-2026..14-09-2026'],
])('refuses %s as a probe range without reading or echoing it', async (_label, value) => {
  const service = calendarService()
  const report = jest.fn()

  expect(await runCalendarReadProbe(service, report, { [CALENDAR_PROBE_ENV]: value })).toBe('failed')

  expect(service.getCalendarRange).not.toHaveBeenCalled()
  expect(report).toHaveBeenCalledWith(
    expect.stringContaining('expected YYYY-MM-DD..YYYY-MM-DD'), false,
  )
  expect(JSON.stringify(report.mock.calls)).not.toContain(value)
})

it('reports a failed calendar read as a failure without leaking the upstream text', async () => {
  const service = calendarService({
    getCalendarRange: jest.fn().mockRejectedValue(new Error('secret calendar response')),
  })
  const report = jest.fn()

  const outcome = await runCalendarReadProbe(service, report, {
    [CALENDAR_PROBE_ENV]: '2026-09-14..2026-09-16',
  })

  expect(outcome).toBe('failed')
  expect(report).toHaveBeenCalledTimes(1)
  expect(report).toHaveBeenCalledWith('calendarRange', false)
  expect(JSON.stringify(report.mock.calls)).not.toContain('secret calendar response')
  expect(service.scheduleWorkout).not.toHaveBeenCalled()
})

it('passes a format-valid but reversed range through verbatim instead of silently fixing it', async () => {
  // `2026-09-16..2026-09-14` satisfies the probe's format check, so only the
  // service decides it is invalid (`validateCalendarQuery`). The probe must not
  // sort the pair or swap the ends: rewriting the operator's range would read
  // back as evidence about a range nobody authorised.
  const service = calendarService({
    getCalendarRange: jest.fn().mockRejectedValue(new Error('Invalid date range: endDate is before startDate')),
  })
  const report = jest.fn()

  const outcome = await runCalendarReadProbe(service, report, {
    [CALENDAR_PROBE_ENV]: '2026-09-16..2026-09-14',
  })

  expect(outcome).toBe('failed')
  expect(service.getCalendarRange).toHaveBeenCalledWith({
    startDate: '2026-09-16', endDate: '2026-09-14',
  })
  expect(report).toHaveBeenCalledWith('calendarRange', false)
  expect(JSON.stringify(report.mock.calls)).not.toContain('endDate is before startDate')
})

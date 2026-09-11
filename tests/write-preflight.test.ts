/**
 * Fresh-preflight tests (C7).
 *
 * Before C7 an existing local receipt was the only thing standing between a
 * caller and a duplicate Garmin entry, and the receipt was treated as terminal:
 * once a schedule was `succeeded`, nothing could ever look at the calendar
 * again. That is wrong in both directions — it re-writes targets the user
 * already has, and it blocks a template/day forever after one manual deletion.
 *
 * The contract these tests pin down is asymmetric and role-separated:
 *
 *   - a *positive* match is usable even from an incomplete read (seeing the
 *     target proves it is there, and the answer is "do not write");
 *   - a *negative* is only usable from a **complete** read ("not seen" is never
 *     spent as "not there");
 *   - a read that cannot be taken at all blocks a *write* instead of being
 *     mistaken for an empty calendar;
 *   - the read only ever *shrinks* an approved write set. It can turn a write
 *     into a no-op, never the other way round, which is what lets an in-lock
 *     re-read run without a new approval.
 *
 * Nothing here is new behaviour layered on a fake: the reader is an interface
 * with no write method (`FakeCalendar implements CalendarLookup`), so a passing
 * test cannot be passing because the reader quietly sent something.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GarminToolService, type GarminDataClient } from '../src/tool-service'
import { FakeCalendar } from './fixtures/calendar/fake-calendar'

const TIMEZONE = 'Asia/Shanghai'
const DATE = '2026-09-15'
const WORKOUT = 'easy-42'

function freshState(): string {
  return mkdtempSync(join(tmpdir(), 'garmin-preflight-'))
}

interface Harness {
  service: GarminToolService
  calendar: FakeCalendar
  schedule: jest.Mock
  unschedule: jest.Mock
}

function harness(calendar = new FakeCalendar()): Harness {
  const schedule = jest.fn().mockResolvedValue({ workoutScheduleId: 'sid-1' })
  const unschedule = jest.fn().mockResolvedValue(undefined)
  const data: Partial<GarminDataClient> = {
    getWorkoutDetail: jest.fn().mockResolvedValue({ workoutId: WORKOUT, workoutName: 'Easy run' }),
    scheduleWorkout: schedule,
    unscheduleWorkout: unschedule,
    addWorkout: jest.fn().mockResolvedValue({ workoutId: 'created-1' }),
  }
  const service = new GarminToolService(data as GarminDataClient, {
    activityDetail: 'compact',
    fitDownloadDir: '',
    accountUsername: 'runner@example.test',
    accountRegion: 'global',
    stateDirectory: freshState(),
    calendarReader: calendar,
  })
  return { service, calendar, schedule, unschedule }
}

function request(over: Record<string, unknown> = {}) {
  return { workoutId: WORKOUT, date: DATE, timezone: TIMEZONE, ...over }
}

describe('fresh preflight before a new schedule', () => {
  it('previews a write when a complete read of the day shows nothing', async () => {
    const { service, calendar, schedule } = harness()

    const preview = await service.scheduleWorkout(request() as never)

    expect(preview).toMatchObject({ requiresConfirmation: true })
    expect(calendar.reads).toEqual([{ startDate: DATE, endDate: DATE, timezone: TIMEZONE }])
    expect(schedule).not.toHaveBeenCalled()
  })

  it('skips an entry the calendar already has, and removes nothing', async () => {
    const calendar = new FakeCalendar([
      { date: DATE, workoutId: WORKOUT, workoutScheduleId: 'existing-1' },
    ])
    const { service, schedule, unschedule } = harness(calendar)

    const preview = await service.scheduleWorkout(request() as never)

    expect(preview).toMatchObject({
      requiresConfirmation: false,
      action: 'skip_existing',
      success: true,
      desiredStateSatisfied: true,
      status: 'skipped',
      workoutScheduleId: 'existing-1',
    })
    expect(preview.message).toBe('The target is on the calendar now.')
    expect(schedule).not.toHaveBeenCalled()
    // "skip" is not "replace": the pre-existing entry is left alone.
    expect(unschedule).not.toHaveBeenCalled()
    expect(calendar.removeByScheduleId('existing-1')).toBe(1)
  })

  it('reports duplicate_existing when more than one entry matches, and deletes neither', async () => {
    const calendar = new FakeCalendar([
      { date: DATE, workoutId: WORKOUT, workoutScheduleId: 'existing-1' },
      { date: DATE, workoutId: WORKOUT, workoutScheduleId: 'existing-2' },
    ])
    const { service, schedule, unschedule } = harness(calendar)

    const preview = await service.scheduleWorkout(request() as never)

    expect(preview).toMatchObject({
      requiresConfirmation: false,
      action: 'duplicate_existing',
      success: false,
      errorCode: 'DUPLICATE_EXISTING',
    })
    expect(preview.message).toContain('2 matching calendar entries')
    expect(schedule).not.toHaveBeenCalled()
    expect(unschedule).not.toHaveBeenCalled()
  })

  it("honours duplicatePolicy:'error' by reporting a single existing entry as a conflict", async () => {
    const calendar = new FakeCalendar([
      { date: DATE, workoutId: WORKOUT, workoutScheduleId: 'existing-1' },
    ])
    const { service, schedule } = harness(calendar)

    const skipped = await service.scheduleWorkout(request() as never)
    expect(skipped).toMatchObject({ action: 'skip_existing', success: true })

    const refused = await service.scheduleWorkout(
      request({ duplicatePolicy: 'error' }) as never,
    )
    expect(refused).toMatchObject({
      requiresConfirmation: false,
      action: 'duplicate_existing',
      success: false,
      errorCode: 'DUPLICATE_EXISTING',
    })
    expect(schedule).not.toHaveBeenCalled()
  })

  it('blocks a new schedule when the account has no verified calendar read', async () => {
    const schedule = jest.fn()
    const data: Partial<GarminDataClient> = {
      getWorkoutDetail: jest.fn().mockResolvedValue({ workoutName: 'Easy run' }),
      scheduleWorkout: schedule,
      unscheduleWorkout: jest.fn(),
      addWorkout: jest.fn(),
      // No `getCalendarRange`, and no `calendarReader` option either.
    }
    const service = new GarminToolService(data as GarminDataClient, {
      activityDetail: 'compact',
      fitDownloadDir: '',
      accountUsername: 'runner@example.test',
      accountRegion: 'cn',
      stateDirectory: freshState(),
    })

    const preview = await service.scheduleWorkout(request() as never)

    expect(preview).toMatchObject({
      requiresConfirmation: false,
      action: 'blocked',
      success: false,
      errorCode: 'CALENDAR_QUERY_UNSUPPORTED',
    })
    // The refusal names its cause instead of quietly assuming empty days.
    expect(preview.message).toContain('an unread calendar is not an empty one')
    expect(schedule).not.toHaveBeenCalled()
  })

  it('blocks a write on an incomplete read but still accepts a positive sighting from one', async () => {
    const empty = harness()
    empty.calendar.setIncomplete({ startDate: DATE, endDate: DATE, timezone: TIMEZONE })

    const blocked = await empty.service.scheduleWorkout(request() as never)
    expect(blocked).toMatchObject({
      requiresConfirmation: false,
      action: 'blocked',
      errorCode: 'CALENDAR_INCOMPLETE',
    })
    expect(empty.schedule).not.toHaveBeenCalled()

    // Same incomplete read, but this time it *did* see the target. Seeing it is
    // proof it is there, so "do not write" is safe even without completeness.
    const seen = harness(new FakeCalendar([
      { date: DATE, workoutId: WORKOUT, workoutScheduleId: 'existing-1' },
    ]))
    seen.calendar.setIncomplete({ startDate: DATE, endDate: DATE, timezone: TIMEZONE })

    const skipped = await seen.service.scheduleWorkout(request() as never)
    expect(skipped).toMatchObject({ action: 'skip_existing', success: true })
    expect(seen.schedule).not.toHaveBeenCalled()
  })

  it('turns a confirmed write into a no-op when the entry appeared after the preview', async () => {
    const { service, calendar, schedule } = harness()
    const preview = await service.scheduleWorkout(request() as never)
    expect(preview.requiresConfirmation).toBe(true)

    // The user scheduled the same workout by hand between preview and confirm.
    calendar.add({ date: DATE, workoutId: WORKOUT, workoutScheduleId: 'added-by-hand' })

    const receipt = await service.scheduleWorkout({
      ...request(),
      confirmed: true,
      confirmationId: preview.confirmationId,
    } as never)

    // The state the caller asked for already holds, so this is a success that
    // did *less* than what was approved - not a failure.
    expect(receipt).toMatchObject({
      success: true,
      status: 'skipped',
      evidence: 'observed_present',
      desiredStateSatisfied: true,
      workoutScheduleId: 'added-by-hand',
      manualReviewRequired: false,
    })
    // Fewer side effects than were approved — never more.
    expect(schedule).not.toHaveBeenCalled()
  })

  it('invalidates a calendar-derived skip whose entry was deleted before the confirm', async () => {
    const calendar = new FakeCalendar([
      { date: DATE, workoutId: WORKOUT, workoutScheduleId: 'existing-1' },
    ])
    const { service, schedule } = harness(calendar)
    const preview = await service.scheduleWorkout(request() as never)
    expect(preview).toMatchObject({ requiresConfirmation: false, action: 'skip_existing' })

    // Honouring "do not write" is safe, but the *reason* has expired: a later
    // confirm must not silently post the write the caller was told was skipped.
    calendar.removeByWorkoutAndDate(WORKOUT, DATE)
    const again = await service.scheduleWorkout(request() as never)
    expect(again.requiresConfirmation).toBe(true)
    expect(schedule).not.toHaveBeenCalled()
  })

  it('reads freshly for every preview instead of reusing the previous answer', async () => {
    const { service, calendar, schedule } = harness()

    const first = await service.scheduleWorkout(request() as never)
    calendar.add({ date: DATE, workoutId: WORKOUT, workoutScheduleId: 'added-later' })
    const second = await service.scheduleWorkout(request() as never)

    expect(first.requiresConfirmation).toBe(true)
    expect(second).toMatchObject({ requiresConfirmation: false, action: 'skip_existing' })
    expect(calendar.reads).toHaveLength(2)
    expect(schedule).not.toHaveBeenCalled()
  })

  it('refuses the whole batch read when the day cannot be read, arming nothing', async () => {
    const calendar = new FakeCalendar()
    calendar.setIncomplete({
      startDate: '2026-09-15',
      endDate: '2026-09-21',
      timezone: TIMEZONE,
    })
    const { service, schedule } = harness(calendar)

    const preview = await service.batchScheduleWorkouts({
      timezone: TIMEZONE,
      schedules: [
        { workoutId: 'a', date: '2026-09-15' },
        { workoutId: 'b', date: '2026-09-17' },
      ],
    } as never)

    expect(preview).toMatchObject({ requiresConfirmation: false, success: false })
    // A batch that arms nothing reports the per-entry verdicts, so the caller
    // can see *which* day could not be read rather than a bare refusal.
    expect((preview.steps as Array<{ action: string; errorCode?: string }>))
      .toMatchObject([
        { action: 'blocked', errorCode: 'CALENDAR_INCOMPLETE' },
        { action: 'blocked', errorCode: 'CALENDAR_INCOMPLETE' },
      ])
    expect(schedule).not.toHaveBeenCalled()
  })
})

describe('confirmed dispatch is re-read inside the lock', () => {
  it('does not post when the entry is added between preview and confirm, twice over', async () => {
    const { service, calendar, schedule } = harness()
    const preview = await service.scheduleWorkout(request() as never)

    // Two reads happened before any POST could: the preview's, and the one the
    // confirmation takes inside the lock.
    calendar.add({ date: DATE, workoutId: WORKOUT, workoutScheduleId: 'added-by-hand' })
    const receipt = await service.scheduleWorkout({
      ...request(),
      confirmed: true,
      confirmationId: preview.confirmationId,
    } as never)

    expect(receipt).toMatchObject({ status: 'skipped', evidence: 'observed_present' })
    expect(calendar.reads).toHaveLength(2)
    expect(schedule).not.toHaveBeenCalled()
  })

  it('reports a read failure at confirm time as an un-attempted step, not a success', async () => {
    const { service, calendar, schedule } = harness()
    const preview = await service.scheduleWorkout(request() as never)

    calendar.fail(new Error('calendar gateway 503'))
    const receipt = await service.scheduleWorkout({
      ...request(),
      confirmed: true,
      confirmationId: preview.confirmationId,
    } as never)
    calendar.reset()

    expect(receipt).toMatchObject({
      success: false,
      status: 'not_attempted',
      errorCode: 'CALENDAR_INCOMPLETE',
      manualReviewRequired: false,
    })
    expect(schedule).not.toHaveBeenCalled()
  })

  it('keeps an approved duplicatePolicy with the revision that approved it', async () => {
    const calendar = new FakeCalendar()
    const { service, schedule } = harness(calendar)
    const preview = await service.scheduleWorkout(
      request({ duplicatePolicy: 'error' }) as never,
    )
    expect(preview.requiresConfirmation).toBe(true)

    calendar.add({ date: DATE, workoutId: WORKOUT, workoutScheduleId: 'appeared' })
    const receipt = await service.scheduleWorkout({
      ...request(),
      duplicatePolicy: 'error',
      confirmed: true,
      confirmationId: preview.confirmationId,
    } as never)

    // The policy is part of the approval, so the dispatch reports the entry the
    // same way the preview would have: as a conflict, not as a silent skip.
    expect(receipt).toMatchObject({
      success: false,
      status: 'not_attempted',
      errorCode: 'DUPLICATE_EXISTING',
    })
    expect(schedule).not.toHaveBeenCalled()
  })
})

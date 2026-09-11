import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GarminToolService, type GarminDataClient } from '../src/tool-service'
import { PublicToolError } from '../src/utils/errors'
import { FakeCalendar } from './fixtures/calendar/fake-calendar'

function fixture() {
  const data = {
    getWorkoutDetail: jest.fn().mockResolvedValue({ workoutName: 'Easy run' }),
    scheduleWorkout: jest.fn().mockResolvedValue({ workoutScheduleId: '42' }),
    unscheduleWorkout: jest.fn().mockResolvedValue(undefined),
    addWorkout: jest.fn().mockResolvedValue({ workoutId: 'new-42' }),
  }
  const service = new GarminToolService(data as unknown as GarminDataClient, {
    activityDetail: 'compact', fitDownloadDir: '', accountUsername: 'runner@example.test', accountRegion: 'cn',
    // Each fixture gets a private journal: write records intentionally outlive
    // a single service instance, so a shared directory would leak across tests.
    stateDirectory: mkdtempSync(join(tmpdir(), 'garmin-calendar-regression-')),
    // C7 precondition: a new schedule is only previewed against a calendar that
    // can actually be read. These boundaries are about scheduling, so the
    // account is stated to be readable and its days to be empty — an unreadable
    // calendar would block instead, which `write-preflight.test.ts` covers.
    calendarReader: new FakeCalendar(),
  })
  return { data, service }
}
const request = { workoutId: '42', date: '2026-09-15', timezone: 'Asia/Shanghai' }
const workout = { name: 'Easy', steps: [{ type: 'interval' as const, endCondition: 'time' as const, endValue: 600 }] }

describe('Calendar compatibility and failure boundaries', () => {
  beforeEach(() => jest.useFakeTimers({ now: new Date('2026-09-10T12:00:00Z') }))
  afterEach(() => jest.useRealTimers())

  it.each([
    { date: '2026-02-30' }, { date: '2026-9-15' }, { date: '2026-09-09' },
    { timezone: 'Mars/Olympus' }, { workoutId: '' }, { workoutId: 'x'.repeat(129) },
  ])('rejects invalid input before reaching Garmin: %j', async invalid => {
    const { data, service } = fixture()
    await expect(service.scheduleWorkout({ ...request, ...invalid })).rejects.toThrow()
    expect(data.getWorkoutDetail).not.toHaveBeenCalled()
    expect(data.scheduleWorkout).not.toHaveBeenCalled()
  })

  it('uses the chosen timezone at a UTC day boundary and preserves local dates', async () => {
    jest.setSystemTime(new Date('2026-09-10T16:30:00Z'))
    const { data, service } = fixture()
    await expect(service.scheduleWorkout({ ...request, date: '2026-09-10' })).rejects.toThrow('Invalid date')
    const local = { ...request, date: '2026-09-10', timezone: 'America/Los_Angeles' }
    const preview = await service.scheduleWorkout(local)
    await service.scheduleWorkout({ ...local, confirmed: true, confirmationId: preview.confirmationId as string })
    expect(data.scheduleWorkout).toHaveBeenCalledWith('42', '2026-09-10')
  })

  it('fails preview for an unavailable workout without issuing any write', async () => {
    const { data, service } = fixture()
    data.getWorkoutDetail.mockRejectedValue(new PublicToolError('Workout not found'))
    await expect(service.scheduleWorkout(request)).rejects.toThrow('Workout not found')
    expect(data.scheduleWorkout).not.toHaveBeenCalled()
  })

  it('requires a preview from the same service and binds its date and operation', async () => {
    const { data, service } = fixture()
    // Confirmed=true with no prior preview must fail without dispatching.
    await expect(service.scheduleWorkout({ ...request, confirmed: true })).rejects.toThrow()
    const preview = await service.scheduleWorkout(request)
    // The schedule preview's operationId cannot authorize an unschedule:
    // the business keys are different.
    await expect(service.unscheduleWorkout({
      workoutScheduleId: '42', confirmed: true, confirmationId: preview.confirmationId as string,
    })).rejects.toThrow()
    // A schedule operationId cannot be reused with a different date.
    const otherPreview = await service.scheduleWorkout(request)
    await expect(service.scheduleWorkout({ ...request, date: '2026-09-16', confirmed: true,
      confirmationId: otherPreview.confirmationId as string })).rejects.toThrow()
    expect(data.scheduleWorkout).not.toHaveBeenCalled()
    expect(data.unscheduleWorkout).not.toHaveBeenCalled()
  })

  it('expires Calendar confirmations after ten minutes', async () => {
    const { data, service } = fixture()
    const preview = await service.scheduleWorkout(request)
    jest.advanceTimersByTime(600000)
    // The stale approval is refused rather than silently honoured. Because
    // nothing was dispatched the step is *proven* not applied, so it is
    // reported as `not_attempted` together with the durable operationId a
    // later resume can address — a bare throw would lose that handle.
    expect(await service.scheduleWorkout({ ...request, confirmed: true,
      confirmationId: preview.confirmationId as string })).toMatchObject({
      success: false,
      status: 'not_attempted',
      desiredStateSatisfied: false,
      errorCode: 'CONFIRMATION_STALE',
      operationId: expect.any(String),
    })
    expect(data.scheduleWorkout).not.toHaveBeenCalled()
  })

  it('does not retry an uncertain write and returns its durable receipt instead', async () => {
    const { data, service } = fixture()
    data.scheduleWorkout.mockRejectedValue(new PublicToolError('Outcome unknown; inspect Garmin Calendar'))
    const preview = await service.scheduleWorkout(request)
    const confirmed = { ...request, confirmed: true, confirmationId: preview.confirmationId as string }
    // The uncertain outcome is now a durable receipt rather than a bare failure.
    expect(await service.scheduleWorkout(confirmed)).toMatchObject({
      success: false,
      status: 'unknown',
      evidence: 'none',
      desiredStateSatisfied: false,
      manualReviewRequired: true,
      errorCode: 'WRITE_OUTCOME_UNKNOWN',
      nextAction: 'reconcile_garmin_write_operation',
      operationId: expect.any(String),
    })
    // Re-confirming the same handle is a journal read, not a second POST: the
    // unresolved step can never mint new write authority.
    expect(await service.scheduleWorkout(confirmed)).toMatchObject({
      success: false, status: 'unknown', manualReviewRequired: true,
    })
    expect(data.scheduleWorkout).toHaveBeenCalledTimes(1)
  })

  it('schedules five entries across weeks without creating rest-day templates', async () => {
    const { data, service } = fixture()
    const batch = { timezone: 'Asia/Shanghai', schedules: [
      { workoutId: 'easy', date: '2026-09-14' }, { workoutId: 'hard', date: '2026-09-15' },
      { workoutId: 'easy', date: '2026-09-17' }, { workoutId: 'easy', date: '2026-09-21' },
      { workoutId: 'long', date: '2026-09-27' },
    ] }
    const preview = await service.batchScheduleWorkouts(batch)
    expect(data.getWorkoutDetail).toHaveBeenCalledTimes(3)
    expect(data.scheduleWorkout).not.toHaveBeenCalled()
    const result = await service.batchScheduleWorkouts({ ...batch, confirmed: true,
      confirmationId: preview.confirmationId as string })
    expect(result).toMatchObject({ successCount: 5, failureCount: 0 })
    expect(data.addWorkout).not.toHaveBeenCalled()
    expect(data.scheduleWorkout.mock.calls).toEqual(batch.schedules.map(entry => [entry.workoutId, entry.date]))
    // A re-confirm of the same handle replays the durable batch receipt; it
    // must not dispatch a sixth POST.
    expect(await service.batchScheduleWorkouts({ ...batch, confirmed: true,
      confirmationId: preview.confirmationId as string })).toMatchObject({
      total: 5, successCount: 5, failureCount: 0, unknownCount: 0, notAttemptedCount: 0,
    })
    expect(data.scheduleWorkout).toHaveBeenCalledTimes(5)
  })

  it('rejects empty and oversized batches', async () => {
    const { service } = fixture()
    await expect(service.batchScheduleWorkouts({ schedules: [] })).rejects.toThrow('Invalid schedules')
    await expect(service.batchScheduleWorkouts({ schedules: Array(101).fill(request) })).rejects.toThrow('Invalid schedules')
  })

  it('retains a created template when scheduling fails and cannot blindly recreate it', async () => {
    const { data, service } = fixture()
    data.scheduleWorkout.mockRejectedValue(new Error('upstream timeout'))
    const create = { date: request.date, timezone: request.timezone, workout }
    const preview = await service.createAndScheduleWorkout(create)
    const confirmed = { ...create, confirmed: true, confirmationId: preview.confirmationId as string }
    expect(await service.createAndScheduleWorkout(confirmed)).toMatchObject({
      success: false, workoutCreated: true, workoutId: 'new-42',
    })
    // The template is retained, the retained id is reported, and a re-confirm
    // replays that receipt instead of re-creating anything.
    expect(await service.createAndScheduleWorkout(confirmed)).toMatchObject({
      success: false, workoutCreated: true, workoutId: 'new-42', status: 'unknown',
    })
    expect(data.addWorkout).toHaveBeenCalledTimes(1)
  })

  it('does not invent a missing template ID or schedule ID', async () => {
    const { data, service } = fixture()
    data.addWorkout.mockResolvedValue({})
    const create = { date: request.date, workout }
    const preview = await service.createAndScheduleWorkout(create)
    expect(await service.createAndScheduleWorkout({ ...create, confirmed: true,
      confirmationId: preview.confirmationId as string })).toMatchObject({ success: false, workoutCreated: true })
    expect(data.scheduleWorkout).not.toHaveBeenCalled()
    data.scheduleWorkout.mockResolvedValue({})
    const schedulePreview = await service.scheduleWorkout(request)
    expect(await service.scheduleWorkout({ ...request, confirmed: true,
      confirmationId: schedulePreview.confirmationId as string })).toMatchObject({ workoutScheduleId: null })
  })
})

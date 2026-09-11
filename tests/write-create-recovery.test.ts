/**
 * Create / schedule / unschedule recovery tests (C5).
 *
 * User requirement: "让每次 addWorkout 返回不同 ID；验证重复请求和重启后
 * 不会重复创建模板或重复排期。"
 *
 * The mock service returns a FRESH workoutId on every addWorkout call. The
 * coordinator's job is to ensure the call is only made ONCE per unique
 * workout-definition, even across:
 *   - re-calls in the same service instance
 *   - a process restart (re-instantiating the service with the same
 *     on-disk state)
 *   - the create+schedule combo path
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GarminToolService, type GarminDataClient } from '../src/tool-service'

const TIMEZONE = 'Asia/Shanghai'

function freshState(): string {
  return mkdtempSync(join(tmpdir(), 'garmin-c5-'))
}

interface CallCounter {
  addWorkout: jest.Mock
  scheduleWorkout: jest.Mock
  unscheduleWorkout: jest.Mock
  /** Returns a fresh workoutId on every addWorkout call. */
  nextWorkoutId: () => string
}

function makeData(initialWorkoutId = 0): CallCounter {
  let counter = initialWorkoutId
  const addWorkout = jest.fn(async (workout: { name: string }) => {
    counter += 1
    return { workoutId: `w-${counter}`, workoutName: workout.name }
  })
  const scheduleWorkout = jest.fn(async (workoutId: string, date: string) => {
    return { workoutScheduleId: `sid-${workoutId}-${date}` }
  })
  const unscheduleWorkout = jest.fn(async () => undefined)
  return {
    addWorkout, scheduleWorkout, unscheduleWorkout,
    nextWorkoutId: () => `w-${counter + 1}`,
  }
}

function makeService(stateDirectory: string, counters: CallCounter) {
  const data: Partial<GarminDataClient> = {
    getWorkoutDetail: jest.fn().mockResolvedValue({ workoutName: 'Easy run' }),
    addWorkout: counters.addWorkout,
    scheduleWorkout: counters.scheduleWorkout,
    unscheduleWorkout: counters.unscheduleWorkout,
  }
  const service = new GarminToolService(data as GarminDataClient, {
    activityDetail: 'compact',
    fitDownloadDir: '',
    accountUsername: 'runner@example.test',
    accountRegion: 'cn',
    stateDirectory,
  })
  return { service, data }
}

const definition = {
  name: 'Easy 5 km',
  steps: [{ type: 'interval' as const, endCondition: 'distance' as const, endValue: 5000 }],
}

describe('C5: create dedupes across re-calls and restarts', () => {
  it('re-calling createWorkout with the same definition in the same service only fires addWorkout once', async () => {
    const state = freshState()
    const counters = makeData()
    const { service } = makeService(state, counters)

    const preview = await service.createWorkout(definition)
    expect(preview).toMatchObject({ requiresConfirmation: true })
    const first = await service.createWorkout({
      ...definition,
      confirmed: true,
      confirmationId: (preview as { confirmationId: string }).confirmationId,
    })
    expect(first).toMatchObject({ success: true })
    const firstId = (first as { workoutId: string }).workoutId

    // 5 more replay attempts (with the same confirmationId as the durable receipt).
    for (let i = 0; i < 5; i++) {
      const replay = await service.createWorkout({
        ...definition,
        confirmed: true,
        confirmationId: (preview as { confirmationId: string }).confirmationId,
      })
      expect(replay).toMatchObject({ success: true, workoutId: firstId })
    }
    expect(counters.addWorkout).toHaveBeenCalledTimes(1)
  })

  it('restart: a fresh service reading the same state never re-dispatches addWorkout', async () => {
    const state = freshState()
    const counters = makeData()
    const { service: svc1 } = makeService(state, counters)

    const preview = await svc1.createWorkout(definition)
    const first = await svc1.createWorkout({
      ...definition,
      confirmed: true,
      confirmationId: (preview as { confirmationId: string }).confirmationId,
    })
    expect(first).toMatchObject({ success: true })
    expect(counters.addWorkout).toHaveBeenCalledTimes(1)
    const firstId = (first as { workoutId: string }).workoutId

    // Simulate a process restart: new service instance, same on-disk state.
    // The mock data and counters are FRESH — addWorkout would return a
    // different id if it ever got called.
    const counters2 = makeData()
    const { service: svc2 } = makeService(state, counters2)
    const replay = await svc2.createWorkout({
      ...definition,
      confirmed: true,
      confirmationId: (preview as { confirmationId: string }).confirmationId,
    })
    expect(replay).toMatchObject({ success: true, workoutId: firstId })
    expect(counters2.addWorkout).not.toHaveBeenCalled()
  })

  it('schedule dedupes across re-calls and restarts (the unscheduled workoutId is never re-dispatched)', async () => {
    const state = freshState()
    const counters = makeData()
    const { service: svc1 } = makeService(state, counters)

    // Create the workout first.
    const createPreview = await svc1.createWorkout(definition)
    const createResult = await svc1.createWorkout({
      ...definition,
      confirmed: true,
      confirmationId: (createPreview as { confirmationId: string }).confirmationId,
    })
    expect(createResult).toMatchObject({ success: true })
    const workoutId = (createResult as { workoutId: string }).workoutId

    // Schedule it 3 times (same workoutId, same date).
    const schedArgs = { workoutId, date: '2026-09-30', timezone: TIMEZONE }
    const sp1 = await svc1.scheduleWorkout(schedArgs as never)
    const sr1 = await svc1.scheduleWorkout({
      ...(schedArgs as Record<string, unknown>),
      confirmed: true,
      confirmationId: (sp1 as { confirmationId: string }).confirmationId,
    } as never)
    expect(sr1).toMatchObject({ success: true })
    for (let i = 0; i < 3; i++) {
      const replay = await svc1.scheduleWorkout({
        ...(schedArgs as Record<string, unknown>),
        confirmed: true,
        confirmationId: (sp1 as { confirmationId: string }).confirmationId,
      } as never)
      expect(replay).toMatchObject({ success: true })
    }
    expect(counters.scheduleWorkout).toHaveBeenCalledTimes(1)

    // Restart: scheduleWorkout on a fresh service must still be a no-op.
    const counters2 = makeData()
    const { service: svc2 } = makeService(state, counters2)
    const replay = await svc2.scheduleWorkout({
      ...(schedArgs as Record<string, unknown>),
      confirmed: true,
      confirmationId: (sp1 as { confirmationId: string }).confirmationId,
    } as never)
    expect(replay).toMatchObject({ success: true })
    expect(counters2.scheduleWorkout).not.toHaveBeenCalled()
  })

  it('createAndSchedule does not re-create the template after a successful first call', async () => {
    const state = freshState()
    const counters = makeData()
    const { service: svc1 } = makeService(state, counters)
    const args = { workout: definition, date: '2026-10-01', timezone: TIMEZONE }
    const preview = await svc1.createAndScheduleWorkout(args as never)
    expect(preview).toMatchObject({ requiresConfirmation: true })
    const first = await svc1.createAndScheduleWorkout({
      ...(args as Record<string, unknown>),
      confirmed: true,
      confirmationId: (preview as { confirmationId: string }).confirmationId,
    } as never)
    expect(first).toMatchObject({ success: true })
    expect(counters.addWorkout).toHaveBeenCalledTimes(1)
    expect(counters.scheduleWorkout).toHaveBeenCalledTimes(1)

    const createdId = (first as { workoutId: string }).workoutId

    // Both phases are now satisfied in the journal, so a re-preview reports
    // the durable receipts instead of minting a confirmation. It must not
    // offer to create the template a second time.
    const preview2 = await svc1.createAndScheduleWorkout(args as never)
    expect(preview2).toMatchObject({
      requiresConfirmation: false,
      alreadyCreated: true,
      alreadyScheduled: true,
      workoutId: createdId,
    })

    // A confirmed replay through the durable confirmationId is also a no-op:
    // the create phase resolves to the persisted workout id, and neither
    // client method is called again.
    const second = await svc1.createAndScheduleWorkout({
      ...(args as Record<string, unknown>),
      confirmed: true,
      confirmationId: (preview as { confirmationId: string }).confirmationId,
    } as never)
    expect(second).toMatchObject({ success: true, workoutId: createdId })
    expect(counters.addWorkout).toHaveBeenCalledTimes(1) // still 1
    expect(counters.scheduleWorkout).toHaveBeenCalledTimes(1) // still 1
  })

  it('unschedule is journaled; a restart does not re-dispatch the unschedule', async () => {
    const state = freshState()
    const counters = makeData()
    const { service: svc1 } = makeService(state, counters)
    // Create + schedule first.
    const createPreview = await svc1.createWorkout(definition)
    const createResult = await svc1.createWorkout({
      ...definition,
      confirmed: true,
      confirmationId: (createPreview as { confirmationId: string }).confirmationId,
    })
    // Read the id from the awaited tool result, not from the mock's promise
    // slot: the client mock is async, so `mock.results[0].value` is a Promise.
    const workoutId = (createResult as { workoutId: string }).workoutId
    expect(workoutId).toMatch(/^w-\d+$/)
    const sp = await svc1.scheduleWorkout({ workoutId, date: '2026-09-30', timezone: TIMEZONE } as never)
    const scheduleResult = await svc1.scheduleWorkout({
      workoutId, date: '2026-09-30', timezone: TIMEZONE,
      confirmed: true,
      confirmationId: (sp as { confirmationId: string }).confirmationId,
    } as never)
    const scheduleId = (scheduleResult as { workoutScheduleId: string }).workoutScheduleId
    expect(scheduleId).toMatch(/^sid-/)

    // Unschedule.
    const up = await svc1.unscheduleWorkout({ workoutScheduleId: scheduleId } as never)
    await svc1.unscheduleWorkout({
      workoutScheduleId: scheduleId,
      confirmed: true,
      confirmationId: (up as { confirmationId: string }).confirmationId,
    } as never)
    expect(counters.unscheduleWorkout).toHaveBeenCalledTimes(1)

    // Restart: re-confirming the same unschedule is a no-op.
    const counters2 = makeData()
    const { service: svc2 } = makeService(state, counters2)
    const replay = await svc2.unscheduleWorkout({
      workoutScheduleId: scheduleId,
      confirmed: true,
      confirmationId: (up as { confirmationId: string }).confirmationId,
    } as never)
    expect(replay).toMatchObject({ success: true })
    expect(counters2.unscheduleWorkout).not.toHaveBeenCalled()
  })
})

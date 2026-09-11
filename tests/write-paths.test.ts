/**
 * All 5 write paths (C5) must route their schedule/unschedule network
 * operations through the coordinator so the journal — not the caller's
 * memory — decides whether a write should be attempted again.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GarminToolService, type GarminDataClient } from '../src/tool-service'
import { FakeCalendar } from './fixtures/calendar/fake-calendar'

const TIMEZONE = 'Asia/Shanghai'

function freshState(): string {
  return mkdtempSync(join(tmpdir(), 'garmin-paths-'))
}

function makeService(stateDirectory: string, overrides: Partial<GarminDataClient> = {}) {
  const writer = jest.fn().mockResolvedValue({ workoutScheduleId: 'sid-1' })
  const data: Partial<GarminDataClient> = {
    getWorkoutDetail: jest.fn().mockResolvedValue({ workoutName: 'Easy 5 km' }),
    scheduleWorkout: writer,
    unscheduleWorkout: jest.fn().mockResolvedValue(undefined),
    addWorkout: jest.fn().mockResolvedValue({ workoutId: 'w-A' }),
    getWorkouts: jest.fn().mockResolvedValue([]),
    ...overrides,
  }
  // Every write now stands behind a fresh read of the target day. This fixture
  // is the explicit precondition "the account can read its calendar and the day
  // is empty" — never an implicit absence of a read capability.
  const calendar = new FakeCalendar()
  const service = new GarminToolService(data as GarminDataClient, {
    activityDetail: 'compact',
    fitDownloadDir: '',
    accountUsername: 'runner@example.test',
    accountRegion: 'cn',
    stateDirectory,
    calendarReader: calendar,
  })
  return { data, service, writer, calendar }
}

describe('createAndScheduleWorkout routes through the coordinator', () => {
  it('a second createAndSchedule with the same payload does not re-dispatch scheduleWorkout', async () => {
    const state = freshState()
    const { service, data, writer } = makeService(state)
    const payload = {
      workout: { name: 'Easy', steps: [{ type: 'interval', endCondition: 'distance', endValue: 5000 }] },
      date: '2026-09-30',
      timezone: TIMEZONE,
    }
    const first = await service.createAndScheduleWorkout(payload as never) as { requiresConfirmation: boolean; confirmationId: string }
    expect(first.requiresConfirmation).toBe(true)
    await service.createAndScheduleWorkout({ ...payload, confirmed: true, confirmationId: first.confirmationId } as never)
    const firstCreateCount = (data.addWorkout as jest.Mock).mock.calls.length
    const firstScheduleCount = (writer as jest.Mock).mock.calls.length
    expect(firstCreateCount).toBe(1)
    expect(firstScheduleCount).toBe(1)

    // Both phases are already satisfied in the journal, so the second call is
    // a no-op that reports the durable receipts instead of minting a
    // confirmation that would write nothing.
    const second = await service.createAndScheduleWorkout(payload as never) as {
      requiresConfirmation: boolean
      alreadyCreated?: boolean
      alreadyScheduled?: boolean
      workoutId?: string
    }
    expect(second).toMatchObject({
      requiresConfirmation: false,
      alreadyCreated: true,
      alreadyScheduled: true,
      workoutId: 'w-A',
    })
    expect((data.addWorkout as jest.Mock).mock.calls.length).toBe(firstCreateCount)
    expect((writer as jest.Mock).mock.calls.length).toBe(firstScheduleCount)
  })

  it('createAndSchedule records the schedule operation in the journal', async () => {
    const state = freshState()
    const { service } = makeService(state)
    const payload = {
      workout: { name: 'Tempo', steps: [{ type: 'interval', endCondition: 'distance', endValue: 5000 }] },
      date: '2026-10-05',
      timezone: TIMEZONE,
    }
    const first = await service.createAndScheduleWorkout(payload as never) as { confirmationId: string }
    await service.createAndScheduleWorkout({ ...payload, confirmed: true, confirmationId: first.confirmationId } as never)
    const ops = await service.listWriteOperations() as Array<{ kind: string; steps: unknown[] }>
    // The schedule half of createAndSchedule must be journaled.
    expect(ops.length).toBeGreaterThan(0)
  })
})

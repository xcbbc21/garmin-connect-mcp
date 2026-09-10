import { runReadOnlyChecks } from '../scripts/integration-test'

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

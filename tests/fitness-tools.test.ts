import { GarminToolService, type GarminDataClient } from '../src/tool-service'

function serviceWith(getLegacy: jest.Mock, getUserProfile = jest.fn().mockResolvedValue({ displayName: 'runner' })): GarminToolService {
  return new GarminToolService({ getLegacy, getUserProfile } as unknown as GarminDataClient, {
    activityDetail: 'compact', fitDownloadDir: '', accountUsername: 'runner@example.test', accountRegion: 'cn',
  })
}

describe('fitness and profile read compatibility', () => {
  it('uses the legacy endpoint families with stable request arguments', async () => {
    const getLegacy = jest.fn(async (path: string, query?: unknown) => ({ path, query }))
    const service = serviceWith(getLegacy)

    await service.getPersonalRecords()
    await service.getGoals({ status: 'active' })
    await service.getBadges()
    await service.getHydration({ startDate: '2026-09-10', endDate: '2026-09-10' })
    await service.getVo2max({ startDate: '2026-09-11', endDate: '2026-09-11' })
    await service.getFitnessStats({ startDate: '2026-09-01', endDate: '2026-09-07' })
    await service.getHrZonesConfig()
    await service.getPowerZones()
    await service.getTrainingReadiness({ startDate: '2026-09-12', endDate: '2026-09-12' })

    expect(getLegacy.mock.calls).toEqual([
      ['personalrecord-service/personalrecord/prs/runner', { includeHistory: 'true' }],
      ['goal-service/goal/goals', { status: 'active' }],
      ['badge-service/badge/earned'],
      ['usersummary-service/usersummary/hydration/allData/2026-09-10'],
      ['metrics-service/metrics/maxmet/latest/2026-09-11'],
      ['fitnessstats-service/activity', {
        aggregation: 'daily', startDate: '2026-09-01', endDate: '2026-09-07',
        groupByActivityType: 'true', standardizedUnits: 'true',
        groupByParentActivityType: 'false', userFirstDay: 'sunday', metric: 'duration',
      }],
      ['biometric-service/heartRateZones/'],
      ['biometric-service/powerZones/sports/all'],
      ['metrics-service/metrics/trainingreadiness/2026-09-12'],
    ])
  })

  it('does not invent a display name when personal records cannot resolve one', async () => {
    const getLegacy = jest.fn()
    const service = serviceWith(getLegacy, jest.fn().mockResolvedValue({ userData: {} }))
    await expect(service.getPersonalRecords()).rejects.toThrow('display name')
    expect(getLegacy).not.toHaveBeenCalled()
  })
})

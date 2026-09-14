import { GarminToolService, type GarminDataClient } from '../src/tool-service'

function serviceWith(getLegacy: jest.Mock): GarminToolService {
  const client = {
    getLegacy,
  } as unknown as GarminDataClient
  return new GarminToolService(client, {
    activityDetail: 'compact',
    fitDownloadDir: '',
    accountUsername: 'runner@example.test',
    accountRegion: 'cn',
  })
}

describe('activity detail service compatibility', () => {
  it('returns activity splits in the new read envelope', async () => {
    const getLegacy = jest.fn().mockResolvedValue({ splits: [{ distance: 1 }] })
    const service = serviceWith(getLegacy)

    await expect(service.getActivitySplits({ activityId: '123' })).resolves.toMatchObject({
      data: { splits: [{ distance: 1 }] },
      source: 'garmin',
      region: 'cn',
      partial: false,
    })
    expect(getLegacy).toHaveBeenCalledWith('activity-service/activity/123/splits')
  })

  it('uses the legacy adapter for each activity detail family', async () => {
    const getLegacy = jest.fn(async (path: string) => ({ path }))
    const service = serviceWith(getLegacy)

    await service.getActivityHrZones({ activityId: '123' })
    await service.getActivityPolyline({ activityId: '123' })
    await service.getActivityWeather({ activityId: '123' })

    expect(getLegacy.mock.calls.map(call => call[0])).toEqual([
      'activity-service/activity/123/hrTimeInZones',
      'activity-service/activity/123/polyline/full-resolution/',
      'activity-service/activity/123/weather',
    ])
  })

  it('fails clearly when a client has no legacy read capability', async () => {
    const service = new GarminToolService({} as GarminDataClient, {
      activityDetail: 'compact',
      fitDownloadDir: '',
      accountUsername: 'runner@example.test',
      accountRegion: 'cn',
    })

    await expect(service.getActivityWeather({ activityId: '123' }))
      .rejects.toThrow('Legacy Garmin read capability is unavailable')
  })
})

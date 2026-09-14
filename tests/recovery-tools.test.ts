import { GarminToolService, type GarminDataClient } from '../src/tool-service'

function serviceWith(getLegacy: jest.Mock): GarminToolService {
  return new GarminToolService({ getLegacy } as unknown as GarminDataClient, {
    activityDetail: 'compact', fitDownloadDir: '', accountUsername: 'runner@example.test', accountRegion: 'cn',
  })
}

describe('recovery read compatibility', () => {
  it('reads Body Battery, HRV and sleep statistics through the read adapter', async () => {
    const getLegacy = jest.fn(async (path: string) => ({ path }))
    const service = serviceWith(getLegacy)

    await service.getBodyBattery()
    await service.getHrv({ startDate: '2026-09-10', endDate: '2026-09-10' })
    await service.getSleepStats({ startDate: '2026-09-01', endDate: '2026-09-07' })

    expect(getLegacy.mock.calls).toEqual([
      ['wellness-service/wellness/bodyBattery/messagingToday'],
      ['hrv-service/hrv/2026-09-10'],
      ['sleep-service/stats/sleep/daily/2026-09-01/2026-09-07'],
    ])
  })

  it('keeps unavailable HRV records nullable and marks the series partial', async () => {
    const getLegacy = jest.fn().mockResolvedValue({ noData: true })
    const service = serviceWith(getLegacy)

    await expect(service.getHrv({ startDate: '2026-09-10', endDate: '2026-09-10' }))
      .resolves.toMatchObject({
        data: [{ date: '2026-09-10', data: null }],
        missingDates: ['2026-09-10'],
        partial: true,
      })
  })
})

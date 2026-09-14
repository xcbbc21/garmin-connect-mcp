import { GarminToolService, type GarminDataClient } from '../src/tool-service'

function serviceWith(getLegacy: jest.Mock): GarminToolService {
  return new GarminToolService({ getLegacy } as unknown as GarminDataClient, {
    activityDetail: 'compact',
    fitDownloadDir: '',
    accountUsername: 'runner@example.test',
    accountRegion: 'cn',
  })
}

describe('daily wellness read compatibility', () => {
  it('forwards local dates to each legacy wellness endpoint', async () => {
    const getLegacy = jest.fn(async (path: string, query?: unknown) => ({ path, query }))
    const service = serviceWith(getLegacy)

    await service.getDailySummaryChart({ startDate: '2026-09-10', endDate: '2026-09-10' })
    await service.getDailyIntensityMinutes({ startDate: '2026-09-11', endDate: '2026-09-11' })
    await service.getDailyMovement({ startDate: '2026-09-12', endDate: '2026-09-12' })
    await service.getDailyRespiration({ startDate: '2026-09-13', endDate: '2026-09-13' })

    expect(getLegacy.mock.calls).toEqual([
      ['wellness-service/wellness/dailySummaryChart/', { date: '2026-09-10' }],
      ['wellness-service/wellness/daily/im/2026-09-11'],
      ['wellness-service/wellness/dailyMovement', { calendarDate: '2026-09-12' }],
      ['wellness-service/wellness/daily/respiration/2026-09-13'],
    ])
  })

  it('reports no-data days explicitly instead of converting them to zero', async () => {
    const getLegacy = jest.fn()
      .mockResolvedValueOnce({ steps: 100 })
      .mockResolvedValueOnce({ noData: true, status: 204 })
    const service = serviceWith(getLegacy)

    await expect(service.getDailyMovement({
      startDate: '2026-09-10', endDate: '2026-09-11',
    })).resolves.toMatchObject({
      data: [
        { date: '2026-09-10', data: { steps: 100 } },
        { date: '2026-09-11', data: null },
      ],
      missingDates: ['2026-09-11'],
      partial: true,
      source: 'garmin',
      region: 'cn',
    })
  })

  it('rejects reversed and overlong date ranges before dispatch', async () => {
    const getLegacy = jest.fn()
    const service = serviceWith(getLegacy)

    await expect(service.getDailyMovement({
      startDate: '2026-09-12', endDate: '2026-09-10',
    })).rejects.toThrow('endDate must be on or after startDate')
    await expect(service.getDailyMovement({
      startDate: '2026-09-01', endDate: '2026-10-01',
    })).rejects.toThrow('Date range cannot exceed 30 days')
    expect(getLegacy).not.toHaveBeenCalled()
  })
})

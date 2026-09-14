import { PublicToolError } from '../utils/errors'

/** The only transport capability exposed to legacy read adapters. */
export interface LegacyGarminReadTransport {
  get<T>(path: string, query?: Record<string, string | number>): Promise<T>
}

/**
 * Thin, read-only compatibility layer for endpoints not exposed by the
 * garmin-connect SDK. It deliberately has no POST, DELETE, or arbitrary
 * request method, so old write paths cannot leak into the new writer.
 */
export class LegacyGarminReadAdapter {
  constructor(private readonly transport: LegacyGarminReadTransport) {}

  async getActivitySplits(activityId: string): Promise<unknown> {
    return this.getActivityResource(activityId, 'splits')
  }

  async getActivityHrZones(activityId: string): Promise<unknown> {
    return this.getActivityResource(activityId, 'hrTimeInZones')
  }

  async getActivityPolyline(activityId: string): Promise<unknown> {
    return this.getActivityResource(activityId, 'polyline/full-resolution/')
  }

  async getActivityWeather(activityId: string): Promise<unknown> {
    return this.getActivityResource(activityId, 'weather')
  }

  async getDailySummaryChart(date: string): Promise<unknown> {
    return this.transport.get('wellness-service/wellness/dailySummaryChart/', { date })
  }

  async getDailyIntensityMinutes(date: string): Promise<unknown> {
    return this.transport.get(`wellness-service/wellness/daily/im/${encodeURIComponent(date)}`)
  }

  async getDailyMovement(date: string): Promise<unknown> {
    return this.transport.get('wellness-service/wellness/dailyMovement', { calendarDate: date })
  }

  async getDailyRespiration(date: string): Promise<unknown> {
    return this.transport.get(`wellness-service/wellness/daily/respiration/${encodeURIComponent(date)}`)
  }

  async getBodyBattery(): Promise<unknown> {
    return this.transport.get('wellness-service/wellness/bodyBattery/messagingToday')
  }

  async getHrv(date: string): Promise<unknown> {
    return this.transport.get(`hrv-service/hrv/${encodeURIComponent(date)}`)
  }

  async getSleepStats(startDate: string, endDate: string): Promise<unknown> {
    return this.transport.get(
      `sleep-service/stats/sleep/daily/${encodeURIComponent(startDate)}/${encodeURIComponent(endDate)}`,
    )
  }

  async getPersonalRecords(displayName: string): Promise<unknown> {
    return this.transport.get(
      `personalrecord-service/personalrecord/prs/${encodeURIComponent(displayName)}`,
      { includeHistory: 'true' },
    )
  }

  async getGoals(status: string): Promise<unknown> {
    return this.transport.get('goal-service/goal/goals', { status })
  }

  async getBadges(): Promise<unknown> {
    return this.transport.get('badge-service/badge/earned')
  }

  async getHydration(date: string): Promise<unknown> {
    return this.transport.get(`usersummary-service/usersummary/hydration/allData/${encodeURIComponent(date)}`)
  }

  async getVo2max(date: string): Promise<unknown> {
    return this.transport.get(`metrics-service/metrics/maxmet/latest/${encodeURIComponent(date)}`)
  }

  async getFitnessStats(
    startDate: string,
    endDate: string,
    aggregation: string,
    metric: string,
  ): Promise<unknown> {
    return this.transport.get('fitnessstats-service/activity', {
      aggregation,
      startDate,
      endDate,
      groupByActivityType: 'true',
      standardizedUnits: 'true',
      groupByParentActivityType: 'false',
      userFirstDay: 'sunday',
      metric,
    })
  }

  async getHrZonesConfig(): Promise<unknown> {
    return this.transport.get('biometric-service/heartRateZones/')
  }

  async getPowerZones(): Promise<unknown> {
    return this.transport.get('biometric-service/powerZones/sports/all')
  }

  async getTrainingReadiness(date: string): Promise<unknown> {
    return this.transport.get(`metrics-service/metrics/trainingreadiness/${encodeURIComponent(date)}`)
  }

  private getActivityResource(activityId: string, resource: string): Promise<unknown> {
    const id = activityId.trim()
    if (!id) throw new PublicToolError('Invalid activityId')
    return this.transport.get(`activity-service/activity/${encodeURIComponent(id)}/${resource}`)
  }
}

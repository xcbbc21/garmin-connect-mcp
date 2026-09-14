import type { GarminRegion } from '../config'

export interface DailyReadPoint<T> {
  date: string
  data: T | null
}

export interface DailySeriesEnvelope<T> {
  data: Array<DailyReadPoint<T>>
  source: 'garmin'
  region: GarminRegion
  retrievedAt: string
  partial: boolean
  missingDates: string[]
}

export function dailySeriesEnvelope<T>(
  points: Array<DailyReadPoint<T>>,
  region: GarminRegion,
): DailySeriesEnvelope<T> {
  const missingDates = points.filter(point => point.data === null).map(point => point.date)
  return {
    data: points,
    source: 'garmin',
    region,
    retrievedAt: new Date().toISOString(),
    partial: missingDates.length > 0,
    missingDates,
  }
}

export function isNoData(value: unknown): boolean {
  return typeof value === 'object'
    && value !== null
    && (value as Record<string, unknown>).noData === true
}

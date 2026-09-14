import type { GarminRegion } from '../config'

export interface LegacyReadEnvelope<T> {
  data: T
  source: 'garmin'
  region: GarminRegion
  retrievedAt: string
  partial: boolean
}

export interface LegacyActivityDetailArgs {
  activityId: string
}

export type ActivitySplit = Record<string, unknown>
export type ActivityHrZone = Record<string, unknown>
export type ActivityPolyline = Record<string, unknown>
export type ActivityWeather = Record<string, unknown>

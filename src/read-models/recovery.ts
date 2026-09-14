import type { GarminRegion } from '../config'

export interface RecoveryReadEnvelope<T> {
  data: T
  source: 'garmin'
  region: GarminRegion
  retrievedAt: string
  partial: boolean
}

import type { GarminRegion } from '../config'

export interface FitnessReadEnvelope<T> {
  data: T
  source: 'garmin'
  region: GarminRegion
  retrievedAt: string
  partial: boolean
}

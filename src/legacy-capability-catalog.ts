export type LegacyCapabilityId =
  | 'list-activities'
  | 'get-activity-details'
  | 'get-activity-splits'
  | 'get-activity-hr-zones'
  | 'get-activity-polyline'
  | 'get-activity-weather'
  | 'download-fit'
  | 'get-daily-summary'
  | 'get-daily-heart-rate'
  | 'get-daily-stress'
  | 'get-daily-summary-chart'
  | 'get-daily-intensity-minutes'
  | 'get-daily-movement'
  | 'get-daily-respiration'
  | 'get-sleep'
  | 'get-sleep-stats'
  | 'get-body-battery'
  | 'get-hrv'
  | 'get-weight'
  | 'get-personal-records'
  | 'get-goals'
  | 'get-badges'
  | 'get-hydration'
  | 'get-vo2max'
  | 'get-fitness-stats'
  | 'get-hr-zones-config'
  | 'get-power-zones'
  | 'get-training-readiness'
  | 'list-workouts'
  | 'get-workout'
  | 'create-workout'
  | 'schedule-workout'
  | 'delete-workout'

export type LegacyCapabilityAccess = 'read' | 'write'
export type LegacyCapabilityVerification = 'source-only' | 'simulated' | 'live-read' | 'live-write'
export type LegacyCapabilityMigration = 'adapter' | 'preserve' | 'do-not-copy'

export interface LegacyCapabilityStatus {
  id: LegacyCapabilityId
  oldTool: string
  newTool?: string
  access: LegacyCapabilityAccess
  endpointFamily: string
  migration: LegacyCapabilityMigration
  regions: readonly ('cn' | 'global')[]
  verification: LegacyCapabilityVerification
}

const read = (
  id: LegacyCapabilityId,
  endpointFamily: string,
  newTool?: string,
): LegacyCapabilityStatus => ({
  id,
  oldTool: id,
  newTool,
  access: 'read',
  endpointFamily,
  migration: 'adapter',
  regions: ['cn'],
  verification: 'source-only',
})

const capabilities: readonly LegacyCapabilityStatus[] = [
  read('list-activities', 'activity', 'get_garmin_activities'),
  read('get-activity-details', 'activity'),
  read('get-activity-splits', 'activity-detail', 'get_garmin_activity_splits'),
  read('get-activity-hr-zones', 'activity-detail', 'get_garmin_activity_hr_zones'),
  read('get-activity-polyline', 'activity-detail', 'get_garmin_activity_polyline'),
  read('get-activity-weather', 'activity-detail', 'get_garmin_activity_weather'),
  read('download-fit', 'activity-fit', 'download_garmin_activity_fit'),
  read('get-daily-summary', 'daily-wellness'),
  read('get-daily-heart-rate', 'daily-wellness', 'get_garmin_heart_rate'),
  read('get-daily-stress', 'daily-wellness'),
  read('get-daily-summary-chart', 'daily-wellness', 'get_garmin_daily_summary_chart'),
  read('get-daily-intensity-minutes', 'daily-wellness', 'get_garmin_daily_intensity_minutes'),
  read('get-daily-movement', 'daily-wellness', 'get_garmin_daily_movement'),
  read('get-daily-respiration', 'daily-wellness', 'get_garmin_daily_respiration'),
  read('get-sleep', 'sleep', 'get_garmin_sleep'),
  read('get-sleep-stats', 'sleep', 'get_garmin_sleep_stats'),
  read('get-body-battery', 'recovery', 'get_garmin_body_battery'),
  read('get-hrv', 'recovery', 'get_garmin_hrv'),
  read('get-weight', 'profile-health', 'get_garmin_weight'),
  read('get-personal-records', 'fitness', 'get_garmin_personal_records'),
  read('get-goals', 'fitness', 'get_garmin_goals'),
  read('get-badges', 'fitness', 'get_garmin_badges'),
  read('get-hydration', 'fitness', 'get_garmin_hydration'),
  read('get-vo2max', 'fitness', 'get_garmin_vo2max'),
  read('get-fitness-stats', 'fitness', 'get_garmin_fitness_stats'),
  read('get-hr-zones-config', 'fitness', 'get_garmin_hr_zones_config'),
  read('get-power-zones', 'fitness', 'get_garmin_power_zones'),
  read('get-training-readiness', 'fitness', 'get_garmin_training_readiness'),
  read('list-workouts', 'workout', 'get_garmin_workouts'),
  read('get-workout', 'workout'),
  {
    ...read('create-workout', 'workout-write', 'create_garmin_workout'),
    access: 'write', migration: 'preserve',
  },
  {
    ...read('schedule-workout', 'calendar-write', 'schedule_garmin_workout'),
    access: 'write', migration: 'do-not-copy',
  },
  {
    ...read('delete-workout', 'workout-write'),
    access: 'write', migration: 'do-not-copy',
  },
]

export function getLegacyCapability(id: LegacyCapabilityId): LegacyCapabilityStatus {
  const capability = capabilities.find(entry => entry.id === id)
  if (!capability) throw new Error(`Unknown legacy Garmin capability: ${id}`)
  return { ...capability, regions: [...capability.regions] }
}

export function listLegacyCapabilities(): LegacyCapabilityStatus[] {
  return capabilities.map(capability => ({ ...capability, regions: [...capability.regions] }))
}

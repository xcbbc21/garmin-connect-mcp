# Legacy Garmin capability matrix

This matrix records the migration boundary between the legacy MCP and the new
MCP. `source-only` means the endpoint and old implementation were inspected;
it does not mean the endpoint has been independently verified against a live
Garmin Connect China account.

| Legacy capability | New entry point | Access | Migration | Verification | Notes |
| --- | --- | --- | --- | --- | --- |
| Activity splits / HR zones / polyline / weather | `get_garmin_activity_splits`, `get_garmin_activity_hr_zones`, `get_garmin_activity_polyline`, `get_garmin_activity_weather` | read | adapter | source-only | GET-only through the new authenticated client |
| Activity FIT | `download_garmin_activity_fit` | read/export | preserve | simulated | Uses the new private output and metadata contract |
| Daily summary chart / intensity minutes / movement / respiration | `get_garmin_daily_summary_chart`, `get_garmin_daily_intensity_minutes`, `get_garmin_daily_movement`, `get_garmin_daily_respiration` | read | adapter | source-only | Date ranges return explicit `missingDates` |
| Body Battery / HRV / sleep stats | `get_garmin_body_battery`, `get_garmin_hrv`, `get_garmin_sleep_stats` | read | adapter | source-only | Missing HRV days remain nullable |
| Personal records / goals / badges / hydration | `get_garmin_personal_records`, `get_garmin_goals`, `get_garmin_badges`, `get_garmin_hydration` | read | adapter | source-only | Personal records resolve display name from the authenticated profile |
| VO2 max / fitness stats / HR zones / power zones / training readiness | `get_garmin_vo2max`, `get_garmin_fitness_stats`, `get_garmin_hr_zones_config`, `get_garmin_power_zones`, `get_garmin_training_readiness` | read | adapter | source-only | Raw provider fields are wrapped with source and retrieval metadata |
| Workout list | `get_garmin_workouts` | read | preserve | simulated | Existing normalized new contract remains canonical |
| Workout DTO creation | `create_garmin_workout_legacy` | write | normalize + preserve | simulated | Old DTO is converted before the new preview/confirm/journal writer |
| Workout scheduling | `schedule_garmin_workout`, `batch_schedule_garmin_workouts`, `create_and_schedule_garmin_workout` | write | do-not-copy | simulated | Legacy direct POST is not exposed |
| Calendar deletion | `unschedule_garmin_workout` | write | do-not-copy | simulated | Removes a schedule entry, not a reusable template |
| Legacy daily summary / stress / monthly calendar / badge leaderboard / workout deletion | — | read/write | not migrated | source-only | No new public entry point was added in this batch |

## Region and authentication boundary

The public runtime is fixed to Garmin Connect China (`cn`). `GARMIN_REGION`
and the `--region` selector are rejected or hidden; the compatibility spelling
`--region cn` is accepted only as a no-op for existing scripts. The new
session-token/OAuth restoration, account binding, browser authentication
broker, and session verification remain authoritative. The old manual
Cookie/CSRF capture flow is not reused.

## Calendar gate

The migrated read adapters cannot call Calendar or any write method. Calendar
reads and writes continue to pass through the new Calendar capability gate and
write coordinator. China Calendar remains unsupported until independently
captured evidence enables it; source inspection and simulated tests are not
live-read or live-write evidence.

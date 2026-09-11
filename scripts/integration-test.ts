/**
 * Explicitly invoked, read-only live checks using the same configuration,
 * session handling and service as the MCP server. Never run in ordinary CI.
 *
 * Two groups of checks live here and they answer different questions:
 *
 * - `runReadOnlyChecks` proves the session works at all (activities, sleep,
 *   steps, heart rate, weight, workouts, profile).
 * - `runCalendarReadProbe` is the only check that touches the calendar, and it
 *   is the one that closes the "live" column of
 *   `docs/calendar-api-verification.md`. It is opt-in through
 *   `GARMIN_CALENDAR_PROBE_RANGE` because a range the operator never chose
 *   would manufacture evidence about days nobody asked about.
 *
 * Neither group writes, deletes, or retries anything.
 */
import { config as loadEnv } from 'dotenv'
import { GarminClient, GarminToolService, resolveConfig } from '../src/index'
import { safeUpstreamLogLine } from '../src/utils/errors'

type ReadService = Pick<GarminToolService,
  'getActivities' | 'getSleep' | 'getSteps' | 'getHeartRate' |
  'getWeight' | 'getWorkouts' | 'getProfile'>

type CalendarReadService = Pick<GarminToolService, 'getCalendarRange'>

export async function runReadOnlyChecks(
  service: ReadService,
  report: (name: string, success: boolean, value?: unknown) => void,
): Promise<{ passed: number; failed: number }> {
  const checks: Array<[string, () => Promise<unknown>]> = [
    ['activities', () => service.getActivities({ limit: 3 })],
    ['sleep', () => service.getSleep()],
    ['steps', () => service.getSteps()],
    ['heartRate', () => service.getHeartRate()],
    ['weight', () => service.getWeight()],
    ['workouts', () => service.getWorkouts({ limit: 5 })],
    ['profile', () => service.getProfile()],
  ]
  let passed = 0
  let failed = 0
  for (const [name, action] of checks) {
    try {
      const value = await action()
      passed++
      report(name, true, value)
    } catch {
      failed++
      report(name, false)
    }
  }
  return { passed, failed }
}

/** Names the one calendar range the probe may read (`YYYY-MM-DD..YYYY-MM-DD`). */
export const CALENDAR_PROBE_ENV = 'GARMIN_CALENDAR_PROBE_RANGE'

/** Whether the calendar probe read anything, and whether the read worked. */
export type CalendarProbeOutcome = 'skipped' | 'passed' | 'failed'

const CALENDAR_PROBE_RANGE = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/

/**
 * The smallest read that closes the "live" column of
 * `docs/calendar-api-verification.md`.
 *
 * Authorising `npm run test:integration` alone answers no calendar question,
 * because `runReadOnlyChecks` never touches the calendar; a green run there says
 * nothing about the read adapter. This probe is the read that does say
 * something: one range, one query, no write, no local state, no retry.
 *
 * The range comes from `GARMIN_CALENDAR_PROBE_RANGE` and is deliberately not
 * defaulted — a probe that invented a range would report live evidence about
 * days the operator never chose. With the variable unset the outcome is
 * `skipped`, which is not a pass: it must never be reported as one.
 *
 * A read that fails is reported as `failed`, and the upstream text is never
 * echoed, because the same reporting path carries account responses.
 */
export async function runCalendarReadProbe(
  service: CalendarReadService,
  report: (name: string, success: boolean, value?: unknown) => void,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CalendarProbeOutcome> {
  const raw = env[CALENDAR_PROBE_ENV]?.trim()
  if (!raw) return 'skipped'
  const parsed = CALENDAR_PROBE_RANGE.exec(raw)
  if (!parsed) {
    // Fail closed on a malformed range instead of guessing one. The value is
    // not echoed: this report path is shared with account responses.
    report(CALENDAR_PROBE_ENV + ' (expected YYYY-MM-DD..YYYY-MM-DD)', false)
    return 'failed'
  }
  const [, startDate = '', endDate = ''] = parsed
  try {
    const snapshot = await service.getCalendarRange({ startDate, endDate })
    report('calendarRange', true, {
      range: snapshot.range,
      probedRange: snapshot.probedRange,
      complete: snapshot.complete,
      requestsIssued: snapshot.requestsIssued,
      entries: snapshot.entries.length,
      // §4.1 of docs/calendar-api-verification.md asks whether a real item ever
      // omits this id (one source's fixture has it null for coach entries), so
      // report the raw per-entry observation instead of a verdict about it.
      entryScheduleIds: snapshot.entries.map(entry => entry.workoutScheduleId),
      missingRanges: snapshot.missingRanges,
      warnings: snapshot.warnings,
    })
    return 'passed'
  } catch {
    report('calendarRange', false)
    return 'failed'
  }
}

async function main(): Promise<void> {
  let secrets: ReadonlyArray<string | undefined> = [
    process.env.DOTENV_KEY, process.env.GARMIN_SESSION_TOKEN_FILE,
  ]
  const write = console.error.bind(console)
  console.log = (...values: unknown[]) => write(safeUpstreamLogLine(values, secrets))
  console.error = (...values: unknown[]) => write(safeUpstreamLogLine(values, secrets))
  loadEnv()
  const config = resolveConfig()
  secrets = [config.username, config.password, config.sessionToken, config.sessionTokenFile, process.env.DOTENV_KEY]
  const client = new GarminClient(config, { allowUnconfigured: true })
  const service = new GarminToolService(client, {
    activityDetail: config.activityDetail, fitDownloadDir: config.fitDownloadDir,
    accountUsername: config.username, accountRegion: config.region,
  })
  const verbose = process.env.GARMIN_INTEGRATION_VERBOSE === 'true'
  const result = await runReadOnlyChecks(service, (name, success, value) => {
    console.log(name + ': ' + (success ? 'PASS' : 'FAIL'))
    if (verbose && success) console.log(JSON.stringify(value))
  })
  console.log('Read-only checks: ' + result.passed + ' passed, ' + result.failed + ' failed')
  const calendar = await runCalendarReadProbe(service, (name, success, value) => {
    console.log(name + ': ' + (success ? 'PASS' : 'FAIL'))
    if (verbose && success) console.log(JSON.stringify(value))
  })
  // A skipped probe is reported as its own outcome so it can never be read as
  // calendar evidence, and it is not a failure: no range was authorised.
  console.log('Calendar read probe: ' + calendar)
  if (calendar === 'skipped') {
    console.log('  set ' + CALENDAR_PROBE_ENV + '=YYYY-MM-DD..YYYY-MM-DD to read one range')
  }
  if (result.failed || calendar === 'failed') process.exitCode = 1
}

if (require.main === module) {
  void main().catch(() => {
    process.stderr.write('Integration check could not start; check account and session configuration.\n')
    process.exitCode = 1
  })
}

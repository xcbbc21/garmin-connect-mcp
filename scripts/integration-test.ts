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
import {
  CalendarCapabilityError,
  CALENDAR_WARNING_CODES,
  GarminClient,
  GarminToolService,
  resolveConfig,
} from '../src/index'
import type { CalendarSnapshot } from '../src/index'
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

/**
 * The only accepted shape of `GARMIN_CALENDAR_PROBE_RANGE`.
 *
 * The range is passed through verbatim, including a reversed start/end pair:
 * rejecting an order the service accepts would make the probe answer a
 * different question than the one it claims to answer.
 */
export const CALENDAR_PROBE_RANGE = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/

/**
 * The exit code implied by the two check groups.
 *
 * Only `passed` and `skipped` may leave the code at zero. `skipped` does not
 * fail the command — no range was authorised, so nothing was attempted — but
 * it is still printed as its own outcome so a zero exit code is never read as
 * "the calendar was observed".
 *
 * This is a function rather than an inline `if` in `main()` because `main()`
 * loads dotenv and constructs a live client, which no test may do. Inline, the
 * decision was unreachable from a test and a regression that dropped the
 * calendar term would have stayed green.
 */
export function integrationExitCode(
  readOnlyFailed: number,
  calendar: CalendarProbeOutcome,
): 0 | 1 {
  if (readOnlyFailed > 0) return 1
  return calendar === 'failed' || calendar === 'refused' ? 1 : 0
}

/** The operator hint printed after a calendar outcome, or `null` for a pass. */
export function calendarProbeHint(calendar: CalendarProbeOutcome): string | null {
  if (calendar === 'skipped') {
    return '  set ' + CALENDAR_PROBE_ENV + '=YYYY-MM-DD..YYYY-MM-DD to read one range'
  }
  if (calendar === 'refused') {
    return '  the calendar is not queryable for this account or region; nothing was sent'
  }
  return null
}

/**
 * What the probe did.
 *
 * `refused` and `failed` are both non-passes and both make the command exit
 * non-zero, but they say different things and must not be collapsed: `refused`
 * means the adapter declined before building a request, so the service was
 * never asked; `failed` means a request went out and the read did not come back
 * usable. Reporting a refusal as `failed` would read as "the service refused".
 */
export type CalendarProbeOutcome = 'skipped' | 'passed' | 'failed' | 'refused'

/**
 * Warning codes that mean the read did not complete.
 *
 * This distinction is load-bearing, and it is why "the call resolved" is not
 * treated as "the read worked". The adapter does not reject on a transport
 * failure: it catches it, records `[CHUNK_READ_FAILED]` and resolves a snapshot
 * carrying `complete:false`. A gateway 500 therefore arrives here as a
 * perfectly successful promise, and reporting that as a pass would manufacture
 * the one thing this probe exists to rule out.
 *
 * Keying on `complete` alone would be wrong in the other direction: one
 * unreadable item also clears it, and that is an observation about the data
 * rather than a failed read.
 */
const CALENDAR_READ_FAILURE_WARNINGS: readonly string[] = [
  CALENDAR_WARNING_CODES.CHUNK_LIMIT_EXCEEDED,
  CALENDAR_WARNING_CODES.CHUNK_READ_FAILED,
  CALENDAR_WARNING_CODES.RESPONSE_UNREADABLE,
  CALENDAR_WARNING_CODES.RESPONSE_TRUNCATED,
  CALENDAR_WARNING_CODES.CURSOR_LOOP_DETECTED,
  CALENDAR_WARNING_CODES.PAGE_LIMIT_EXCEEDED,
  CALENDAR_WARNING_CODES.ITEMS_LIMIT_EXCEEDED,
]

/** The snapshot's warnings that say the read itself did not complete. */
function calendarReadFailures(snapshot: CalendarSnapshot): string[] {
  return snapshot.warnings.filter(warning =>
    CALENDAR_READ_FAILURE_WARNINGS.some(code => warning.startsWith('[' + code + ']')))
}

/**
 * The smallest read that closes the "live" column of
 * `docs/calendar-api-verification.md`.
 *
 * Authorising `npm run test:integration` alone answers no calendar question,
 * because `runReadOnlyChecks` never touches the calendar; a green run there says
 * nothing about the read adapter. This probe is the read that does say
 * something: one range, no write, no local state, no retry.
 *
 * The range comes from `GARMIN_CALENDAR_PROBE_RANGE` and is deliberately not
 * defaulted — a probe that invented a range would report live evidence about
 * days the operator never chose. With the variable unset the outcome is
 * `skipped`, which is not a pass: it must never be reported as one.
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
    const readFailures = calendarReadFailures(snapshot)
    // The payload is reported even when the read failed: the warning codes are
    // the evidence, and a bare FAIL would hide why.
    report('calendarRange', readFailures.length === 0, {
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
      readFailures,
    })
    return readFailures.length === 0 ? 'passed' : 'failed'
  } catch (error) {
    if (error instanceof CalendarCapabilityError) {
      // The adapter refused before building a request — an unsupported region,
      // or no calendar transport at all. Nothing was sent, so this is a
      // capability answer rather than a read that went wrong.
      report('calendarRange (not supported for this account or region)', false)
      return 'refused'
    }
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
    // Printed on failure too: when a read fails the warning codes *are* the
    // evidence, so gating on `success` would make the most informative run the
    // least informative one.
    if (verbose && value !== undefined) console.log(JSON.stringify(value))
  })
  // A skipped probe is reported as its own outcome so it can never be read as
  // calendar evidence, and it is not a failure: no range was authorised.
  console.log('Calendar read probe: ' + calendar)
  const hint = calendarProbeHint(calendar)
  if (hint) console.log(hint)
  process.exitCode = integrationExitCode(result.failed, calendar)
}

if (require.main === module) {
  void main().catch(() => {
    process.stderr.write('Integration check could not start; check account and session configuration.\n')
    process.exitCode = 1
  })
}

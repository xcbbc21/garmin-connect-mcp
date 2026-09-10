/**
 * Explicitly invoked, read-only live checks using the same configuration,
 * session handling and service as the MCP server. Never run in ordinary CI.
 */
import { config as loadEnv } from 'dotenv'
import { GarminClient, GarminToolService, resolveConfig } from '../src/index'
import { safeUpstreamLogLine } from '../src/utils/errors'

type ReadService = Pick<GarminToolService,
  'getActivities' | 'getSleep' | 'getSteps' | 'getHeartRate' |
  'getWeight' | 'getWorkouts' | 'getProfile'>

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
  if (result.failed) process.exitCode = 1
}

if (require.main === module) {
  void main().catch(() => {
    process.stderr.write('Integration check could not start; check account and session configuration.\n')
    process.exitCode = 1
  })
}

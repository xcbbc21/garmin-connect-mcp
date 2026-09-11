// Test-only MCP peer backed by the out-of-process fake Garmin.
//
// Same shape as `stdio-server.cjs`, with two differences that matter for
// recovery testing:
//
//   1. The calendar and the write tallies live in `fake-garmin-server.cjs`, not
//      here. Killing this process therefore destroys nothing that a restart
//      test needs to read back.
//   2. Four forced-exit points can be selected by environment variable. Each one
//      terminates this process with SIGKILL — no shutdown hooks, no exit
//      handler, no flush — so the journal on disk is exactly what was durable at
//      that instant, which is the only thing a crash test may assert on.
//
// The exit points all live in the client wrapper rather than in the peer: the
// question is where *this* process died relative to the single dispatch, not
// what the peer did.
'use strict'

const { createMcpServer, GarminToolService } = require('../../lib')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const { installMcpShutdownHooks } = require('../../lib/mcp-shutdown')
const { FileAccountLock } = require('../../lib/write-operations/lock.js')
const { accountKey } = require('../../lib/write-operations/identity.js')

const base = process.env.FAKE_GARMIN_URL
if (!base) {
  process.stderr.write('FAKE_GARMIN_URL is required\n')
  process.exit(2)
}

function optionalCount(name) {
  const raw = process.env[name]
  if (!raw) return undefined
  const value = Number.parseInt(raw, 10)
  return Number.isInteger(value) && value > 0 ? value : undefined
}

/** Kill before the Nth schedule POST leaves this process. */
const exitBeforeSchedule = optionalCount('FAKE_GARMIN_EXIT_BEFORE_SCHEDULE_N')
/** Kill once the Nth schedule response has been received but not yet returned. */
const exitAfterScheduleResponse = optionalCount('FAKE_GARMIN_EXIT_AFTER_SCHEDULE_RESPONSE_N')
/** Kill when a schedule POST fails at the transport layer, before reporting it. */
const exitOnScheduleTransportError = process.env.FAKE_GARMIN_EXIT_ON_SCHEDULE_ERROR === '1'

/**
 * Optional shortened lock wait.
 *
 * The production budget is five seconds; a case that asserts "a lock left behind
 * by a killed process blocks the next attempt" would spend that five seconds per
 * assertion for no extra signal. Only the wait budget changes — the lock is the
 * same on-disk directory with the same owner record and the same refusal.
 */
const lockWaitMs = optionalCount('FAKE_GARMIN_LOCK_WAIT_MS')

/**
 * A real process death, not an orderly shutdown.
 *
 * SIGKILL is deliberate: `process.exit` would still run exit handlers, and the
 * point of these cases is that nothing after the kill happens at all.
 */
function die(code) {
  if (code) process.exitCode = code
  process.kill(process.pid, 'SIGKILL')
}

async function call(path, init) {
  const response = await fetch(`${base}${path}`, init)
  if (!response.ok) throw new Error(`fake garmin ${path} responded ${response.status}`)
  const text = await response.text()
  return text ? JSON.parse(text) : undefined
}

function post(path, body) {
  return call(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

let scheduleCalls = 0

const data = {
  getWorkoutDetail: async workoutId =>
    await call(`/api/workout/${encodeURIComponent(workoutId)}`).catch(() => ({
      workoutId,
      workoutName: `Workout ${workoutId}`,
    })),
  addWorkout: async workout => await post('/api/workout', workout),
  scheduleWorkout: async (workoutId, date) => {
    scheduleCalls += 1
    if (exitBeforeSchedule !== undefined && scheduleCalls === exitBeforeSchedule) {
      // The dispatch never left: the journal keeps its pre-dispatch marker and
      // the peer's tally must not move.
      die()
    }
    let result
    try {
      result = await post('/api/schedule', { workoutId, date })
    } catch (error) {
      if (exitOnScheduleTransportError) die()
      throw error
    }
    if (exitAfterScheduleResponse !== undefined && scheduleCalls === exitAfterScheduleResponse) {
      // The provider answered and the answer never reached the coordinator.
      die()
    }
    return result
  },
  unscheduleWorkout: async workoutScheduleId => {
    await post('/api/unschedule', { workoutScheduleId })
  },
}

/**
 * Read-only view of the same peer. It exposes `getCalendarRange` and no write
 * verb at all, so no read path reached through here can hide a re-send.
 */
const calendarReader = {
  async getCalendarRange(range) {
    const query = new URLSearchParams({ startDate: range.startDate, endDate: range.endDate })
    return await call(`/__calendar?${query.toString()}`)
  },
}

async function main() {
  const stateDirectory = process.env.GARMIN_STATE_DIR
  const accountLock = lockWaitMs === undefined
    ? undefined
    : new FileAccountLock(
      stateDirectory,
      accountKey(process.env.GARMIN_USERNAME, process.env.GARMIN_REGION),
      undefined,
      { waitTimeoutMs: lockWaitMs },
    )
  const server = createMcpServer(new GarminToolService(data, {
    activityDetail: 'compact',
    fitDownloadDir: '',
    accountUsername: process.env.GARMIN_USERNAME,
    accountRegion: process.env.GARMIN_REGION,
    stateDirectory,
    calendarReader,
    ...(accountLock ? { accountLock } : {}),
  }))
  await server.connect(new StdioServerTransport())
  installMcpShutdownHooks(server)
}

main().catch(error => {
  process.stderr.write(`fixture failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})

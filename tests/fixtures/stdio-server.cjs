// Test-only transport peer. No Garmin credentials or network are used.
const { createMcpServer, GarminToolService } = require('../../lib')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const { installMcpShutdownHooks } = require('../../lib/mcp-shutdown')
const calendar = require('./stdio-calendar.cjs')
let writes = 0
const data = {
  getWorkoutDetail: async id => ({ workoutId: id, workoutName: 'Fixture workout' }),
  scheduleWorkout: async (workoutId, date) => {
    const workoutScheduleId = String(++writes)
    calendar.addEntry({ workoutId, date, workoutScheduleId, title: 'Fixture workout' })
    return { workoutScheduleId }
  },
  unscheduleWorkout: async workoutScheduleId => {
    writes++
    calendar.removeByScheduleId(workoutScheduleId)
  },
}
async function main() {
  const server = createMcpServer(new GarminToolService(data, {
    activityDetail: 'compact', fitDownloadDir: '', accountUsername: 'fixture@example.test', accountRegion: 'global',
    // A fresh-date query is mandatory before any schedule is previewed or
    // resumed; without a reader every write is blocked rather than sent blind.
    calendarReader: calendar.reader,
  }))
  await server.connect(new StdioServerTransport())
  installMcpShutdownHooks(server)
}
main().catch(() => { process.exitCode = 1 })

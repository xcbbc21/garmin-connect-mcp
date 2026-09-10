// Test-only transport peer. No Garmin credentials or network are used.
const { createMcpServer, GarminToolService } = require('../../lib')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const { installMcpShutdownHooks } = require('../../lib/mcp-shutdown')
let writes = 0
const data = {
  getWorkoutDetail: async id => ({ workoutId: id, workoutName: 'Fixture workout' }),
  scheduleWorkout: async () => ({ workoutScheduleId: String(++writes) }),
  unscheduleWorkout: async () => { writes++ },
}
async function main() {
  const server = createMcpServer(new GarminToolService(data, {
    activityDetail: 'compact', fitDownloadDir: '', accountUsername: 'fixture@example.test', accountRegion: 'global',
  }))
  await server.connect(new StdioServerTransport())
  installMcpShutdownHooks(server)
}
main().catch(() => { process.exitCode = 1 })

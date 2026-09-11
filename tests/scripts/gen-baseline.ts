import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from '../../src/mcp'
import { writeFileSync } from 'node:fs'

const service = {
  getActivities: () => Promise.resolve([]),
  getSleep: () => Promise.resolve({}),
  getSteps: () => Promise.resolve({}),
  getHeartRate: () => Promise.resolve({}),
  getWeight: () => Promise.resolve({}),
  getWorkouts: () => Promise.resolve([]),
  getProfile: () => Promise.resolve({}),
  getRunningAdvice: () => Promise.resolve({}),
  createWorkout: () => Promise.resolve({}),
  scheduleWorkout: () => Promise.resolve({}),
  batchScheduleWorkouts: () => Promise.resolve({}),
  createAndScheduleWorkout: () => Promise.resolve({}),
  unscheduleWorkout: () => Promise.resolve({}),
  downloadActivityFit: () => Promise.resolve({}),
  getWriteOperation: () => Promise.resolve(null),
  findWriteOperationByIdempotencyKey: () => Promise.resolve(null),
  listWriteOperationPage: () => Promise.resolve({}),
  redactOperation: (op: unknown) => op,
  getCalendarRange: () => Promise.resolve({}),
  reconcileWriteOperation: () => Promise.resolve({}),
  resumeWriteOperation: () => Promise.resolve({}),
}
async function main() {
  const server = createMcpServer(service as never)
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'gen', version: '0' })
  await Promise.all([server.connect(serverT), client.connect(clientT)])
  const r = await client.listTools()
  writeFileSync('tests/fixtures/mcp-tools-baseline.json', JSON.stringify(r, null, 2))
  console.log('Wrote', r.tools.length, 'tools')
  await client.close(); await server.close()
}
main().catch(err => { console.error(err); process.exit(1) })

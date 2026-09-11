/**
 * Local operation-query tests (C4).
 *
 * `get_garmin_write_operation` exposes the local account write journal as a
 * read-only MCP tool. It must work without login, must redact the raw
 * idempotency key and request payload, and must list operations in createdAt
 * order with pagination.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMcpServer } from '../src/mcp'
import { GarminToolService, type GarminDataClient } from '../src/tool-service'
import type { GarminClientOptions } from '../src/client'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { accountKey } from '../src/write-operations/identity'

const ACCOUNT = accountKey('runner@example.test', 'cn')
const TIMEZONE = 'Asia/Shanghai'

function freshState(): string {
  return mkdtempSync(join(tmpdir(), 'garmin-query-'))
}

function makeService(stateDirectory: string, writer: jest.Mock) {
  const data: Partial<GarminDataClient> = {
    getWorkoutDetail: jest.fn().mockResolvedValue({ workoutName: 'Easy run' }),
    scheduleWorkout: writer,
    unscheduleWorkout: jest.fn().mockResolvedValue(undefined),
    addWorkout: jest.fn().mockResolvedValue({ workoutId: 'created-1' }),
  }
  const service = new GarminToolService(data as GarminDataClient, {
    activityDetail: 'compact',
    fitDownloadDir: '',
    accountUsername: 'runner@example.test',
    accountRegion: 'cn',
    stateDirectory,
  })
  return { data, service }
}

async function withMcpServer(service: GarminToolService, fn: (client: Client) => Promise<void>): Promise<void> {
  const server = createMcpServer(service as unknown as Parameters<typeof createMcpServer>[0])
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' })
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ])
  try {
    await fn(client)
  } finally {
    await client.close()
    await server.close()
  }
}

describe('get_garmin_write_operation', () => {
  it('returns operationId details without login and redacts sensitive fields', async () => {
    const state = freshState()
    const writer = jest.fn().mockResolvedValue({ workoutScheduleId: 'sid-1' })
    const { service } = makeService(state, writer)
    const request = { workoutId: 'w1', date: '2026-09-20', timezone: TIMEZONE, idempotencyKey: 'leak-1' }
    const preview = await service.scheduleWorkout(request as never)
    await service.scheduleWorkout({
      ...request,
      confirmed: true,
      confirmationId: (preview as { confirmationId: string }).confirmationId,
    } as never)

    await withMcpServer(service, async (client) => {
      const list = await client.listTools()
      expect(list.tools.some(t => t.name === 'get_garmin_write_operation')).toBe(true)

      const result = await client.callTool({
        name: 'get_garmin_write_operation',
        arguments: { operationId: (preview as { operationId: string }).operationId },
      })
      const text = (result.content as Array<{ text: string }>)[0].text
      const payload = JSON.parse(text)
      expect(payload.found).toBe(true)
      expect(payload.operation.operationId).toBe((preview as { operationId: string }).operationId)
      // Sensitive fields are redacted.
      const serialized = JSON.stringify(payload)
      expect(serialized).not.toContain('leak-1')
      expect(serialized).not.toContain(ACCOUNT) // accountKey must not be echoed
      expect(serialized).not.toContain('idempotencyKeyHash')
    })
  })

  it('looks up by idempotencyKey without revealing the raw key', async () => {
    const state = freshState()
    const writer = jest.fn().mockResolvedValue({ workoutScheduleId: 'sid-2' })
    const { service } = makeService(state, writer)
    const request = { workoutId: 'w2', date: '2026-09-21', timezone: TIMEZONE, idempotencyKey: 'secret-key' }
    const preview = await service.scheduleWorkout(request as never)
    await service.scheduleWorkout({
      ...request,
      confirmed: true,
      confirmationId: (preview as { confirmationId: string }).confirmationId,
    } as never)

    await withMcpServer(service, async (client) => {
      const result = await client.callTool({
        name: 'get_garmin_write_operation',
        arguments: { idempotencyKey: 'secret-key' },
      })
      const text = (result.content as Array<{ text: string }>)[0].text
      const payload = JSON.parse(text)
      expect(payload.found).toBe(true)
      const serialized = JSON.stringify(payload)
      expect(serialized).not.toContain('secret-key')
    })
  })

  it('lists operations with pagination', async () => {
    const state = freshState()
    const writer = jest.fn().mockResolvedValue({ workoutScheduleId: 'sid-3' })
    const { service } = makeService(state, writer)
    for (let i = 0; i < 3; i++) {
      const preview = await service.scheduleWorkout({
        workoutId: `w-${i}`, date: `2026-09-${22 + i}`, timezone: TIMEZONE,
      } as never)
      await service.scheduleWorkout({
        workoutId: `w-${i}`, date: `2026-09-${22 + i}`, timezone: TIMEZONE,
        confirmed: true,
        confirmationId: (preview as { confirmationId: string }).confirmationId,
      } as never)
    }
    await withMcpServer(service, async (client) => {
      const result = await client.callTool({
        name: 'get_garmin_write_operation',
        arguments: { limit: 2 },
      })
      const text = (result.content as Array<{ text: string }>)[0].text
      const payload = JSON.parse(text)
      expect(payload.total).toBe(3)
      expect(payload.operations).toHaveLength(2)
    })
  })

  it('returns found:false for an unknown operationId', async () => {
    const state = freshState()
    const writer = jest.fn()
    const { service } = makeService(state, writer)
    await withMcpServer(service, async (client) => {
      const result = await client.callTool({
        name: 'get_garmin_write_operation',
        arguments: { operationId: '00000000-0000-0000-0000-000000000000' },
      })
      const text = (result.content as Array<{ text: string }>)[0].text
      const payload = JSON.parse(text)
      expect(payload.found).toBe(false)
    })
  })
})

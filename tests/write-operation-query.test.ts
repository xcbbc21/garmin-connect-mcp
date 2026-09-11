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
import { FakeCalendar } from './fixtures/calendar/fake-calendar'
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
    // Explicit precondition: the account can read its calendar and the day is
    // empty. A missing read capability would refuse the write instead.
    calendarReader: new FakeCalendar(),
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

/**
 * C8: the query tool's argument and paging contract.
 *
 * A caller that lost a response reaches for this tool to find out what
 * happened, so the ways it can be *misused* matter as much as the happy path:
 * two selectors at once, a limit in detail mode, and a cursor that names a
 * shifted window rather than the list it was minted against.
 */
describe('get_garmin_write_operation contract', () => {
  async function call(
    client: Client,
    args: Record<string, unknown>,
  ): Promise<{ isError: boolean; payload: Record<string, any>; text: string }> {
    const result = await client.callTool({ name: 'get_garmin_write_operation', arguments: args })
    const text = (result.content as Array<{ text: string }>)[0].text
    return { isError: Boolean(result.isError), payload: readPayload(text), text }
  }

  /**
   * A rejected schema never reaches the handler, so the SDK answers with a
   * protocol error string instead of a tool payload. That is the strongest
   * form of "this argument is not a cursor", and it still has to be asserted
   * on — just not as JSON.
   */
  function readPayload(text: string): Record<string, any> {
    try {
      return JSON.parse(text)
    } catch {
      return { message: text }
    }
  }

  /**
   * Seed `count` distinct satisfied operations starting at `offset`.
   *
   * The offset matters: re-seeding the same workout/date pair is reported by
   * the preview as an existing duplicate and issues no confirmation handle,
   * which is the behaviour under test elsewhere — not a way to add operations.
   */
  async function seedOperations(
    service: GarminToolService,
    count: number,
    offset = 0,
  ): Promise<void> {
    for (let n = offset; n < offset + count; n++) {
      const request = {
        workoutId: `w-${n}`,
        date: `2026-09-${22 + n}`,
        timezone: TIMEZONE,
      }
      const preview = await service.scheduleWorkout(request as never) as { confirmationId: string }
      await service.scheduleWorkout({
        ...request, confirmed: true, confirmationId: preview.confirmationId,
      } as never)
    }
  }

  it('refuses both selectors at once', async () => {
    const { service } = makeService(freshState(), jest.fn())
    await withMcpServer(service, async (client) => {
      const both = await call(client, {
        operationId: '00000000-0000-0000-0000-000000000000',
        idempotencyKey: 'k-1',
      })
      expect(both.isError).toBe(true)
      expect(both.payload.message).toContain('not both')
    })
  })

  it('refuses limit and cursor in detail mode', async () => {
    const state = freshState()
    const writer = jest.fn().mockResolvedValue({ workoutScheduleId: 'sid-detail' })
    const { service } = makeService(state, writer)
    const preview = await service.scheduleWorkout({
      workoutId: 'w1', date: '2026-09-20', timezone: TIMEZONE,
    } as never) as { operationId: string; confirmationId: string }
    await service.scheduleWorkout({
      workoutId: 'w1', date: '2026-09-20', timezone: TIMEZONE,
      confirmed: true, confirmationId: preview.confirmationId,
    } as never)

    await withMcpServer(service, async (client) => {
      const withLimit = await call(client, { operationId: preview.operationId, limit: 5 })
      expect(withLimit.isError).toBe(true)
      expect(withLimit.payload.message).toContain('only apply when listing')

      const withCursor = await call(client, { operationId: preview.operationId, cursor: 'AAAA' })
      expect(withCursor.isError).toBe(true)
      expect(withCursor.payload.message).toContain('only apply when listing')

      // The lookup itself still works with neither extra argument.
      const detail = await call(client, { operationId: preview.operationId })
      expect(detail.isError).toBe(false)
      expect(detail.payload.found).toBe(true)
    })
  })

  it('rejects a path-shaped cursor before it can be treated as one', async () => {
    const { service } = makeService(freshState(), jest.fn())
    await withMcpServer(service, async (client) => {
      for (const cursor of ['../../etc/passwd', 'a/b', 'has space', '..']) {
        const result = await call(client, { cursor })
        expect(result.isError).toBe(true)
        // Rejected as an argument, so it never becomes a lookup that could
        // answer "no such operation" for a path.
        expect(result.text).not.toContain('OPERATION_NOT_FOUND')
      }
      // And a well-formed token that this build never minted is refused too,
      // rather than being decoded into an offset.
      const syntacticallyFine = await call(client, { cursor: 'AAAA' })
      expect(syntacticallyFine.isError).toBe(true)
      expect(syntacticallyFine.payload.message).toContain('CURSOR_INVALID')
    })
  })

  it('pages with nextCursor and refuses a cursor the journal has moved past', async () => {
    const state = freshState()
    const writer = jest.fn().mockImplementation(async (workoutId: string) => ({
      workoutScheduleId: `sid-${workoutId}`,
    }))
    const { service } = makeService(state, writer)
    await seedOperations(service, 3)

    await withMcpServer(service, async (client) => {
      const first = await call(client, { limit: 2 })
      expect(first.isError).toBe(false)
      expect(first.payload.total).toBe(3)
      expect(first.payload.operations).toHaveLength(2)
      expect(typeof first.payload.nextCursor).toBe('string')

      const second = await call(client, { limit: 2, cursor: first.payload.nextCursor })
      expect(second.payload.operations).toHaveLength(1)
      expect(second.payload.nextCursor).toBeNull()

      // A fourth operation invalidates the cursor: the response must say the
      // window moved, and must NOT offer an `operations` list that a caller
      // could read as "that is everything".
      await seedOperations(service, 1, 3)
      const stale = await call(client, { limit: 2, cursor: first.payload.nextCursor })
      expect(stale.isError).toBe(false)
      expect(stale.payload).toMatchObject({
        success: false,
        staleCursor: true,
        errorCode: 'CURSOR_STALE',
      })
      expect(stale.payload).not.toHaveProperty('operations')

      // Starting over still works.
      const restarted = await call(client, {})
      expect(restarted.payload.total).toBe(4)
      expect(restarted.payload.operations).toHaveLength(4)
    })
  })

  it('reports a missing idempotency key with the same code as a missing operationId', async () => {
    const { service } = makeService(freshState(), jest.fn())
    await withMcpServer(service, async (client) => {
      const byKey = await call(client, { idempotencyKey: 'never-used' })
      const byId = await call(client, { operationId: '00000000-0000-0000-0000-000000000000' })
      expect(byKey.isError).toBe(false)
      expect(byKey.payload.found).toBe(false)
      expect(byKey.payload.errorCode).toBe('OPERATION_NOT_FOUND')
      expect(byId.payload.errorCode).toBe('OPERATION_NOT_FOUND')
      // Neither answer distinguishes "never existed" from "belongs to someone
      // else", so the payloads differ only in the identifier that was asked for.
      const { operationId, hasIdempotencyKey, ...byKeyRest } = byKey.payload
      const { operationId: _id, hasIdempotencyKey: _k, ...byIdRest } = byId.payload
      expect(byKeyRest).toEqual(byIdRest)
      expect(operationId).toBeUndefined()
      expect(hasIdempotencyKey).toBe(true)
    })
  })

  it('carries the operation-level recovery roll-up on a satisfied operation', async () => {
    const state = freshState()
    const writer = jest.fn().mockResolvedValue({ workoutScheduleId: 'sid-roll-up' })
    const { service } = makeService(state, writer)
    const preview = await service.scheduleWorkout({
      workoutId: 'w-roll', date: '2026-09-24', timezone: TIMEZONE,
    } as never) as { operationId: string; confirmationId: string }
    await service.scheduleWorkout({
      workoutId: 'w-roll', date: '2026-09-24', timezone: TIMEZONE,
      confirmed: true, confirmationId: preview.confirmationId,
    } as never)

    await withMcpServer(service, async (client) => {
      const detail = await call(client, { operationId: preview.operationId })
      expect(detail.payload.found).toBe(true)
      // The roll-up belongs to the record, so it travels with the record in
      // both detail mode and listing mode.
      expect(detail.payload.operation).toMatchObject({
        operationId: preview.operationId,
        status: 'satisfied',
        canResume: false,
        manualReviewRequired: false,
        desiredStateSatisfied: true,
      })
      // A satisfied operation must not hand the caller a write-shaped next
      // action, and the per-step roll-up must agree with the operation's.
      expect(detail.payload.operation.nextAction).toBeUndefined()
      for (const step of detail.payload.operation.steps) {
        expect(step).toMatchObject({
          status: 'succeeded',
          evidence: 'response',
          canResume: false,
          manualReviewRequired: false,
        })
        expect(step.nextAction).toBeUndefined()
      }
    })
  })
})

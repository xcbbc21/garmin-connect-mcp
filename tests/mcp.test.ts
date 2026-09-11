import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { UrlElicitationRequiredError } from '@modelcontextprotocol/sdk/types.js'
import { createMcpServer, standaloneConfig } from '../src/mcp'
import { GarminToolService, type GarminDataClient } from '../src/tool-service'
import { GarminAuthenticationRequiredError } from '../src/utils/errors'
import { encodeConfirmationId } from '../src/write-operations/identity'
import { FakeCalendar } from './fixtures/calendar/fake-calendar'

describe('MCP adapter', () => {
  it('exposes calendar scheduling tools with write annotations and strict schemas', async () => {
    const service = serviceStub()
    const server = createMcpServer(service as any)
    const client = new Client({ name: 'test-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ])

    try {
      expect(client.getServerVersion()?.version).toBe(
        (require('../package.json') as { version: string }).version,
      )
      const result = await client.listTools()
      expect(result).toEqual(require('./fixtures/mcp-tools-baseline.json'))
      expect(result.tools.map(tool => tool.name)).toEqual([
        'get_garmin_activities',
        'get_garmin_sleep',
        'get_garmin_steps',
        'get_garmin_heart_rate',
        'get_garmin_weight',
        'get_garmin_workouts',
        'get_garmin_profile',
        'get_running_skill_advice',
        'create_garmin_workout',
        'schedule_garmin_workout',
        'batch_schedule_garmin_workouts',
        'create_and_schedule_garmin_workout',
        'unschedule_garmin_workout',
        'download_garmin_activity_fit',
        'get_garmin_calendar',
        'get_garmin_write_operation',
        'reconcile_garmin_write_operation',
        'resume_garmin_write_operation',
      ])
      const scheduleWorkout = result.tools.find(tool => tool.name === 'schedule_garmin_workout')!
      expect(scheduleWorkout.inputSchema).toMatchObject({
        type: 'object',
        required: ['workoutId', 'date'],
        additionalProperties: false,
      })
      expect(scheduleWorkout.annotations).toMatchObject({
        readOnlyHint: false,
        idempotentHint: false,
      })
      const batchSchedule = result.tools.find(tool => tool.name === 'batch_schedule_garmin_workouts')!
      expect(batchSchedule.inputSchema).toMatchObject({
        required: ['schedules'],
        properties: expect.objectContaining({ schedules: expect.any(Object) }),
      })
      const createWorkout = result.tools.find(tool => tool.name === 'create_garmin_workout')!
      expect(createWorkout.description).toContain('does not generate a training plan')
      expect(createWorkout.description).toContain('mode=personalized')
      expect(createWorkout.inputSchema).toMatchObject({
        type: 'object',
        properties: expect.objectContaining({
          name: expect.any(Object),
          steps: expect.any(Object),
          confirmed: expect.any(Object),
          confirmationId: expect.any(Object),
        }),
        required: expect.arrayContaining(['name', 'steps']),
      })
      expect(createWorkout.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      })

      const downloadFit = result.tools.find(
        tool => tool.name === 'download_garmin_activity_fit',
      )!
      expect(downloadFit.description).toContain('GARMIN_FIT_DOWNLOAD_DIR')
      expect(downloadFit.description).toContain('GARMIN_FIT_<region>_<account-email>')
      expect(downloadFit.description).toContain('parent directory')
      expect(downloadFit.inputSchema).toMatchObject({
        type: 'object',
        required: ['activityId'],
        additionalProperties: false,
        properties: {
          activityId: expect.any(Object),
        },
      })
      expect(downloadFit.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      })

      const runningAdvice = result.tools.find(
        tool => tool.name === 'get_running_skill_advice',
      )!
      expect(runningAdvice.description).toContain('personalized')
      expect(runningAdvice.description).toContain('Hansons')
      expect(runningAdvice.description).toContain('Jack Daniels')
      expect(runningAdvice.description).toContain('Norwegian')
      expect(runningAdvice.description).toContain('polarized')
      expect(runningAdvice.inputSchema).toMatchObject({
        type: 'object',
        required: ['mode'],
        additionalProperties: false,
        properties: expect.objectContaining({
          mode: expect.objectContaining({
            type: 'string',
            enum: ['explain', 'personalized'],
          }),
          language: expect.objectContaining({ type: 'string', enum: ['zh-CN', 'en'] }),
          goal: expect.objectContaining({
            type: 'string',
            minLength: 4,
            maxLength: 500,
            description: expect.stringContaining('event'),
          }),
          currentPerformance: expect.objectContaining({ type: 'string', minLength: 4, maxLength: 500 }),
          performanceBasis: expect.objectContaining({
            type: 'string',
            enum: ['recent_race', 'time_trial', 'no_recent_benchmark'],
          }),
          trainingBackground: expect.objectContaining({ type: 'string', minLength: 8, maxLength: 1000 }),
          availability: expect.objectContaining({ type: 'string', minLength: 4, maxLength: 750 }),
          healthConstraints: expect.objectContaining({ type: 'string', minLength: 2, maxLength: 750 }),
          hasWarningSymptoms: expect.objectContaining({
            type: 'boolean',
            description: expect.stringContaining('stops'),
          }),
          trainingPreference: expect.objectContaining({
            type: 'string',
            enum: ['steady', 'hard_easy', 'mixed'],
          }),
          maxQualitySessionsPerWeek: expect.objectContaining({
            type: 'integer',
            minimum: 0,
            maximum: 7,
          }),
          intensityGuidancePreference: expect.objectContaining({
            type: 'string',
            enum: ['pace', 'heart_rate', 'rpe', 'mixed'],
            description: expect.stringContaining('intensity'),
          }),
        }),
      })
      // The four calendar-recovery tools advertise exactly what they do: the
      // range read is read-only; reconcile takes no Garmin write but does
      // record local observations; resume dispatches writes and says so.
      const calendarRead = result.tools.find(tool => tool.name === 'get_garmin_calendar')!
      expect(calendarRead.inputSchema).toMatchObject({
        type: 'object',
        required: ['startDate', 'endDate'],
        additionalProperties: false,
        properties: {
          startDate: expect.objectContaining({
            type: 'string',
            pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          }),
          endDate: expect.objectContaining({
            type: 'string',
            pattern: '^\\d{4}-\\d{2}-\\d{2}$',
            description: expect.stringContaining('366'),
          }),
          timezone: expect.objectContaining({ type: 'string' }),
        },
      })
      expect(calendarRead.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      })
      expect(calendarRead.description).toContain('never an empty')
      expect(calendarRead.description).toContain('reconcile_garmin_write_operation')

      const reconcile = result.tools.find(
        tool => tool.name === 'reconcile_garmin_write_operation',
      )!
      expect(reconcile.inputSchema).toMatchObject({
        type: 'object',
        required: ['operationId'],
        additionalProperties: false,
        properties: { operationId: expect.any(Object) },
      })
      // Not read-only (it writes local observations), not destructive, and
      // safe to repeat — so the hints must not claim a plain read.
      expect(reconcile.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      })
      expect(reconcile.description).toContain('never modifies Garmin')

      const resume = result.tools.find(tool => tool.name === 'resume_garmin_write_operation')!
      expect(resume.inputSchema).toMatchObject({
        type: 'object',
        required: ['operationId'],
        additionalProperties: false,
        properties: expect.objectContaining({
          operationId: expect.any(Object),
          confirmed: expect.any(Object),
          confirmationId: expect.any(Object),
        }),
      })
      expect(resume.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      })
      // A resume carries no payload: letting a caller pass a date or a workout
      // definition here would turn a recovery into a fresh, unapproved write.
      expect(Object.keys(resume.inputSchema.properties ?? {}).sort()).toEqual([
        'confirmationId',
        'confirmed',
        'operationId',
      ])
      expect(resume.description).toContain('never re-sent')
      // Every tool that can change remote or local state must be listed here.
      // Stating the set in both directions catches a new write tool that
      // silently advertises itself as a read *and* an existing one that stops
      // doing so.
      const notReadOnly = result.tools
        .filter(tool => tool.annotations?.readOnlyHint !== true)
        .map(tool => tool.name)
        .sort()
      expect(notReadOnly).toEqual([
        'batch_schedule_garmin_workouts',
        'create_and_schedule_garmin_workout',
        'create_garmin_workout',
        'download_garmin_activity_fit',
        'reconcile_garmin_write_operation',
        'resume_garmin_write_operation',
        'schedule_garmin_workout',
        'unschedule_garmin_workout',
      ])
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('passes workout confirmation through the shared service', async () => {
    const service = serviceStub()
    service.createWorkout.mockResolvedValue({
      requiresConfirmation: true,
      workoutName: 'Easy Run',
    })
    const server = createMcpServer(service as any)
    const client = new Client({ name: 'test-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ])

    try {
      const result = await client.callTool({
        name: 'create_garmin_workout',
        arguments: {
          name: 'Easy Run',
          steps: [{ type: 'warmup', endCondition: 'time', endValue: 600 }],
        },
      })

      expect(service.createWorkout).toHaveBeenCalledWith(expect.objectContaining({
        name: 'Easy Run',
      }))
      expect(result.isError).not.toBe(true)
      expect(result.content).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'text' }),
      ]))
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('passes a calendar-schedule preview through the in-memory MCP transport', async () => {
    const service = serviceStub()
    service.scheduleWorkout.mockResolvedValue({
      requiresConfirmation: true,
      confirmationId: encodeConfirmationId('a0f7d8e1-172e-4e98-8e83-0c05de15a8a8', 0),
    })
    const server = createMcpServer(service as any)
    const client = new Client({ name: 'test-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    try {
      const result = await client.callTool({
        name: 'schedule_garmin_workout',
        arguments: {
          workoutId: 'workout-42',
          date: '2026-09-15',
          timezone: 'Asia/Shanghai',
        },
      })
      expect(service.scheduleWorkout).toHaveBeenCalledWith({
        workoutId: 'workout-42',
        date: '2026-09-15',
        timezone: 'Asia/Shanghai',
      })
      expect(result.isError).not.toBe(true)
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('accepts the revision-bound confirmation handle the service issues', async () => {
    const service = serviceStub()
    service.scheduleWorkout.mockResolvedValue({ success: true, workoutScheduleId: '1' })
    const server = createMcpServer(service as any)
    const client = new Client({ name: 'test-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const operationId = 'a0f7d8e1-172e-4e98-8e83-0c05de15a8a8'
    const handle = encodeConfirmationId(operationId, 0)

    try {
      // The handle the service issues is `<operationId>:<previewRevision>`, so a
      // client that echoes back the preview's own confirmationId has to survive
      // the argument layer. A UUID-only schema rejected it before the service ran.
      const accepted = await client.callTool({
        name: 'schedule_garmin_workout',
        arguments: {
          workoutId: 'workout-42',
          date: '2026-09-15',
          confirmed: true,
          confirmationId: handle,
        },
      })
      expect(accepted.isError).not.toBe(true)
      expect(service.scheduleWorkout).toHaveBeenLastCalledWith(expect.objectContaining({
        confirmed: true,
        confirmationId: handle,
      }))

      // Shapes this server can never mint are refused before dispatch rather
      // than reaching the service: a bare operation id carries no bound
      // revision, so it cannot authorize a write.
      for (const confirmationId of [
        operationId,
        `${operationId}:`,
        `${operationId}:x`,
        `${operationId}:0:1`,
        `:0`,
      ]) {
        const rejected = await client.callTool({
          name: 'schedule_garmin_workout',
          arguments: {
            workoutId: 'workout-42',
            date: '2026-09-15',
            confirmed: true,
            confirmationId,
          },
        })
        expect(rejected.isError).toBe(true)
        expect(JSON.stringify(rejected)).toContain('confirmationId')
      }
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('strictly validates activityId before invoking the FIT download service', async () => {
    const service = serviceStub()
    service.downloadActivityFit.mockResolvedValue({
      success: true,
      activityId: 42,
      fileName: '42.fit',
      sizeBytes: 14,
      sha256: 'a'.repeat(64),
    })
    const server = createMcpServer(service as any)
    const client = new Client({ name: 'test-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ])

    try {
      for (const args of [
        { activityId: 0 },
        { activityId: 1.5 },
        { activityId: Number.MAX_SAFE_INTEGER + 1 },
        { activityId: 42, unexpected: true },
      ]) {
        const invalid = await client.callTool({
          name: 'download_garmin_activity_fit',
          arguments: args,
        })
        expect(invalid.isError).toBe(true)
      }
      expect(service.downloadActivityFit).not.toHaveBeenCalled()

      const result = await client.callTool({
        name: 'download_garmin_activity_fit',
        arguments: { activityId: 42 },
      })
      expect(result.isError).not.toBe(true)
      expect(service.downloadActivityFit).toHaveBeenCalledWith({ activityId: 42 })
      expect(JSON.stringify(result.content)).not.toContain('binary')
      expect(JSON.stringify(result.content)).not.toContain('runner@example.com')
      expect(JSON.stringify(result.content)).not.toContain('/private/downloads')
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('returns a generic MCP error instead of upstream secrets or response data', async () => {
    const service = serviceStub()
    service.getProfile.mockRejectedValue(new Error(
      'Authorization: Bearer secret-token private@example.test',
    ))
    const server = createMcpServer(service as any)
    const client = new Client({ name: 'test-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ])

    try {
      const result = await client.callTool({ name: 'get_garmin_profile', arguments: {} })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain('Garmin request failed')
      expect(JSON.stringify(result.content)).not.toContain('secret-token')
      expect(JSON.stringify(result.content)).not.toContain('private@example.test')
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('passes URL authentication elicitation through and never replays the tool', async () => {
    const service = serviceStub()
    service.getProfile.mockRejectedValue(
      new GarminAuthenticationRequiredError('missing'),
    )
    const requireAuthentication = jest.fn(async () => {
      throw new UrlElicitationRequiredError([{
        mode: 'url',
        message: 'Open Garmin authentication',
        url: 'http://127.0.0.1:54321/garmin-auth/bridge/' + 'a'.repeat(64),
        elicitationId: 'auth-id-1',
      }])
    })
    const server = createMcpServer(service as any, {
      createAuthentication: () => ({ requireAuthentication }),
    })
    const client = new Client(
      { name: 'url-elicitation-client', version: '1.0.0' },
      { capabilities: { elicitation: { url: {} } } },
    )
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ])

    try {
      const operation = client.callTool({
        name: 'get_garmin_profile',
        arguments: {},
      })
      await expect(operation).rejects.toBeInstanceOf(UrlElicitationRequiredError)
      await expect(operation).rejects.toMatchObject({
        elicitations: [expect.objectContaining({ elicitationId: 'auth-id-1' })],
      })
      expect(requireAuthentication).toHaveBeenCalledTimes(1)
      expect(service.getProfile).toHaveBeenCalledTimes(1)
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('closes authentication exactly once through the server lifecycle', async () => {
    const service = serviceStub()
    const closeAuthentication = jest.fn().mockResolvedValue(undefined)
    const server = createMcpServer(service as any, {
      createAuthentication: () => ({
        requireAuthentication: jest.fn(),
        close: closeAuthentication,
      }),
    })
    const client = new Client({ name: 'lifecycle-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    await client.close()
    await server.close()

    expect(closeAuthentication).toHaveBeenCalledTimes(1)
  })

  it('accepts omitted arguments for zero-argument and all-optional read tools', async () => {
    const service = serviceStub()
    const server = createMcpServer(service as any)
    const client = new Client({ name: 'test-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ])

    try {
      const profile = await client.callTool({ name: 'get_garmin_profile' })
      const activities = await client.callTool({ name: 'get_garmin_activities' })

      expect(profile.isError).not.toBe(true)
      expect(activities.isError).not.toBe(true)
      expect(service.getProfile).toHaveBeenCalled()
      expect(service.getActivities).toHaveBeenCalledWith({})
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('requires an explicit running-advice mode before invoking the service', async () => {
    const service = serviceStub()
    const server = createMcpServer(service as any)
    const client = new Client({ name: 'test-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    try {
      const missingMode = await client.callTool({
        name: 'get_running_skill_advice',
        arguments: { query: 'threshold' },
      })
      expect(missingMode.isError).toBe(true)
      expect(service.getRunningAdvice).not.toHaveBeenCalled()

      const valid = await client.callTool({
        name: 'get_running_skill_advice',
        arguments: { mode: 'personalized', language: 'zh-CN' },
      })
      expect(valid.isError).not.toBe(true)
      expect(service.getRunningAdvice).toHaveBeenCalledWith({
        mode: 'personalized',
        language: 'zh-CN',
      })
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('rejects unexpected profile arguments while still allowing omission', async () => {
    const service = serviceStub()
    const server = createMcpServer(service as any)
    const client = new Client({ name: 'test-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    try {
      const result = await client.callTool({
        name: 'get_garmin_profile',
        arguments: { unexpected: 'value' },
      })
      expect(result.isError).toBe(true)
      expect(service.getProfile).not.toHaveBeenCalled()
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('rejects nested repeat groups at the MCP schema boundary', async () => {
    const service = serviceStub()
    const server = createMcpServer(service as any)
    const client = new Client({ name: 'test-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ])

    try {
      const result = await client.callTool({
        name: 'create_garmin_workout',
        arguments: {
          name: 'Nested repeats',
          steps: [{
            type: 'repeat',
            iterations: 2,
            steps: [{ type: 'repeat', iterations: 2, steps: [] }],
          }],
        },
      })

      expect(result.isError).toBe(true)
      expect(service.createWorkout).not.toHaveBeenCalled()
    } finally {
      await client.close()
      await server.close()
    }
  })
})

/**
 * The four calendar-recovery tools, driven through the real MCP argument layer
 * rather than a stub.
 *
 * Schema-shape assertions live in the adapter suite above; what these tests add
 * is that the *arguments a client really sends* survive the layer and reach the
 * coordinator: a required range, a revision-bound confirmation handle, a
 * resume that carries no payload at all. Every test counts POSTs on the writer
 * mock, because "the recovery did not send anything" is the only claim that
 * matters to a user who already lost one response.
 */
describe('calendar recovery tools through the MCP argument layer', () => {
  const TIMEZONE = 'Asia/Shanghai'
  const DATES = ['2026-10-01', '2026-10-02', '2026-10-03']
  const IDS = ['w-a', 'w-b', 'w-c']

  function freshState(): string {
    return mkdtempSync(join(tmpdir(), 'garmin-mcp-recovery-'))
  }

  interface Real {
    service: GarminToolService
    writer: jest.Mock
    /** `null` is an account the service was given no reader for at all. */
    calendar: FakeCalendar | null
  }

  /**
   * A real service behind the MCP layer. `calendar: null` reproduces an account
   * with no verified calendar read at all; omitting `signal` is a process that
   * was never asked to shut down.
   */
  function realService(options: {
    state: string
    writer: jest.Mock
    calendar?: FakeCalendar | null
    signal?: AbortSignal
  }): Real {
    // An explicit `null` means "this account has no verified calendar read",
    // which is not the same as "the caller did not say".
    const calendar = options.calendar === undefined ? new FakeCalendar() : options.calendar
    const data: Partial<GarminDataClient> = {
      getWorkoutDetail: jest.fn().mockResolvedValue({ workoutName: 'Easy run' }),
      addWorkout: jest.fn().mockResolvedValue({ workoutId: 'created-1' }),
      scheduleWorkout: options.writer,
      unscheduleWorkout: jest.fn().mockResolvedValue(undefined),
    }
    const service = new GarminToolService(data as GarminDataClient, {
      activityDetail: 'compact',
      fitDownloadDir: '',
      accountUsername: 'runner@example.test',
      accountRegion: 'cn',
      stateDirectory: options.state,
      calendarReader: calendar ?? undefined,
      shutdownSignal: options.signal,
    })
    return { service, writer: options.writer, calendar }
  }

  async function withServer(
    service: GarminToolService,
    fn: (client: Client) => Promise<void>,
  ): Promise<void> {
    const server = createMcpServer(service as unknown as Parameters<typeof createMcpServer>[0])
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'recovery-client', version: '1.0.0' })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    try {
      await fn(client)
    } finally {
      await client.close()
      await server.close()
    }
  }

  async function callTool(client: Client, name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args })
    const text = (result.content as Array<{ text: string }>)[0].text
    let payload: Record<string, any>
    try {
      payload = JSON.parse(text)
    } catch {
      // A schema rejection never reaches the handler, so the SDK answers with a
      // protocol error string. It is still the answer to assert on.
      payload = { message: text }
    }
    return { isError: Boolean(result.isError), payload, text }
  }

  it('reads a range through the argument layer and refuses an unreadable account', async () => {
    const calendar = new FakeCalendar([
      { date: DATES[0], workoutId: IDS[0], workoutScheduleId: 'sid-a' },
    ])
    const readable = realService({ state: freshState(), writer: jest.fn(), calendar })

    await withServer(readable.service, async (client) => {
      const snapshot = await callTool(client, 'get_garmin_calendar', {
        startDate: DATES[0],
        endDate: DATES[2],
      })
      expect(snapshot.isError).not.toBe(true)
      expect(snapshot.payload).toMatchObject({ complete: true })
      expect(snapshot.payload.entries).toMatchObject([
        { date: DATES[0], workoutId: IDS[0], workoutScheduleId: 'sid-a' },
      ])

      // The range stays required: an omitted endDate never becomes "today".
      const missing = await callTool(client, 'get_garmin_calendar', { startDate: DATES[0] })
      expect(missing.isError).toBe(true)

      // Both range rejections happen before any provider request is issued.
      const reversed = await callTool(client, 'get_garmin_calendar', {
        startDate: DATES[2],
        endDate: DATES[0],
      })
      expect(reversed.isError).toBe(true)
      expect(reversed.text).toContain('CALENDAR_RANGE_INVALID')

      const tooLong = await callTool(client, 'get_garmin_calendar', {
        startDate: '2026-01-01',
        endDate: '2027-12-31',
      })
      expect(tooLong.isError).toBe(true)
      expect(tooLong.text).toContain('CALENDAR_RANGE_TOO_LONG')
      expect(calendar.requestsIssued).toBe(1)
    })

    const unreadable = realService({ state: freshState(), writer: jest.fn(), calendar: null })
    await withServer(unreadable.service, async (client) => {
      const refused = await callTool(client, 'get_garmin_calendar', {
        startDate: DATES[0],
        endDate: DATES[2],
      })
      expect(refused.isError).toBe(true)
      // "Cannot read the calendar" must never be delivered as "the calendar is
      // empty": a caller that read it as empty would conclude a timed-out write
      // never landed, which is exactly the conclusion that duplicates a write.
      expect(refused.text).toContain('CALENDAR_QUERY_UNSUPPORTED')
      expect(refused.text).toContain('not an empty calendar')
      expect(refused.text).not.toContain('"entries"')
    })
  })

  it('reconcile reports what it saw without re-sending the unresolved write', async () => {
    const state = freshState()
    const writer = jest.fn().mockResolvedValue({ workoutScheduleId: 'sid-r' })
    const { service, calendar } = realService({ state, writer })

    await withServer(service, async (client) => {
      const request = { workoutId: 'w-r', date: DATES[0], timezone: TIMEZONE }
      const preview = await callTool(client, 'schedule_garmin_workout', request)
      expect(preview.payload.requiresConfirmation).toBe(true)

      // The POST is sent and the response never arrives.
      writer.mockRejectedValueOnce(new Error('ETIMEDOUT: the request may have been applied'))
      const confirmed = await callTool(client, 'schedule_garmin_workout', {
        ...request,
        confirmed: true,
        confirmationId: preview.payload.confirmationId,
      })
      expect(confirmed.payload.status).toBe('unknown')
      const afterAttempt = writer.mock.calls.length

      const report = await callTool(client, 'reconcile_garmin_write_operation', {
        operationId: confirmed.payload.operationId,
      })
      expect(report.isError).not.toBe(true)
      expect(report.payload).toMatchObject({
        wroteToGarmin: false,
        manualReviewRequired: true,
        nextAction: 'reconcile_garmin_write_operation',
        observations: [
          expect.objectContaining({
            observation: 'observed_absent',
            status: 'unknown',
            unresolved: true,
          }),
        ],
      })
      // A read cannot send, so the POST tally is exactly where the attempt left
      // it — and the advice never points back at a write.
      expect(writer.mock.calls.length).toBe(afterAttempt)
      expect(report.payload.message).toContain('reconcile_garmin_write_operation')
      expect(report.payload.message).not.toContain('schedule_garmin_workout')

      // idempotentHint:true is a promise the layer has to keep.
      const again = await callTool(client, 'reconcile_garmin_write_operation', {
        operationId: confirmed.payload.operationId,
      })
      expect(again.payload).toMatchObject({ wroteToGarmin: false, manualReviewRequired: true })
      expect(writer.mock.calls.length).toBe(afterAttempt)
      expect(calendar?.requestsIssued).toBeGreaterThan(1)
    })
  })

  it('a resume round-trips its handle and re-arms only the journaled steps', async () => {
    const state = freshState()
    const controller = new AbortController()
    const writer = jest.fn(async (workoutId: string, date: string) => {
      // The shutdown lands *between* entries: the POST already built is
      // completed and journaled, and the rest of the batch never leaves. An
      // abort before the lock is taken is a different case — it refuses the
      // whole preview and journals nothing, so there would be no operation to
      // recover.
      controller.abort()
      return { workoutScheduleId: `sid-${workoutId}-${date}` }
    })
    const first = realService({ state, writer, signal: controller.signal })

    let operationId = ''
    await withServer(first.service, async (client) => {
      const schedules = IDS.map((workoutId, index) => ({ workoutId, date: DATES[index] }))
      const request = { schedules, timezone: TIMEZONE }
      const preview = await callTool(client, 'batch_schedule_garmin_workouts', request)
      const confirmed = await callTool(client, 'batch_schedule_garmin_workouts', {
        ...request,
        confirmed: true,
        confirmationId: preview.payload.confirmationId,
      })
      // A cancel that stops the batch is a *stop*, not a lost write: the entry
      // already sent keeps its durable receipt, the remaining two are left
      // retryable, and nothing is reported as an unresolved outcome.
      expect(confirmed.payload).toMatchObject({
        successCount: 1,
        notAttemptedCount: 2,
        unknownCount: 0,
        definiteFailureCount: 0,
      })
      expect(confirmed.payload.results.slice(1)).toEqual([
        expect.objectContaining({ status: 'not_attempted', canResume: true }),
        expect.objectContaining({ status: 'not_attempted', canResume: true }),
      ])
      expect(writer).toHaveBeenCalledTimes(1)
      operationId = confirmed.payload.operationId as string
    })

    // A second process with no cancel signal picks the operation up from the
    // shared journal. Nothing about the recovery is carried in process memory.
    const second = realService({ state, writer })
    await withServer(second.service, async (client) => {
      const preview = await callTool(client, 'resume_garmin_write_operation', { operationId })
      expect(preview.payload.requiresConfirmation).toBe(true)
      expect(preview.payload.preview).toHaveLength(3)
      // Only the two entries that provably never left are armed. The entry that
      // landed keeps its receipt and is reported as already satisfied.
      expect(preview.payload.candidates).toHaveLength(2)
      expect(preview.payload.preview.filter(
        (step: { action: string }) => step.action === 'skip_existing',
      )).toHaveLength(1)
      expect(writer).toHaveBeenCalledTimes(1)

      // A resume takes no payload: extra arguments are refused outright, so a
      // recovery can never move a write to another day or swap the template.
      const withPayload = await callTool(client, 'resume_garmin_write_operation', {
        operationId,
        confirmed: true,
        confirmationId: preview.payload.confirmationId,
        date: DATES[1],
      })
      expect(withPayload.isError).toBe(true)
      expect(writer).toHaveBeenCalledTimes(1)

      const confirmed = await callTool(client, 'resume_garmin_write_operation', {
        operationId,
        confirmed: true,
        confirmationId: preview.payload.confirmationId,
      })
      expect(confirmed.isError).not.toBe(true)
      // Exactly the journaled (workout, day) pairs, each dispatched once across
      // the whole lifecycle — the entry that already landed is never re-sent.
      expect(writer.mock.calls.map(call => call.slice(0, 2))).toEqual(
        IDS.map((workoutId, index) => [workoutId, DATES[index]]),
      )

      // Replaying the handle without a new preview reads the durable receipts
      // instead of dispatching again.
      const replay = await callTool(client, 'resume_garmin_write_operation', {
        operationId,
        confirmed: true,
        confirmationId: preview.payload.confirmationId,
      })
      expect(replay.isError).not.toBe(true)
      expect(writer).toHaveBeenCalledTimes(3)

      // A new preview is what spends the old handle: the revision moves, and a
      // confirmation minted before it is refused with a code the caller can
      // branch on — never replayed as a write.
      const repreviewed = await callTool(client, 'resume_garmin_write_operation', { operationId })
      expect(repreviewed.payload.requiresConfirmation).toBe(false)
      const stale = await callTool(client, 'resume_garmin_write_operation', {
        operationId,
        confirmed: true,
        confirmationId: preview.payload.confirmationId,
      })
      expect(stale.isError).toBe(true)
      expect(stale.payload.errorCode).toBe('CONFIRMATION_STALE')
      expect(stale.text).toContain('CONFIRMATION_STALE')
      // A refused handle must not read as a network failure: nothing was sent.
      expect(stale.payload.message).toContain('refused locally')
      expect(writer).toHaveBeenCalledTimes(3)
    })
  })
})

describe('standalone MCP config', () => {
  const original = { ...process.env }

  afterEach(() => {
    process.env = { ...original }
  })

  it('honors allow-listed GARMIN_LOG_LEVEL values and rejects unknown ones', () => {
    process.env.GARMIN_USERNAME = 'fixture@example.test'
    process.env.GARMIN_PASSWORD = 'fixture-password'
    process.env.GARMIN_LOG_LEVEL = 'warn'
    expect(standaloneConfig().logLevel).toBe('warn')

    process.env.GARMIN_LOG_LEVEL = 'verbose'
    expect(standaloneConfig().logLevel).toBe('info')
  })

  it('does not choose a FIT download directory unless explicitly configured', () => {
    process.env.GARMIN_USERNAME = 'fixture@example.test'
    process.env.GARMIN_PASSWORD = 'fixture-password'
    delete process.env.GARMIN_FIT_DOWNLOAD_DIR

    expect(standaloneConfig().fitDownloadDir).toBe('')
  })

  it('accepts a session-token file as the only configured credential', () => {
    process.env.GARMIN_USERNAME = 'fixture@example.test'
    delete process.env.GARMIN_PASSWORD
    delete process.env.GARMIN_SESSION_TOKEN
    process.env.GARMIN_SESSION_TOKEN_FILE = '/private/session-token.json'
    process.env.GARMIN_FIT_DOWNLOAD_DIR = '/private/garmin-fit-downloads'

    expect(standaloneConfig()).toMatchObject({
      username: 'fixture@example.test',
      password: undefined,
      sessionToken: undefined,
      sessionTokenFile: '/private/session-token.json',
      fitDownloadDir: '/private/garmin-fit-downloads',
    })
  })

  it('starts without a password and assigns the default account session path', () => {
    process.env.GARMIN_USERNAME = 'fixture@example.test'
    process.env.GARMIN_PASSWORD = '   '
    process.env.GARMIN_SESSION_TOKEN = ''
    process.env.GARMIN_SESSION_TOKEN_FILE = '\t'
    process.env.GARMIN_ACCOUNT = 'default'
    process.env.XDG_CONFIG_HOME = '/private/config'

    expect(standaloneConfig()).toMatchObject({
      username: 'fixture@example.test',
      password: '   ',
      sessionToken: '',
      sessionTokenFile:
        '/private/config/garmin-connect-mcp/accounts/default.session.json',
    })
  })

  it('isolates the implicit MCP session by account alias', () => {
    process.env.GARMIN_USERNAME = 'fixture@example.test'
    delete process.env.GARMIN_PASSWORD
    delete process.env.GARMIN_SESSION_TOKEN
    delete process.env.GARMIN_SESSION_TOKEN_FILE
    process.env.GARMIN_ACCOUNT = 'international'
    process.env.XDG_CONFIG_HOME = '/private/config'

    expect(standaloneConfig().sessionTokenFile).toBe(
      '/private/config/garmin-connect-mcp/accounts/international.session.json',
    )
  })

  it('rejects an MCP account alias that could escape the account directory', () => {
    process.env.GARMIN_USERNAME = 'fixture@example.test'
    process.env.GARMIN_ACCOUNT = '../other-user'
    delete process.env.GARMIN_SESSION_TOKEN_FILE

    expect(() => standaloneConfig()).toThrow('Invalid account alias')
  })

  it.each(['CN', 'cn ', 'mars', ''])(
    'rejects an explicitly invalid GARMIN_REGION value (%j)',
    region => {
      process.env.GARMIN_USERNAME = 'fixture@example.test'
      process.env.GARMIN_REGION = region

      expect(() => standaloneConfig()).toThrow(
        'GARMIN_REGION must be exactly global or cn',
      )
    },
  )
})

function serviceStub() {
  return {
    getActivities: jest.fn().mockResolvedValue([]),
    getSleep: jest.fn().mockResolvedValue({}),
    getSteps: jest.fn().mockResolvedValue({}),
    getHeartRate: jest.fn().mockResolvedValue({}),
    getWeight: jest.fn().mockResolvedValue({}),
    getWorkouts: jest.fn().mockResolvedValue([]),
    getProfile: jest.fn().mockResolvedValue({}),
    getRunningAdvice: jest.fn().mockResolvedValue({}),
    createWorkout: jest.fn().mockResolvedValue({}),
    scheduleWorkout: jest.fn().mockResolvedValue({}),
    batchScheduleWorkouts: jest.fn().mockResolvedValue({}),
    createAndScheduleWorkout: jest.fn().mockResolvedValue({}),
    unscheduleWorkout: jest.fn().mockResolvedValue({}),
    downloadActivityFit: jest.fn().mockResolvedValue({}),
    getCalendarRange: jest.fn().mockResolvedValue({}),
    reconcileWriteOperation: jest.fn().mockResolvedValue({}),
    resumeWriteOperation: jest.fn().mockResolvedValue({}),
    getWriteOperation: jest.fn().mockResolvedValue(null),
    findWriteOperationByIdempotencyKey: jest.fn().mockResolvedValue(null),
    listWriteOperationPage: jest.fn().mockResolvedValue({ success: true, total: 0, operations: [] }),
    redactOperation: (operation: unknown) => operation,
  }
}

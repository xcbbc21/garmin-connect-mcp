import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

function toolJson(result: any): any {
  return JSON.parse(result.content[0].text)
}

describe('built MCP over child-process stdio', () => {
  it('initializes the actual executable, exposes the baseline and previews without account access', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'garmin-stdio-'))
    // Windows deliberately rejects generic temp directories with inherited ACLs.
    // Let the production client create its private parent below a trusted root.
    const sessionDirectory = process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA!, `garmin-stdio-${randomUUID()}`)
      : cwd
    const client = new Client({ name: 'generic-client', version: '1' })
    const transport = new StdioClientTransport({
      command: process.execPath, args: [path.resolve(__dirname, '../lib/mcp.js')], cwd,
      env: { GARMIN_USERNAME: 'fixture@example.test', GARMIN_REGION: 'cn',
        GARMIN_ACCOUNT: 'test', GARMIN_SESSION_TOKEN_FILE: path.join(sessionDirectory, 'missing.session.json'),
        PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '',
        GARMIN_STATE_DIR: path.join(sessionDirectory, 'state') },
      stderr: 'pipe',
    })
    const errors: Error[] = []
    let stderr = ''
    transport.stderr?.on('data', data => { stderr += data.toString() })
    client.onerror = error => errors.push(error)
    try {
      await client.connect(transport)
      expect(client.getServerVersion()?.name).toBe('garmin-connect-mcp')
      expect(await client.listTools()).toEqual(require('./fixtures/mcp-tools-baseline.json'))
      const preview = await client.callTool({ name: 'create_garmin_workout', arguments: {
        name: 'Easy 5 km', steps: [{ type: 'interval', endCondition: 'distance', endValue: 5000 }],
      } })
      expect(toolJson(preview)).toMatchObject({ requiresConfirmation: true, workoutName: 'Easy 5 km' })
      // An unsupported client gets the independent authentication command.
      const missing = await client.callTool({ name: 'get_garmin_profile' })
      expect(missing.isError).toBe(true)
      expect(JSON.stringify(missing)).toContain('garmin-connect-auth serve')
      expect(errors).toEqual([])
      expect(stderr).not.toContain('fixture@example.test')
    } finally {
      await client.close()
      expect(transport.pid).toBeNull()
      await rm(cwd, { recursive: true, force: true })
      if (sessionDirectory !== cwd) await rm(sessionDirectory, { recursive: true, force: true })
    }
  }, process.platform === 'win32' ? 120_000 : 15_000)

  it('executes a simulated Calendar write only after confirmation and rejects replay over stdio', async () => {
    // StdioClientTransport sanitizes the child environment, so the write journal
    // must be pointed at a private directory explicitly instead of letting the
    // child fall back to the platform default.
    const stateDirectory = await mkdtemp(path.join(tmpdir(), 'garmin-stdio-state-'))
    const client = new Client({ name: 'generic-client', version: '1' })
    const transport = new StdioClientTransport({
      command: process.execPath, args: [path.join(__dirname, 'fixtures/stdio-server.cjs')],
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        GARMIN_STATE_DIR: stateDirectory,
      },
      stderr: 'pipe',
    })
    const errors: Error[] = []
    client.onerror = error => errors.push(error)
    try {
      await client.connect(transport)
      const request = { workoutId: '42', date: '2099-09-15', timezone: 'Asia/Shanghai' }
      const preview = toolJson(await client.callTool({ name: 'schedule_garmin_workout', arguments: request }))
      expect(preview.requiresConfirmation).toBe(true)
      const confirmed = { ...request, confirmed: true, confirmationId: preview.confirmationId }
      const result = toolJson(await client.callTool({ name: 'schedule_garmin_workout', arguments: confirmed }))
      expect(result).toMatchObject({ success: true, workoutScheduleId: '1' })
      const replay = await client.callTool({ name: 'schedule_garmin_workout', arguments: confirmed })
      expect(replay.isError).toBe(true)
      // A second preview for the same workout and date is deduplicated.
      const deduped = toolJson(await client.callTool({
        name: 'schedule_garmin_workout', arguments: request,
      }))
      expect(deduped).toMatchObject({ requiresConfirmation: false, action: 'skip_existing' })
      expect(errors).toEqual([])
    } finally {
      await client.close()
      expect(transport.pid).toBeNull()
      await rm(stateDirectory, { recursive: true, force: true })
    }
  })
})

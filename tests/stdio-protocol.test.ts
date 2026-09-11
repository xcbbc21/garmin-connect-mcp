import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * Process-level guarantees of the real stdio entry point.
 *
 * These cases deliberately do *not* use `StdioClientTransport`: an MCP client
 * filters and frames whatever the child writes, so it can only ever observe
 * valid JSON-RPC. The question here is what the process writes, byte for byte,
 * which is why the child is driven over a raw pipe.
 */

const ENTRY = path.resolve(__dirname, '../lib/mcp.js')
/** Generous: a case that depends on a real process exiting is bounded well below this. */
const CASE_TIMEOUT_MS = 60_000
/** The server must drain and exit promptly; the production budget is 35 s. */
const EXIT_DEADLINE_MS = 15_000

const PASSWORD = 'pw-stdio-protocol-marker-7f3a'
const USERNAME = 'stdio-protocol@example.test'
/** Survives redaction only if the guard fails; asserted against stderr verbatim. */
const BEARER_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.stdio-protocol-marker'
const COOKIE_VALUE = 'SESSION=stdio-protocol-cookie-marker'

interface Exit {
  code: number | null
  signal: NodeJS.Signals | null
}

/** The peer as an MCP host sees it: raw bytes, no framing and no filtering. */
class RawStdioPeer {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly exited: Promise<Exit>
  private stdout = ''
  private stderr = ''
  private stopped = false

  constructor(
    readonly directory: string,
    env: NodeJS.ProcessEnv,
  ) {
    this.child = spawn(process.execPath, [ENTRY], {
      cwd: directory,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stdout.on('data', chunk => { this.stdout += chunk })
    this.child.stderr.on('data', chunk => { this.stderr += chunk })
    this.exited = new Promise<Exit>(resolve => {
      this.child.on('exit', (code, signal) => resolve({ code, signal }))
    })
  }

  send(frame: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`)
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.send(params === undefined ? { method } : { method, params })
  }

  get standardError(): string { return this.stderr }
  get standardOutput(): string { return this.stdout }

  /** Every line the process wrote to stdout, verbatim and unfiltered. */
  stdoutLines(): string[] {
    return this.stdout.split('\n').filter(line => line.trim() !== '')
  }

  async waitFor(
    predicate: (peer: RawStdioPeer) => boolean,
    description: string,
    timeoutMs = 10_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate(this)) return
      await delay(10)
    }
    throw new Error(
      `timed out after ${timeoutMs} ms waiting for ${description}\n`
      + `--- stdout ---\n${this.stdout}\n--- stderr ---\n${this.stderr}`,
    )
  }

  /** Drive the standard handshake and wait until the server has answered it. */
  async handshake(): Promise<void> {
    this.send({
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'raw-pipe-probe', version: '1' },
      },
    })
    this.notify('notifications/initialized')
    await this.waitFor(
      peer => peer.frames().some(frame => frame.id === 1 && frame.result !== undefined),
      'the initialize response',
    )
  }

  /** Parse every stdout line, failing loudly on anything that is not JSON-RPC. */
  frames(): Array<Record<string, any>> {
    return this.stdoutLines().map(parseFrame)
  }

  endInput(): void {
    this.child.stdin.end()
  }

  /** Tear the pipe down without an orderly `end`, as a crashed host would. */
  childStdinDestroy(): void {
    this.child.stdin.destroy()
  }

  signal(signal: NodeJS.Signals): void {
    this.child.kill(signal)
  }

  isRunning(): boolean { return this.child.exitCode === null && this.child.signalCode === null }

  waitForExit(timeoutMs = EXIT_DEADLINE_MS): Promise<Exit> {
    // A bare Promise.race would leave the losing deadline timer armed for the
    // rest of the run, which jest reports as an open handle.
    return new Promise<Exit>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`the peer did not exit within ${timeoutMs} ms`)),
        timeoutMs,
      )
      void this.exited.then(exit => {
        clearTimeout(timer)
        resolve(exit)
      })
    })
  }

  /** Contain a failing case: never leave a child process behind. */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.isRunning()) {
      this.child.kill('SIGKILL')
      await this.exited
    }
  }
}

function parseFrame(line: string): Record<string, any> {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new Error(`stdout carried a line that is not JSON: ${JSON.stringify(line)}`)
  }
  if ((value as { jsonrpc?: unknown } | null)?.jsonrpc !== '2.0') {
    throw new Error(`stdout carried a payload that is not JSON-RPC 2.0: ${JSON.stringify(line)}`)
  }
  return value as Record<string, any>
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const peers: RawStdioPeer[] = []
const directories: string[] = []

async function makePeer(env: NodeJS.ProcessEnv = {}): Promise<RawStdioPeer> {
  const directory = await mkdtemp(path.join(tmpdir(), 'garmin-stdio-protocol-'))
  directories.push(directory)
  const peer = new RawStdioPeer(directory, {
    GARMIN_USERNAME: USERNAME,
    GARMIN_PASSWORD: PASSWORD,
    GARMIN_REGION: 'cn',
    GARMIN_SESSION_TOKEN_FILE: path.join(directory, 'session.json'),
    GARMIN_STATE_DIR: path.join(directory, 'state'),
    ...env,
  })
  peers.push(peer)
  return peer
}

afterEach(async () => {
  await Promise.all(peers.splice(0).map(peer => peer.stop()))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('stdlib stdio protocol and secrets boundary', () => {
  it('writes nothing but JSON-RPC to stdout and never echoes credentials on stderr', async () => {
    const peer = await makePeer()
    await peer.handshake()

    peer.send({ id: 2, method: 'tools/list' })
    peer.send({ id: 3, method: 'tools/call', params: { name: 'get_garmin_profile', arguments: {} } })
    await peer.waitFor(
      self => self.frames().some(frame => frame.id === 3),
      'the tools/call response',
    )

    const frames = peer.frames()
    expect(frames.map(frame => frame.id)).toEqual([1, 2, 3])
    expect(frames[1]?.result?.tools).toHaveLength(18)
    // A configured account that cannot sign in fails as a sign-in, and the
    // failure text is a fixed message rather than whatever the SDK raised.
    // tests/stdio.test.ts covers the other branch: with no configured account
    // the response points at the independent `garmin-connect-auth serve` command.
    expect(frames[2]?.result?.isError).toBe(true)
    expect(JSON.parse(frames[2]!.result.content[0].text)).toMatchObject({
      error: true,
      message: 'Garmin password sign-in did not complete; check email, region, and password',
    })

    // A password sign-in was attempted and failed; neither the address nor the
    // password may appear anywhere the host can read.
    expect(peer.standardOutput).not.toContain(USERNAME)
    expect(peer.standardOutput).not.toContain(PASSWORD)
    expect(peer.standardError).not.toContain(USERNAME)
    expect(peer.standardError).not.toContain(PASSWORD)
    expect(peer.standardError).toContain('[garmin-connect-mcp] Server started')

    peer.endInput()
    await expect(peer.waitForExit()).resolves.toEqual({ code: 0, signal: null })
  }, CASE_TIMEOUT_MS)

  it('redirects upstream console noise to redacted stderr instead of stdout', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'garmin-stdio-noise-'))
    directories.push(directory)
    const injector = path.join(directory, 'upstream-noise.cjs')
    // Emulates what the upstream Garmin client actually does: it calls
    // console.log with scalar text and with AxiosError objects whose enumerable
    // properties carry the request headers.
    await writeFile(injector, [
      "'use strict'",
      'setTimeout(() => {',
      "  console.log('upstream-noise-marker', 'login page title:', { title: 'GARMIN' })",
      '  const axiosError = Object.assign(new Error("Request failed with status code 401"), {',
      '    isAxiosError: true,',
      `    config: { headers: { Authorization: 'Bearer ${BEARER_TOKEN}', Cookie: '${COOKIE_VALUE}' } },`,
      '  })',
      "  console.log('err:', axiosError)",
      `  console.error('upstream password ' + (process.env.GARMIN_PASSWORD || '') + ' seen')`,
      '}, 400)',
      '',
    ].join('\n'))

    // The preload only schedules the noise; it fires well after the entry point
    // has taken ownership of the console, which is the window being tested.
    const peer = await makePeer({
      NODE_OPTIONS: `--require ${quoteForNodeOptions(injector)}`,
    })
    await peer.handshake()
    await peer.waitFor(
      self => self.standardError.includes('upstream-noise-marker'),
      'the injected upstream noise on stderr',
    )
    // The injector emits its three lines from one callback, but they reach the
    // pipe one write at a time. Sync on the last line before asserting on the
    // whole buffer, or a slower run reads the buffer mid-flush and reports a
    // redaction failure that is really a missing write.
    await peer.waitFor(
      self => self.standardError.includes('upstream password'),
      'the injected password line on stderr',
    )

    // stdout stays reserved: one frame, and it is the handshake.
    expect(peer.stdoutLines()).toHaveLength(1)
    expect(peer.frames()[0]?.id).toBe(1)
    expect(peer.standardOutput).not.toContain('upstream-noise-marker')

    const stderr = peer.standardError
    expect(stderr).toContain('[garmin-connect upstream] upstream-noise-marker')
    // Structured values are dropped outright, so headers cannot ride along.
    expect(stderr).toContain('[structured value omitted]')
    expect(stderr).not.toContain(BEARER_TOKEN)
    expect(stderr).not.toContain(COOKIE_VALUE)
    expect(stderr).not.toContain('Bearer ')
    // The configured password is redacted, not merely absent.
    expect(stderr).toContain('upstream password [REDACTED] seen')
    expect(stderr).not.toContain(PASSWORD)

    peer.endInput()
    await expect(peer.waitForExit()).resolves.toEqual({ code: 0, signal: null })
  }, CASE_TIMEOUT_MS)

  it('answers a cancelled request without wedging, and closes after it', async () => {
    const peer = await makePeer()
    await peer.handshake()

    // The cancel notification races the call on purpose: whether the server
    // answers, drops or ignores request 9 is the SDK's business. What must hold
    // is that the peer is neither wedged nor able to write non-protocol output.
    peer.send({ id: 9, method: 'tools/call', params: { name: 'get_garmin_activities', arguments: { limit: 1 } } })
    peer.notify('notifications/cancelled', { requestId: 9, reason: 'stdio protocol case' })
    await delay(250)

    expect(peer.isRunning()).toBe(true)
    peer.send({ id: 10, method: 'tools/list' })
    await peer.waitFor(
      self => self.frames().some(frame => frame.id === 10 && frame.result !== undefined),
      'a fresh tools/list response after the cancellation',
    )
    expect(peer.frames().find(frame => frame.id === 10)?.result?.tools).toHaveLength(18)

    peer.endInput()
    await expect(peer.waitForExit()).resolves.toEqual({ code: 0, signal: null })
  }, CASE_TIMEOUT_MS)

  it('treats disconnect and termination signals as bounded shutdown requests', async () => {
    const paths: Array<{ label: string; stop: (peer: RawStdioPeer) => void; expected: Exit }> = [
      { label: 'stdin EOF', stop: peer => peer.endInput(), expected: { code: 0, signal: null } },
      { label: 'stdin destroyed', stop: peer => peer.childStdinDestroy(), expected: { code: 0, signal: null } },
      { label: 'SIGTERM', stop: peer => peer.signal('SIGTERM'), expected: { code: 143, signal: null } },
      { label: 'SIGINT', stop: peer => peer.signal('SIGINT'), expected: { code: 130, signal: null } },
      { label: 'SIGHUP', stop: peer => peer.signal('SIGHUP'), expected: { code: 129, signal: null } },
    ]

    for (const path of paths) {
      const peer = await makePeer()
      await peer.handshake()
      const started = Date.now()
      path.stop(peer)
      // Each path is asserted individually: a single shared deadline would let a
      // regression in one of them hide behind the others.
      const exit = await peer.waitForExit(EXIT_DEADLINE_MS)
      expect({ label: path.label, exit }).toEqual({ label: path.label, exit: path.expected })
      expect(Date.now() - started).toBeLessThan(EXIT_DEADLINE_MS)
      // The startup notice belongs on stderr; its presence on stdout would mean
      // the guard was not installed before the server came up.
      expect(peer.standardError).toContain('[garmin-connect-mcp] Server started')
      expect(peer.standardOutput).not.toContain('Server started')
    }
  }, CASE_TIMEOUT_MS)

  it('terminates with a schedule request still in flight and leaves nothing behind', async () => {
    const peer = await makePeer()
    await peer.handshake()
    // Unanswerable in this environment: account access fails, so the request is
    // still open when the host gives up on the process.
    peer.send({
      id: 20,
      method: 'tools/call',
      params: {
        name: 'batch_schedule_garmin_workouts',
        arguments: {
          schedules: [
            { workoutId: '1', date: '2099-03-01' },
            { workoutId: '1', date: '2099-03-02' },
          ],
        },
      },
    })
    await delay(60)
    peer.signal('SIGTERM')

    const exit = await peer.waitForExit()
    expect(exit).toEqual({ code: 143, signal: null })
    // Cutting a request short may drop its answer, but it must never turn into
    // non-protocol output or a credential leak on the way out.
    expect(() => peer.frames()).not.toThrow()
    expect(peer.standardOutput).not.toContain(PASSWORD)
    expect(peer.standardError).not.toContain(PASSWORD)
    expect(peer.isRunning()).toBe(false)
  }, CASE_TIMEOUT_MS)
})

/** Node splits NODE_OPTIONS on whitespace, so a spaced path needs quoting. */
function quoteForNodeOptions(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value
}

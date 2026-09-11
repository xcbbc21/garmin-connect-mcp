import { spawn, type ChildProcess } from 'node:child_process'
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileAccountLock, type LockFileSystem } from '../src/write-operations/lock'
import { GarminWriteError, WRITE_ERROR_CODES } from '../src/write-operations/errors'

const CANCELLED = 'Waiting for the account write lock was cancelled; no new write was sent'

function tick(ms = 20): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const WORKER = join(__dirname, 'fixtures', 'write-lock-worker.ts')
const ACCOUNT = 'lock-account'
/** Upper bound on a whole fixture run, so a hung child fails instead of stalling the suite. */
const WORKER_EXIT_TIMEOUT_MS = 20_000

type WorkerEventName = 'ready' | 'start' | 'end' | 'busy' | 'error' | 'signal' | 'timeout'

interface WorkerEvent {
  event: WorkerEventName
  pid: number
  t: number
  message?: string
}

interface WorkerHandle {
  child: ChildProcess
  exit: Promise<number | null>
}

interface WorkerOptions {
  /** Override the executable, so a spawn that cannot start is testable. */
  command?: string
  /** Override the account argument, so a credential can be passed through argv. */
  account?: string
  /** Child environment additions, e.g. a shortened watchdog budget. */
  env?: NodeJS.ProcessEnv
  /** How long the parent waits before killing a child that never exits. */
  timeoutMs?: number
}

/**
 * Start the fixture and resolve with both the process and its exit code.
 *
 * Every way the child can fail becomes a rejection, because a parent test must
 * never mistake "the child never got anywhere" for "the child finished": a
 * spawn failure, a signal, an unexpected exit code, and a child that simply
 * never exits are all failures of the fixture run.
 */
function startWorker(
  stateDir: string,
  holdMs: number,
  waitMs: number,
  eventsFile: string,
  options: WorkerOptions = {},
): WorkerHandle {
  const timeoutMs = options.timeoutMs ?? WORKER_EXIT_TIMEOUT_MS
  const child = spawn(
    options.command ?? process.execPath,
    [
      '--import',
      'tsx',
      WORKER,
      stateDir,
      options.account ?? ACCOUNT,
      String(holdMs),
      String(waitMs),
      eventsFile,
    ],
    {
      cwd: join(__dirname, '..'),
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, ...options.env },
    },
  )

  const exit = new Promise<number | null>((resolve, reject) => {
    let stderr = ''
    let settled = false
    let timer: NodeJS.Timeout | undefined

    const finish = (action: () => void): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      action()
    }

    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', error => {
      finish(() => reject(new Error(`worker could not start: ${error.message}`)))
    })
    child.on('close', (code, signal) => {
      finish(() => {
        // A killed child reports a signal and a null code; neither is a result.
        if (signal !== null) {
          reject(new Error(`worker was killed by ${signal}; stderr: ${stderr.trim()}`))
          return
        }
        if (code === 0 || code === 3) {
          resolve(code)
          return
        }
        reject(new Error(`worker exited with code ${String(code)}; stderr: ${stderr.trim()}`))
      })
    })
    timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(() => reject(new Error(`worker did not exit within ${timeoutMs}ms; stderr: ${stderr.trim()}`)))
    }, timeoutMs)
  })

  return { child, exit }
}

function runWorker(
  stateDir: string,
  holdMs: number,
  waitMs: number,
  eventsFile: string,
  options: WorkerOptions = {},
): Promise<number | null> {
  return startWorker(stateDir, holdMs, waitMs, eventsFile, options).exit
}

async function readEvents(eventsFile: string): Promise<WorkerEvent[]> {
  const raw = await readFile(eventsFile, 'utf8').catch(() => '')
  return raw.split('\n').filter(Boolean).map(line => JSON.parse(line) as WorkerEvent)
}

/** The message a run rejected with; fails the test if it resolved instead. */
async function rejectionMessage(run: Promise<unknown>): Promise<string> {
  const settled = await run.then(
    value => ({ resolved: value }),
    (error: unknown) => ({ rejected: error }),
  )
  if ('resolved' in settled) {
    throw new Error(`expected the run to fail, but it resolved with ${String(settled.resolved)}`)
  }
  return settled.rejected instanceof Error ? settled.rejected.message : String(settled.rejected)
}

/**
 * Wait for the child to report its own progress.
 *
 * A fixed sleep only guesses that a child got as far as acquiring the lock;
 * this waits for the event the child records *inside* the critical section. If
 * the child settles first the handshake fails loudly, so a handshake that can
 * never succeed cannot be mistaken for a working one.
 */
async function waitForEvent(
  eventsFile: string,
  event: WorkerEventName,
  child: Promise<number | null>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let code: number | null | undefined
  let failure: unknown
  void child.then(
    value => { code = value },
    error => { failure = error },
  )

  for (;;) {
    if (failure !== undefined) throw failure
    if (code !== undefined) {
      throw new Error(`worker exited with code ${String(code)} before reporting "${event}"`)
    }
    if ((await readEvents(eventsFile)).some(candidate => candidate.event === event)) return
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for "${event}"`)
    }
    await tick(5)
  }
}

describe('FileAccountLock', () => {
  let base: string

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'garmin-lock-'))
  })

  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  it('serializes two real processes without overlapping critical sections', async () => {
    const eventsFile = join(base, 'events.jsonl')
    await writeFile(eventsFile, '', 'utf8')
    const [first, second] = await Promise.all([
      runWorker(base, 250, 5_000, eventsFile),
      runWorker(base, 250, 5_000, eventsFile),
    ])

    expect(first).toBe(0)
    expect(second).toBe(0)

    const events = await readEvents(eventsFile)
    const ordered = [...events].sort((a, b) => a.t - b.t)
    const starts = events.filter(event => event.event === 'start')
    const ends = events.filter(event => event.event === 'end')
    expect(starts).toHaveLength(2)
    expect(ends).toHaveLength(2)
    expect(new Set(starts.map(event => event.pid)).size).toBe(2)

    // `ready` is recorded before the lock is attempted and `start` only inside
    // the critical section, so this ordering is what a parent handshake rests
    // on: waiting for `start` cannot be satisfied by a child that is merely up.
    for (const pid of new Set(starts.map(event => event.pid))) {
      const mine = ordered.filter(event => event.pid === pid)
      expect(mine.findIndex(event => event.event === 'ready'))
        .toBeLessThan(mine.findIndex(event => event.event === 'start'))
    }

    // No critical section may begin before the previous one has ended.
    let active = 0
    for (const event of ordered) {
      active += event.event === 'start' ? 1 : event.event === 'end' ? -1 : 0
      expect(active).toBeLessThanOrEqual(1)
    }
  })

  it('returns OPERATION_BUSY rather than waiting forever behind a held lock', async () => {
    const eventsFile = join(base, 'events.jsonl')
    await writeFile(eventsFile, '', 'utf8')

    const holder = startWorker(base, 3_000, 10_000, eventsFile)
    // The handshake below reports the holder's own failure; this handler only
    // keeps that rejection from also surfacing as unhandled.
    holder.exit.catch(() => undefined)
    // A handshake, not a fixed sleep: `start` is recorded while the holder owns
    // the lock, so the contender provably meets a held lock. Guessing with a
    // sleep would let a slow start turn this into a lock nobody holds.
    await waitForEvent(eventsFile, 'start', holder.exit)
    const contender = await runWorker(base, 0, 250, eventsFile)
    expect(await holder.exit).toBe(0)

    expect(contender).toBe(3)
    expect((await readEvents(eventsFile)).some(event => event.event === 'busy')).toBe(true)
  })

  it('fails the handshake when the child exits before it ever holds the lock', async () => {
    const lock = new FileAccountLock(base, ACCOUNT)
    await mkdir(lock.path, { recursive: true, mode: 0o700 })
    await writeFile(
      join(lock.path, 'owner.json'),
      JSON.stringify({ ownerToken: 'foreign', pid: 1, startedAt: '2000-01-01T00:00:00.000Z' }),
      'utf8',
    )
    const eventsFile = join(base, 'events.jsonl')
    await writeFile(eventsFile, '', 'utf8')

    const worker = startWorker(base, 0, 200, eventsFile)
    worker.exit.catch(() => undefined)

    // A parent that slept here would cheerfully contend against a lock nobody
    // holds; waiting for `start` turns that into a visible failure.
    await expect(waitForEvent(eventsFile, 'start', worker.exit)).rejects.toThrow(
      /exited with code 3 before reporting "start"/,
    )
    // It really did start and really did give up on a held lock.
    expect((await readEvents(eventsFile)).map(event => event.event)).toEqual(['ready', 'busy'])
    expect(await worker.exit).toBe(3)
  })

  it('surfaces an unexpected worker exit with redacted stderr and a redacted event', async () => {
    const eventsFile = join(base, 'events.jsonl')
    await writeFile(eventsFile, '', 'utf8')
    const secret = 'Bearer super-secret-token'

    // An empty state directory is refused before any lock work, and the
    // credential travels as an argument, so the diagnostic can only be safe if
    // it is redacted on the way out — the fixture quotes its own inputs.
    const message = await rejectionMessage(runWorker('', 0, 100, eventsFile, { account: secret }))

    expect(message).toContain('exited with code 4')
    expect(message).toContain('Bearer [REDACTED]')
    expect(message).not.toContain('super-secret-token')

    const events = await readEvents(eventsFile)
    expect(events.map(event => event.event)).toEqual(['error'])
    expect(events[0].message).toContain('Bearer [REDACTED]')
    expect(JSON.stringify(events)).not.toContain('super-secret-token')
  })

  it('kills a worker that outlives the parent timeout and reports it', async () => {
    const eventsFile = join(base, 'events.jsonl')
    await writeFile(eventsFile, '', 'utf8')

    const worker = startWorker(base, 5_000, 5_000, eventsFile, { timeoutMs: 400 })
    worker.exit.catch(() => undefined)
    // Proves the timeout really interrupted a run that owned the lock, rather
    // than a child that had not got anywhere.
    await waitForEvent(eventsFile, 'start', worker.exit)

    const message = await rejectionMessage(worker.exit)
    expect(message).toContain('did not exit within 400ms')
  })

  it('reports a worker that never finishes instead of waiting forever', async () => {
    const eventsFile = join(base, 'events.jsonl')
    await writeFile(eventsFile, '', 'utf8')

    // The fixture's own watchdog, shortened so this test does not wait 30 s.
    const message = await rejectionMessage(
      runWorker(base, 5_000, 5_000, eventsFile, { env: { GARMIN_LOCK_WORKER_WATCHDOG_MS: '300' } }),
    )

    expect(message).toContain('exited with code 5')
    expect(message).toContain('the run did not finish within 300ms')
    expect((await readEvents(eventsFile)).some(event => event.event === 'timeout')).toBe(true)
  })

  it('reports a worker that could not start at all', async () => {
    const eventsFile = join(base, 'events.jsonl')
    await writeFile(eventsFile, '', 'utf8')

    const message = await rejectionMessage(
      runWorker(base, 0, 100, eventsFile, { command: join(base, 'no-such-node') }),
    )

    expect(message).toContain('worker could not start')
    expect(await readEvents(eventsFile)).toEqual([])
  })

  it('surfaces a holder that is killed while it owns the lock', async () => {
    const eventsFile = join(base, 'events.jsonl')
    await writeFile(eventsFile, '', 'utf8')

    const worker = startWorker(base, 5_000, 5_000, eventsFile)
    worker.exit.catch(() => undefined)
    await waitForEvent(eventsFile, 'start', worker.exit)

    worker.child.kill('SIGTERM')

    // POSIX runs the fixture's own signal handler, which reports exit code 4;
    // Windows terminates the process outright. Whichever happens, an
    // interrupted holder must be a failure the parent can see, never a run
    // that looks like it completed.
    const message = await rejectionMessage(worker.exit)
    expect(message).toMatch(/killed by|exited with code/)
    expect((await readEvents(eventsFile)).some(event => event.event === 'start')).toBe(true)
  })

  it('never preempts a stale lock left by an interrupted owner', async () => {
    const lock = new FileAccountLock(base, ACCOUNT)
    const ownerFile = join(lock.path, 'owner.json')
    await mkdir(lock.path, { recursive: true, mode: 0o700 })
    const staleOwner = { ownerToken: 'stale-token', pid: 999_999, startedAt: '2000-01-01T00:00:00.000Z' }
    await writeFile(ownerFile, JSON.stringify(staleOwner), 'utf8')

    const eventsFile = join(base, 'events.jsonl')
    await writeFile(eventsFile, '', 'utf8')
    const contender = await runWorker(base, 0, 200, eventsFile)

    expect(contender).toBe(3)
    // The stale lock survives; it is cleared only by the documented offline step.
    await expect(readFile(ownerFile, 'utf8')).resolves.toContain('stale-token')
  })

  it('does not let a non-owner release the lock', async () => {
    const lock = new FileAccountLock(base, ACCOUNT, undefined, { waitTimeoutMs: 30 })
    const ownerFile = join(lock.path, 'owner.json')
    await mkdir(lock.path, { recursive: true, mode: 0o700 })
    await writeFile(ownerFile, JSON.stringify({ ownerToken: 'foreign', pid: 1, startedAt: 'x' }), 'utf8')

    await expect(lock.runExclusive(async () => 'never')).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.OPERATION_BUSY,
    })
    await expect(readFile(ownerFile, 'utf8')).resolves.toContain('foreign')
  })

  it('releases the lock so a later holder can acquire it', async () => {
    const lock = new FileAccountLock(base, ACCOUNT)
    await expect(lock.runExclusive(async () => 'first')).resolves.toBe('first')
    await expect(new FileAccountLock(base, ACCOUNT).runExclusive(async () => 'second'))
      .resolves.toBe('second')
  })

  it('rejects a relative state root', () => {
    expect(() => new FileAccountLock('relative', ACCOUNT)).toThrow(GarminWriteError)
  })

  // -------------------------------------------------------------------------
  // Cancellable waiting (C4). Giving up on the wait is always a provable
  // non-application, because the lock is acquired strictly before a dispatch.
  // -------------------------------------------------------------------------

  it('fails fast on an already-cancelled request without creating the lock', async () => {
    const lock = new FileAccountLock(base, ACCOUNT)
    const controller = new AbortController()
    controller.abort()

    await expect(lock.runExclusive(async () => 'never', { signal: controller.signal }))
      .rejects.toMatchObject({
        code: WRITE_ERROR_CODES.WRITE_NOT_APPLIED,
        message: expect.stringContaining(CANCELLED) as unknown as string,
      })
    // Nothing was taken, so nothing was leaked for the next process to clear.
    await expect(lstat(lock.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('stops waiting for a foreign holder when the signal aborts', async () => {
    const lock = new FileAccountLock(base, ACCOUNT, undefined, { waitTimeoutMs: 5_000, pollIntervalMs: 10 })
    await mkdir(lock.path, { recursive: true, mode: 0o700 })
    await writeFile(
      join(lock.path, 'owner.json'),
      JSON.stringify({ ownerToken: 'foreign', pid: 1, startedAt: '2000-01-01T00:00:00.000Z' }),
      'utf8',
    )

    const controller = new AbortController()
    const started = Date.now()
    const waiting = lock.runExclusive(async () => 'never', { signal: controller.signal })
    setTimeout(() => controller.abort(), 30)
    await expect(waiting).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.WRITE_NOT_APPLIED,
      message: expect.stringContaining(CANCELLED) as unknown as string,
    })
    // Cancelled well inside the 5 s budget; the foreign lock is untouched.
    expect(Date.now() - started).toBeLessThan(1_000)
    await expect(readFile(join(lock.path, 'owner.json'), 'utf8')).resolves.toContain('foreign')
  })

  it('never abandons a task that already holds the lock', async () => {
    const lock = new FileAccountLock(base, ACCOUNT)
    const controller = new AbortController()

    const result = await lock.runExclusive(async () => {
      // By now the write may be in flight, so the signal must not stop it.
      controller.abort()
      return 'finished'
    }, { signal: controller.signal })

    expect(result).toBe('finished')
    await expect(lock.runExclusive(async () => 'next')).resolves.toBe('next')
  })

  it('gives up while a same-process holder still holds the lock', async () => {
    const lock = new FileAccountLock(base, ACCOUNT, undefined, { waitTimeoutMs: 150, pollIntervalMs: 10 })
    let holderDone = false
    const holding = lock.runExclusive(async () => {
      await tick(500)
      holderDone = true
    })
    await tick()

    const started = Date.now()
    await expect(lock.runExclusive(async () => 'never')).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.OPERATION_BUSY,
    })
    // The in-process queue and the on-disk lock share ONE budget: the second
    // caller may not silently wait for the holder to finish.
    expect(holderDone).toBe(false)
    expect(Date.now() - started).toBeLessThan(450)

    await holding
  })

  it('lets the next waiter inherit a fresh budget after a cancelled waiter', async () => {
    const lock = new FileAccountLock(base, ACCOUNT, undefined, { waitTimeoutMs: 500, pollIntervalMs: 10 })
    let release!: () => void
    const holding = lock.runExclusive(() => new Promise<void>(resolve => { release = resolve }))
    await tick()

    const controller = new AbortController()
    const cancelled = lock.runExclusive(async () => 'never', { signal: controller.signal })
    controller.abort()
    await expect(cancelled).rejects.toMatchObject({ code: WRITE_ERROR_CODES.WRITE_NOT_APPLIED })

    release()
    await holding
    // A queued entry nobody will use must not delay or deadlock the queue.
    await expect(lock.runExclusive(async () => 'after')).resolves.toBe('after')
  })

  it('shares the budget with the caller-supplied wait timeout', async () => {
    const lock = new FileAccountLock(base, ACCOUNT, undefined, { waitTimeoutMs: 60, pollIntervalMs: 10 })
    let release!: () => void
    const holding = lock.runExclusive(() => new Promise<void>(resolve => { release = resolve }))
    await tick()

    await expect(lock.runExclusive(async () => 'never')).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.OPERATION_BUSY,
    })
    release()
    await holding
  })

  // -------------------------------------------------------------------------
  // Contention evidence (C10). A refused exclusive create and the follow-up
  // existence check are two separate observations, and a holder can release
  // between them. Both observations describe the same instant differently, so
  // the decision must not rest on the racy one alone.
  // -------------------------------------------------------------------------

  it('treats a refused exclusive create as contention when the holder releases before the check', async () => {
    const fake = contentionThenRelease()

    const lock = new FileAccountLock(base, ACCOUNT, fake.fs, {
      waitTimeoutMs: 1_000,
      pollIntervalMs: 5,
    })
    // The create was refused by a live holder, and by the time the existence
    // check would have run the lock was gone. Retrying is correct: nothing was
    // sent, and the very next create wins.
    await expect(lock.runExclusive(async () => 'acquired')).resolves.toBe('acquired')
    expect(fake.creates()).toBe(2)
    // The racy check is not consulted at all once the create itself proves
    // contention, which is what removes the window.
    expect(fake.existenceChecks()).toBe(0)
  })

  it('still fails closed when the create fails for a reason that is not contention', async () => {
    const fake = refusingCreate('EACCES')

    const lock = new FileAccountLock(base, ACCOUNT, fake.fs, {
      waitTimeoutMs: 1_000,
      pollIntervalMs: 5,
    })
    // A storage failure is not a waiter: it must never be retried into a
    // dispatch, and the caller must be told the state is unusable.
    await expect(lock.runExclusive(async () => 'never')).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_UNAVAILABLE,
      message: expect.stringContaining('EACCES') as unknown as string,
    })
    expect(fake.writes()).toEqual([])
  })
})

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: injected`), { code })
}

/**
 * Models the exact interleaving behind the spurious `STATE_UNAVAILABLE`: the
 * exclusive create is refused while a holder owns the lock, and the holder
 * releases before the follow-up existence check observes anything.
 */
function contentionThenRelease(): {
  fs: LockFileSystem
  creates: () => number
  existenceChecks: () => number
} {
  let creates = 0
  let existenceChecks = 0
  const files = new Map<string, string>()
  const fs: LockFileSystem = {
    mkdir: async (_path, options) => {
      if (options.recursive) return
      creates += 1
      if (creates === 1) throw errno('EEXIST')
    },
    writeFile: async (path, data) => { files.set(path, data) },
    readFile: async path => {
      const value = files.get(path)
      if (value === undefined) throw errno('ENOENT')
      return value
    },
    unlink: async path => { files.delete(path) },
    rmdir: async () => undefined,
    lstat: async () => {
      existenceChecks += 1
      throw errno('ENOENT')
    },
  }
  return { fs, creates: () => creates, existenceChecks: () => existenceChecks }
}

function refusingCreate(code: string): { fs: LockFileSystem; writes: () => string[] } {
  const written: string[] = []
  const fs: LockFileSystem = {
    mkdir: async (_path, options) => {
      if (!options.recursive) throw errno(code)
    },
    writeFile: async path => { written.push(path) },
    readFile: async () => { throw errno('ENOENT') },
    unlink: async () => undefined,
    rmdir: async () => undefined,
    lstat: async () => { throw errno('ENOENT') },
  }
  return { fs, writes: () => written }
}

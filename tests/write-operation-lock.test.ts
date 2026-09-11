import { spawn } from 'node:child_process'
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileAccountLock } from '../src/write-operations/lock'
import { GarminWriteError, WRITE_ERROR_CODES } from '../src/write-operations/errors'

const CANCELLED = 'Waiting for the account write lock was cancelled; no new write was sent'

function tick(ms = 20): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const WORKER = join(__dirname, 'fixtures', 'write-lock-worker.ts')
const ACCOUNT = 'lock-account'

interface WorkerEvent {
  event: 'start' | 'end' | 'busy' | 'error'
  pid: number
  t: number
}

function runWorker(
  stateDir: string,
  holdMs: number,
  waitMs: number,
  eventsFile: string,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', WORKER, stateDir, ACCOUNT, String(holdMs), String(waitMs), eventsFile],
      { cwd: join(__dirname, '..'), stdio: ['ignore', 'ignore', 'pipe'] },
    )
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 4) reject(new Error(`worker failed: ${stderr}`))
      else resolve(code)
    })
  })
}

async function readEvents(eventsFile: string): Promise<WorkerEvent[]> {
  const raw = await readFile(eventsFile, 'utf8').catch(() => '')
  return raw.split('\n').filter(Boolean).map(line => JSON.parse(line) as WorkerEvent)
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
    const starts = events.filter(event => event.event === 'start')
    const ends = events.filter(event => event.event === 'end')
    expect(starts).toHaveLength(2)
    expect(ends).toHaveLength(2)
    expect(new Set(starts.map(event => event.pid)).size).toBe(2)

    // No critical section may begin before the previous one has ended.
    let active = 0
    for (const event of [...events].sort((a, b) => a.t - b.t)) {
      active += event.event === 'start' ? 1 : event.event === 'end' ? -1 : 0
      expect(active).toBeLessThanOrEqual(1)
    }
  })

  it('returns OPERATION_BUSY rather than waiting forever behind a held lock', async () => {
    const eventsFile = join(base, 'events.jsonl')
    await writeFile(eventsFile, '', 'utf8')

    const holder = runWorker(base, 1_500, 5_000, eventsFile)
    await new Promise(resolve => setTimeout(resolve, 250))
    const contender = await runWorker(base, 0, 250, eventsFile)
    await holder

    expect(contender).toBe(3)
    expect((await readEvents(eventsFile)).some(event => event.event === 'busy')).toBe(true)
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
})

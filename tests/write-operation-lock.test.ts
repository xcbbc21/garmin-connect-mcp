import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileAccountLock } from '../src/write-operations/lock'
import { GarminWriteError, WRITE_ERROR_CODES } from '../src/write-operations/errors'

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
})

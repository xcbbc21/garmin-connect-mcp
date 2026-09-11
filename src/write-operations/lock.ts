/**
 * Account-level exclusive lock.
 *
 * The lock is a directory created atomically with `mkdir`, the portable
 * atomic-exclusive primitive on POSIX and Windows. It carries an owner token
 * so a non-owner can never release it, and it deliberately has NO time-based
 * preemption: a paused holder may still be about to write, and without server
 * fencing an expired TTL does not make takeover safe. A stale lock must be
 * removed by the documented offline procedure, never automatically.
 */

import { promises as nodeFs } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { GarminWriteError, WRITE_ERROR_CODES } from './errors'

export interface AccountLock {
  runExclusive<T>(task: () => Promise<T>): Promise<T>
}

export interface LockStat {
  isDirectory(): boolean
  isFile(): boolean
}

export interface LockFileSystem {
  mkdir(path: string, options: { recursive: boolean; mode: number }): Promise<void>
  writeFile(path: string, data: string, options: { mode: number }): Promise<void>
  readFile(path: string, encoding: 'utf8'): Promise<string>
  unlink(path: string): Promise<void>
  rmdir(path: string): Promise<void>
  lstat(path: string): Promise<LockStat>
}

export interface AccountLockOptions {
  /** Total time to wait for the lock before returning OPERATION_BUSY. */
  waitTimeoutMs?: number
  /** Poll interval while waiting for a held lock. */
  pollIntervalMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface LockOwner {
  ownerToken: string
  pid: number
  startedAt: string
}

const DEFAULT_WAIT_TIMEOUT_MS = 5_000
const DEFAULT_POLL_INTERVAL_MS = 50

export const nodeLockFileSystem: LockFileSystem = {
  mkdir: (path, options) => nodeFs.mkdir(path, options).then(() => undefined),
  writeFile: (path, data, options) => nodeFs.writeFile(path, data, options),
  readFile: (path, encoding) => nodeFs.readFile(path, encoding),
  unlink: (path) => nodeFs.unlink(path),
  rmdir: (path) => nodeFs.rmdir(path),
  lstat: (path) => nodeFs.lstat(path),
}

const defaultFileSystem: LockFileSystem = nodeLockFileSystem

export class FileAccountLock implements AccountLock {
  private readonly lockDirectory: string
  private readonly ownerFile: string
  private readonly waitTimeoutMs: number
  private readonly pollIntervalMs: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  /** In-process queue so two callers in one process never race the file lock. */
  private tail: Promise<void> = Promise.resolve()

  constructor(
    stateDirectory: string,
    accountKey: string,
    private readonly fs: LockFileSystem = defaultFileSystem,
    options: AccountLockOptions = {},
  ) {
    if (!isAbsolute(stateDirectory)) {
      throw new GarminWriteError(
        WRITE_ERROR_CODES.STATE_UNAVAILABLE,
        'not_applied',
        'Lock state directory must be an absolute path',
      )
    }
    const root = join(resolve(stateDirectory), accountKey)
    this.lockDirectory = join(root, 'write.lock')
    this.ownerFile = join(this.lockDirectory, 'owner.json')
    this.waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? defaultSleep
  }

  get path(): string {
    return this.lockDirectory
  }

  /** Read the current owner record for diagnostics only; never used to take over. */
  async readOwner(): Promise<LockOwner | undefined> {
    try {
      const raw = await this.fs.readFile(this.ownerFile, 'utf8')
      const parsed = JSON.parse(raw) as LockOwner
      return typeof parsed?.ownerToken === 'string' ? parsed : undefined
    } catch {
      return undefined
    }
  }

  async runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let releaseQueue!: () => void
    this.tail = new Promise<void>(resolve => { releaseQueue = resolve })
    await previous.catch(() => undefined)

    const ownerToken = randomUUID()
    try {
      await this.acquire(ownerToken)
      try {
        return await task()
      } finally {
        await this.release(ownerToken)
      }
    } finally {
      releaseQueue()
    }
  }

  private async acquire(ownerToken: string): Promise<void> {
    await this.fs.mkdir(dirname(this.lockDirectory), { recursive: true, mode: 0o700 })
      .catch(() => undefined)
    const deadline = this.now() + this.waitTimeoutMs

    for (;;) {
      try {
        await this.fs.mkdir(this.lockDirectory, { recursive: false, mode: 0o700 })
      } catch (error) {
        // Decide contention from evidence, not from a single error code: if the
        // lock directory exists we are simply contending; otherwise the create
        // genuinely failed and we must not send a write.
        if (!(await this.heldBySomeone())) {
          throw new GarminWriteError(
            WRITE_ERROR_CODES.STATE_UNAVAILABLE,
            'not_applied',
            `Write lock could not be created: ${describe(error)}`,
          )
        }
        if (this.now() >= deadline) {
          throw new GarminWriteError(
            WRITE_ERROR_CODES.OPERATION_BUSY,
            'not_applied',
            'Another request currently owns this account write lock; no new write was sent',
          )
        }
        await this.sleep(this.pollIntervalMs)
        continue
      }

      // The directory now exists and no one else can create it. Publish our
      // ownership before treating the lock as held.
      try {
        const owner: LockOwner = {
          ownerToken,
          pid: process.pid,
          startedAt: new Date().toISOString(),
        }
        await this.fs.writeFile(this.ownerFile, JSON.stringify(owner), { mode: 0o600 })
        return
      } catch {
        await this.forceRemove()
        throw new GarminWriteError(
          WRITE_ERROR_CODES.STATE_UNAVAILABLE,
          'not_applied',
          'Write lock ownership could not be recorded',
        )
      }
    }
  }

  private async heldBySomeone(): Promise<boolean> {
    try {
      const info = await this.fs.lstat(this.lockDirectory)
      return info.isDirectory() || info.isFile()
    } catch {
      return false
    }
  }

  private async release(ownerToken: string): Promise<void> {
    const owner = await this.readOwner()
    // Only the holder of the exact owner token may release. If the token cannot
    // be read we leak rather than risk releasing another process's lock: a
    // leaked lock blocks new writes (fail closed) and is cleared by the
    // documented offline recovery procedure.
    if (!owner || owner.ownerToken !== ownerToken) return
    try {
      await this.fs.unlink(this.ownerFile)
    } catch {
      // Fall through: the directory removal below is what matters.
    }
    try {
      await this.fs.rmdir(this.lockDirectory)
    } catch {
      // Already removed by an external recovery step.
    }
  }

  private async forceRemove(): Promise<void> {
    await this.fs.unlink(this.ownerFile).catch(() => undefined)
    await this.fs.rmdir(this.lockDirectory).catch(() => undefined)
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function describe(error: unknown): string {
  if (typeof error === 'object' && error !== null && typeof (error as { code?: string }).code === 'string') {
    return (error as { code: string }).code
  }
  return error instanceof Error ? error.name : 'unknown error'
}

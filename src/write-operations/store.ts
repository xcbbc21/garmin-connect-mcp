/**
 * Account-scoped, fail-closed operation journal.
 *
 * The store never touches the network and never silently repairs itself. Any
 * doubt (missing permissions, corrupt JSON, unknown schema, account mismatch,
 * projected size over the cap) becomes a typed error and the caller must not
 * proceed to a Garmin write. Every mutation is an atomic temp-write + fsync +
 * rename so a crash can never leave a truncated or empty journal behind.
 */

import { promises as nodeFs } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { GarminWriteError, WRITE_ERROR_CODES } from './errors'
import type { OperationDocument } from './types'
import { emptyOperationDocument } from './types'

/** 32 MiB: over this, new writes are blocked but the file stays readable. */
export const MAX_OPERATION_FILE_BYTES = 32 * 1024 * 1024

const OPERATION_FILE_NAME = 'operations.json'

export interface StoreFileHandle {
  write(data: string): Promise<void>
  sync(): Promise<void>
  close(): Promise<void>
}

export interface StoreStat {
  isFile(): boolean
  isSymbolicLink(): boolean
  size: number
}

/** The narrow filesystem surface the store needs; injectable for fault tests. */
export interface WriteStoreFileSystem {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<void>
  readFile(path: string, encoding: 'utf8'): Promise<string>
  open(path: string, flags: string, mode: number): Promise<StoreFileHandle>
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
  chmod(path: string, mode: number): Promise<void>
  lstat(path: string): Promise<StoreStat>
}

export interface SaveOptions {
  /**
   * When supplied, the on-disk revision must match exactly before the write is
   * committed. A mismatch means another writer advanced the journal and this
   * document is stale, so the save is refused instead of clobbering it.
   */
  expectedRevision?: number
}

export interface OperationStore {
  read(): Promise<OperationDocument>
  save(document: OperationDocument, options?: SaveOptions): Promise<void>
}

/** Real filesystem adapter; exported so tests can wrap and inject faults. */
export const nodeStoreFileSystem: WriteStoreFileSystem = {
  mkdir: (path, options) => nodeFs.mkdir(path, options).then(() => undefined),
  readFile: (path, encoding) => nodeFs.readFile(path, encoding),
  open: async (path, flags, mode) => {
    const handle = await nodeFs.open(path, flags, mode)
    return {
      write: async (data: string) => { await handle.writeFile(data, 'utf8') },
      sync: () => handle.sync(),
      close: () => handle.close(),
    }
  },
  rename: (from, to) => nodeFs.rename(from, to),
  unlink: (path) => nodeFs.unlink(path),
  chmod: (path, mode) => nodeFs.chmod(path, mode),
  lstat: (path) => nodeFs.lstat(path),
}

const defaultFileSystem: WriteStoreFileSystem = nodeStoreFileSystem

export class FileOperationStore implements OperationStore {
  private readonly root: string
  private readonly file: string

  constructor(
    stateDirectory: string,
    private readonly accountKey: string,
    private readonly fs: WriteStoreFileSystem = defaultFileSystem,
    private readonly randomSuffix: () => string = () => `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  ) {
    if (!isAbsolute(stateDirectory)) {
      throw new GarminWriteError(
        WRITE_ERROR_CODES.STATE_UNAVAILABLE,
        'not_applied',
        'GARMIN_STATE_DIR must be an absolute path',
      )
    }
    this.root = join(resolve(stateDirectory), accountKey)
    this.file = join(this.root, OPERATION_FILE_NAME)
  }

  get filePath(): string {
    return this.file
  }

  get directory(): string {
    return this.root
  }

  async read(): Promise<OperationDocument> {
    await this.assertSafePath()
    let raw: string
    try {
      raw = await this.fs.readFile(this.file, 'utf8')
    } catch (error) {
      if (isNotFound(error)) return emptyOperationDocument(this.accountKey)
      throw this.unavailable('Operation journal could not be read', error)
    }
    return this.parse(raw)
  }

  async save(document: OperationDocument, options: SaveOptions = {}): Promise<void> {
    if (document.accountKey !== this.accountKey) {
      throw new GarminWriteError(
        WRITE_ERROR_CODES.STATE_CORRUPT,
        'not_applied',
        'Refusing to persist an operation document for a different account',
      )
    }
    await this.assertSafePath()
    await this.fs.mkdir(this.root, { recursive: true, mode: 0o700 })
    try {
      await this.fs.chmod(this.root, 0o700)
    } catch {
      // Best effort: platforms without POSIX modes keep their default ACLs.
    }

    if (options.expectedRevision !== undefined) {
      const current = await this.read()
      if (current.revision !== options.expectedRevision) {
        throw new GarminWriteError(
          WRITE_ERROR_CODES.STATE_CORRUPT,
          'not_applied',
          'Operation journal changed concurrently; refusing a stale write',
        )
      }
    }

    const payload = `${JSON.stringify(document, null, 2)}\n`
    if (Buffer.byteLength(payload, 'utf8') > MAX_OPERATION_FILE_BYTES) {
      throw new GarminWriteError(
        WRITE_ERROR_CODES.STATE_UNAVAILABLE,
        'not_applied',
        'Operation journal exceeded the 32 MiB cap; archive it before new writes',
      )
    }

    const tempFile = join(this.root, `.operations.${this.randomSuffix()}.tmp`)
    let handle: StoreFileHandle | undefined
    let committed = false
    try {
      handle = await this.fs.open(tempFile, 'wx', 0o600)
      await handle.write(payload)
      await handle.sync()
      await handle.close()
      handle = undefined
      await this.fs.rename(tempFile, this.file)
      committed = true
      await this.syncDirectory()
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined)
      if (!committed) await this.fs.unlink(tempFile).catch(() => undefined)
      if (error instanceof GarminWriteError) throw error
      throw this.unavailable('Operation journal could not be committed', error)
    }
  }

  private async syncDirectory(): Promise<void> {
    // Directory fsync is not available on every platform (notably Windows);
    // failing to sync the directory must never corrupt an already-renamed file.
    try {
      const dir = await nodeFs.open(dirname(this.file), 'r')
      try {
        await dir.sync()
      } finally {
        await dir.close()
      }
    } catch {
      // Ignore: rename already made the new journal visible.
    }
  }

  private async assertSafePath(): Promise<void> {
    for (const target of [this.root, this.file]) {
      try {
        const info = await this.fs.lstat(target)
        if (info.isSymbolicLink()) {
          throw new GarminWriteError(
            WRITE_ERROR_CODES.STATE_CORRUPT,
            'not_applied',
            'Refusing to use a symlinked operation-journal path',
          )
        }
      } catch (error) {
        if (error instanceof GarminWriteError) throw error
        if (isNotFound(error)) continue
        throw this.unavailable('Operation-journal path could not be inspected', error)
      }
    }
  }

  private parse(raw: string): OperationDocument {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new GarminWriteError(
        WRITE_ERROR_CODES.STATE_CORRUPT,
        'not_applied',
        `Operation journal is not valid JSON: ${describe(error)}`,
      )
    }
    if (!isRecord(parsed)) {
      throw this.corrupt('Operation journal is not an object')
    }
    if (parsed.schemaVersion !== 1) {
      throw this.corrupt('Operation journal uses an unsupported schemaVersion')
    }
    if (parsed.accountKey !== this.accountKey) {
      throw this.corrupt('Operation journal belongs to a different account')
    }
    if (!Number.isInteger(parsed.revision) || (parsed.revision as number) < 0) {
      throw this.corrupt('Operation journal has an invalid revision')
    }
    if (!isRecord(parsed.operations) || !isRecord(parsed.idempotencyIndex)) {
      throw this.corrupt('Operation journal has an invalid shape')
    }
    return {
      schemaVersion: 1,
      revision: parsed.revision as number,
      accountKey: this.accountKey,
      operations: parsed.operations as OperationDocument['operations'],
      idempotencyIndex: parsed.idempotencyIndex as OperationDocument['idempotencyIndex'],
    }
  }

  private corrupt(detail: string): GarminWriteError {
    return new GarminWriteError(WRITE_ERROR_CODES.STATE_CORRUPT, 'not_applied', detail)
  }

  private unavailable(detail: string, cause: unknown): GarminWriteError {
    return new GarminWriteError(
      WRITE_ERROR_CODES.STATE_UNAVAILABLE,
      'not_applied',
      `${detail}: ${describe(cause)}`,
    )
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

function describe(error: unknown): string {
  if (isRecord(error) && typeof error.code === 'string') return error.code
  if (error instanceof Error) return error.name
  return 'unknown error'
}

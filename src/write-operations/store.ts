/**
 * Account-scoped, fail-closed operation journal.
 *
 * The store never touches the network and never silently repairs itself. Any
 * doubt (unsafe directory chain, foreign owner, widened mode, a granting macOS
 * ACL, a non-private DACL, a file where a directory belongs, corrupt JSON,
 * unknown schema, account mismatch, size over the cap) becomes a typed error
 * and the caller must not proceed to a Garmin write. Every mutation is an
 * atomic temp-write + fsync + rename so a crash can never leave a truncated or
 * empty journal behind.
 *
 * Three properties this module is responsible for, and how they are obtained:
 *
 *   1. *The journal is private.* The proof is not implemented here — it is
 *      `./private-state`, which delegates to the same policy module the session
 *      token store uses, so the two cannot drift apart. Verification runs over
 *      the whole ancestor chain and over the file that actually landed, never
 *      "chmod and assume".
 *   2. *The read is bounded.* There is no unbounded `readFile` on this path at
 *      all: the file is opened, `fstat`ed, the size is checked against the cap,
 *      and then at most one byte past the reported size is read through the
 *      handle. A journal that reached the cap stays on disk — nothing here
 *      deletes or truncates state to get unblocked.
 *   3. *Durability failures are reported.* Only a platform that genuinely has
 *      no directory fsync is tolerated; EIO and friends are surfaced instead of
 *      being swallowed as success.
 *   4. *The commit is read back.* The rename must have published the bytes this
 *      process wrote, and that is proven by reading them back rather than by
 *      trusting the name. An identity check on `dev:ino` alone is not enough:
 *      POSIX filesystems recycle the number of a just-unlinked inode, so on
 *      Linux a replacement file can land on the same pair and pass while the
 *      journal is no longer the one this process wrote.
 */

import { promises as nodeFs, type Stats } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { findDeepestExistingPath } from '../private-path'
import { GarminWriteError, WRITE_ERROR_CODES } from './errors'
import {
  CURRENT_JOURNAL_SCHEMA_VERSION,
  operationDocumentV2Schema,
  parseOperationJournal,
  type JournalLoadResult,
  type JournalMigrationReport,
} from './migration'
import { defaultPrivateStateGuard, type PrivateStateGuard } from './private-state'
import type { OperationDocument } from './types'

/** 32 MiB: over this, new writes are blocked but the file stays readable. */
export const MAX_OPERATION_FILE_BYTES = 32 * 1024 * 1024

const OPERATION_FILE_NAME = 'operations.json'

/**
 * Platforms with no directory fsync at all. Windows is the only one: `open` on
 * a directory there does not produce a handle that can be synced, so the
 * absence of the call is a platform fact rather than a lost write.
 */
const DIRECTORY_SYNC_UNSUPPORTED_PLATFORMS: ReadonlySet<NodeJS.Platform> =
  new Set<NodeJS.Platform>(['win32'])

/**
 * Codes that mean "this filesystem does not implement directory fsync", not
 * "the bytes did not reach the disk". Deliberately narrow: EIO, ENOSPC, EPERM
 * and EACCES are real durability failures and must be reported.
 */
const UNSUPPORTED_DIRECTORY_SYNC_CODES: ReadonlySet<string> = new Set<string>([
  'EINVAL',
  'ENOTSUP',
  'EOPNOTSUPP',
  'ENOSYS',
])

export interface StoreFileHandle {
  write(data: string): Promise<void>
  sync(): Promise<void>
  close(): Promise<void>
  /** `fstat` on this handle: identity and size of the inode actually held. */
  stat(): Promise<Stats>
  /**
   * A positioned read. The caller owns the size bound; this never returns more
   * than `length` bytes and never reaches beyond the open inode.
   */
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>
}

export interface StoreStat {
  isFile(): boolean
  isSymbolicLink(): boolean
  size: number
  dev: number
  ino: number
}

/** The narrow filesystem surface the store needs; injectable for fault tests. */
export interface WriteStoreFileSystem {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<void>
  open(path: string, flags: string, mode: number): Promise<StoreFileHandle>
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
  chmod(path: string, mode: number): Promise<void>
  lstat(path: string): Promise<StoreStat>
  /** Open a directory and fsync it; real failures must surface to the caller. */
  syncDirectory(path: string): Promise<void>
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
  open: async (path, flags, mode) => {
    const handle = await nodeFs.open(path, flags, mode)
    return {
      write: async (data: string) => { await handle.writeFile(data, 'utf8') },
      sync: () => handle.sync(),
      close: () => handle.close(),
      stat: () => handle.stat(),
      read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
    }
  },
  rename: (from, to) => nodeFs.rename(from, to),
  unlink: (path) => nodeFs.unlink(path),
  chmod: (path, mode) => nodeFs.chmod(path, mode),
  lstat: (path) => nodeFs.lstat(path),
  syncDirectory: async (path) => {
    const handle = await nodeFs.open(path, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  },
}

const defaultFileSystem: WriteStoreFileSystem = nodeStoreFileSystem

export interface FileOperationStoreOptions {
  /** The private-state proof. Defaults to the running platform's guard. */
  guard?: PrivateStateGuard
  /**
   * Selects the default guard and the directory-fsync rule. Injectable so the
   * Windows branches can be exercised on a host that is not Windows.
   */
  platform?: NodeJS.Platform
  /** Symlink-resolving `realpath`; injectable for tests. */
  realpath?: (path: string) => Promise<string>
}

export class FileOperationStore implements OperationStore {
  private readonly root: string
  private readonly file: string
  private readonly stateGuard: PrivateStateGuard
  private readonly platform: NodeJS.Platform
  private readonly realpath: (path: string) => Promise<string>

  constructor(
    stateDirectory: string,
    private readonly accountKey: string,
    private readonly fs: WriteStoreFileSystem = defaultFileSystem,
    private readonly randomSuffix: () => string = () => `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    private readonly now: () => Date = () => new Date(),
    options: FileOperationStoreOptions = {},
  ) {
    if (!isAbsolute(stateDirectory)) {
      throw new GarminWriteError(
        WRITE_ERROR_CODES.STATE_UNAVAILABLE,
        'not_applied',
        'GARMIN_STATE_DIR must be an absolute path',
      )
    }
    if (!isSinglePathSegment(accountKey)) {
      throw new GarminWriteError(
        WRITE_ERROR_CODES.STATE_UNAVAILABLE,
        'not_applied',
        'Write-journal account key must be a single path segment',
      )
    }
    this.root = join(resolve(stateDirectory), accountKey)
    this.file = join(this.root, OPERATION_FILE_NAME)
    this.platform = options.platform ?? process.platform
    this.stateGuard = options.guard ?? defaultPrivateStateGuard(this.platform)
    this.realpath = options.realpath ?? (path => nodeFs.realpath(path))
  }

  /**
   * The path as configured. I/O goes to the canonicalised form of the same
   * entry, so this is for callers that need to name the location, not to
   * bypass the proof.
   */
  get filePath(): string {
    return this.file
  }

  get directory(): string {
    return this.root
  }

  /**
   * The last migration report produced by `read`/`readWithReport`. Callers that
   * care (a receipt, a log line) can read it instead of re-deriving the facts.
   */
  private report: JournalMigrationReport | undefined

  get migrationReport(): JournalMigrationReport | undefined {
    return this.report
  }

  /**
   * Read, validate and — when the file is still schema v1 — upgrade *in
   * memory*. Nothing is persisted here: the upgrade must be committed under the
   * account lock by `migrateJournalUnderLock`, so two processes can never race
   * the rename.
   */
  async read(): Promise<OperationDocument> {
    return (await this.readWithReport()).document
  }

  async readWithReport(): Promise<JournalLoadResult> {
    const raw = await this.readRawFile()
    const result = parseOperationJournal(raw, this.accountKey, this.now)
    this.report = result.report
    return result
  }

  /**
   * Raw JSON as it sits on disk, or `undefined` when no journal exists yet.
   *
   * An empty file is *not* a new journal: it is the fingerprint of a crash
   * between create and write, and treating it as "no operations" would silently
   * discard unknown writes. It is reported as corrupt instead.
   */
  async readRawFile(): Promise<unknown> {
    const file = await this.verifiedFilePath()
    if (!file) return undefined

    const raw = await this.readFileBounded(file)
    if (raw.trim().length === 0) {
      throw this.corrupt(
        'Operation journal is empty; refusing to treat a truncated journal as a new one',
      )
    }
    try {
      return JSON.parse(raw)
    } catch (error) {
      throw this.corrupt(`Operation journal is not valid JSON: ${describe(error)}`)
    }
  }

  async save(document: OperationDocument, options: SaveOptions = {}): Promise<void> {
    if (document.accountKey !== this.accountKey) {
      throw new GarminWriteError(
        WRITE_ERROR_CODES.STATE_CORRUPT,
        'not_applied',
        'Refusing to persist an operation document for a different account',
      )
    }
    const root = await this.prepareRoot()
    const file = join(root, OPERATION_FILE_NAME)
    // Anything already sitting at the destination must satisfy the private-file
    // policy. Replacing a symlink, a directory or a group-readable journal would
    // be the silent repair this store refuses to perform; the operator decides.
    await this.stateGuard.verifyFile(file)

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
    if (document.schemaVersion !== CURRENT_JOURNAL_SCHEMA_VERSION) {
      throw this.corrupt(
        `Refusing to persist a schemaVersion ${String(document.schemaVersion)} journal; ` +
          `this build writes ${CURRENT_JOURNAL_SCHEMA_VERSION}`,
      )
    }
    const validation = operationDocumentV2Schema.safeParse(document)
    if (!validation.success) {
      // Internal validation: a document this build assembled must satisfy the
      // on-disk contract. Failing here means a bug, and writing it would make
      // the next read fail closed against a file we authored.
      throw this.corrupt(
        'Refusing to persist an operation document that fails v2 validation: ' +
          `${validation.error.issues[0]?.path.join('.') ?? '<root>'}: ` +
          `${validation.error.issues[0]?.message ?? 'unknown'}`,
      )
    }

    const tempFile = join(root, `.operations.${this.randomSuffix()}.tmp`)
    let handle: StoreFileHandle | undefined
    let staged: Stats | undefined
    let committed = false
    try {
      handle = await this.fs.open(tempFile, 'wx', 0o600)
      // The file was created with `wx` and mode 0o600; on POSIX this is a
      // read-back-verified no-op, on Windows it is where the exact DACL is
      // applied. Either way the handle is then bound to the verified inode.
      await this.stateGuard.secureNewFile(tempFile)
      staged = await handle.stat()
      await this.stateGuard.verifyOpenHandle(staged, tempFile)
      await handle.write(payload)
      await handle.sync()
      // Re-read the size of the bytes that are now durably in the file: the
      // commit proof compares the landed file against this, not against the
      // empty file that existed before the write.
      staged = await handle.stat()
      await handle.close()
      handle = undefined
      await this.fs.rename(tempFile, file)
      committed = true
      await this.assertLandedFile(file, staged, payload)
      await this.syncDirectory(file)
      staged = undefined
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined)
      if (!committed) await this.fs.unlink(tempFile).catch(() => undefined)
      if (error instanceof GarminWriteError) throw error
      throw this.unavailable('Operation journal could not be committed', error)
    }
  }

  /**
   * Canonical journal path, or `undefined` when no journal exists yet. The
   * chain is proven first, so an unsafe location is rejected even before the
   * file is created.
   */
  private async verifiedFilePath(): Promise<string | undefined> {
    const root = await this.canonicalPath(this.root)
    await this.stateGuard.verifyChain(root)
    const file = join(root, OPERATION_FILE_NAME)
    const info = await this.stateGuard.verifyFile(file)
    return info ? file : undefined
  }

  /**
   * Read exactly the fstat-reported number of bytes through the open handle.
   *
   * At most one byte past that size is requested, which is enough to notice
   * that the file grew between the `fstat` and the read: a torn read is
   * reported as corrupt rather than parsed into a half-journal.
   */
  private async readFileBounded(file: string): Promise<string> {
    let handle: StoreFileHandle | undefined
    try {
      handle = await this.fs.open(file, 'r', 0o600)
      const info = await handle.stat()
      await this.stateGuard.verifyOpenHandle(info, file)
      if (info.size > MAX_OPERATION_FILE_BYTES) throw this.oversize(info.size)
      return await readExactly(handle, info.size)
    } catch (error) {
      if (error instanceof GarminWriteError) throw error
      throw this.unavailable('Operation journal could not be read', error)
    } finally {
      if (handle) await handle.close().catch(() => undefined)
    }
  }

  /**
   * Canonical account directory, created when missing and proven private.
   *
   * The chain that already exists is proven *before* anything is created, so
   * this never creates state below a directory the effective user does not
   * exclusively control. Only then is the created result proven itself — and on
   * POSIX only the one entry this store owns may be repaired, always with the
   * repair read back rather than assumed.
   */
  private async prepareRoot(): Promise<string> {
    const root = await this.canonicalPath(this.root)
    // Before the create: absent components are tolerated, every existing one
    // must already be a real directory owned by this user.
    await this.stateGuard.verifyChain(root)
    await this.fs.mkdir(root, { recursive: true, mode: 0o700 })
    await this.stateGuard.ensureDirectory(root)
    return root
  }

  /**
   * The rename must have published the very file this process wrote.
   *
   * The identity pair is the cheap signal; the bytes are the decisive one.
   * POSIX filesystems hand the number of a just-unlinked inode straight back to
   * the next `create`, so `rm` + `writeFile` on the committed name reproduces
   * `dev:ino` exactly (observed on Linux overlayfs) and an identity-only check
   * returns success for a file this process never wrote. Comparing what landed
   * against the payload closes that hole on every platform, and the comparison
   * is bounded by the size the caller already settled, so no unbounded read is
   * introduced here.
   */
  private async assertLandedFile(file: string, staged: Stats, payload: string): Promise<void> {
    let landed: StoreStat
    try {
      landed = await this.fs.lstat(file)
    } catch (error) {
      throw new GarminWriteError(
        WRITE_ERROR_CODES.STATE_CORRUPT,
        'not_applied',
        `Operation journal was replaced but the committed file could not be ` +
          `inspected: ${describe(error)}`,
      )
    }
    const mismatch =
      landed.dev !== staged.dev || landed.ino !== staged.ino
        ? 'a different inode'
        : landed.size !== staged.size
          ? 'a different size'
          : await this.hasDifferentBytes(file, staged.size, payload)
            ? 'different bytes'
            : undefined
    if (mismatch !== undefined) {
      throw new GarminWriteError(
        WRITE_ERROR_CODES.STATE_CORRUPT,
        'not_applied',
        `Operation journal was replaced but the file that landed is not the one ` +
          `this process wrote (${mismatch})`,
      )
    }
  }

  /**
   * Read the committed file back and compare it with the payload.
   *
   * The caller has already rejected a size that differs, so this reads only
   * that many bytes and a larger file on disk is never read at all. A file that
   * changes size mid-read is reported by the shared bounded-read helper and
   * propagates as the same fail-closed corruption verdict.
   */
  private async hasDifferentBytes(file: string, size: number, payload: string): Promise<boolean> {
    let handle: StoreFileHandle | undefined
    try {
      handle = await this.fs.open(file, 'r', 0o600)
      const info = await handle.stat()
      if (info.size !== size) return true
      return (await readExactly(handle, info.size)) !== payload
    } catch (error) {
      if (error instanceof GarminWriteError) throw error
      throw new GarminWriteError(
        WRITE_ERROR_CODES.STATE_CORRUPT,
        'not_applied',
        `Operation journal was replaced but the committed bytes could not be ` +
          `inspected: ${describe(error)}`,
      )
    } finally {
      if (handle) await handle.close().catch(() => undefined)
    }
  }

  /**
   * Resolve the deepest component that exists, then re-attach the rest.
   *
   * The policy is then checked against the *canonical* path. That is not a
   * weakening: a legitimate platform symlink (`/var` -> `/private/var` on
   * macOS, a symlinked home directory) must not be mistaken for an attack,
   * while a container a real attacker could replace is exactly what the
   * ancestor check rejects - and every directory on the resolved path must be
   * owned by this user (or root) and not group- or world-writable. Doing all
   * I/O on the canonical path afterwards also closes the window between the
   * check and the use.
   */
  private async canonicalPath(path: string): Promise<string> {
    try {
      const { existingPath, missingComponents } = await findDeepestExistingPath(path, {
        noAnchor: 'Write-journal path has no filesystem anchor',
      })
      const resolved = await this.realpath(existingPath)
      return missingComponents.length === 0
        ? resolved
        : join(resolved, ...missingComponents)
    } catch (error) {
      throw this.unavailable('Write-journal path could not be resolved', error)
    }
  }

  private async syncDirectory(file: string): Promise<void> {
    // A platform without directory fsync loses nothing by skipping it: the
    // rename is still the visible commit, and there is no call to make.
    if (DIRECTORY_SYNC_UNSUPPORTED_PLATFORMS.has(this.platform)) return
    try {
      await this.fs.syncDirectory(dirname(file))
    } catch (error) {
      if (isUnsupportedDirectorySyncError(error)) return
      throw new GarminWriteError(
        WRITE_ERROR_CODES.STATE_UNAVAILABLE,
        'not_applied',
        `Operation journal was replaced but its directory could not be synced: ${describe(error)}`,
      )
    }
  }

  private oversize(bytes: number): GarminWriteError {
    return new GarminWriteError(
      WRITE_ERROR_CODES.STATE_UNAVAILABLE,
      'not_applied',
      `Operation journal is ${String(bytes)} bytes, over the 32 MiB read cap; ` +
        'archive it before using it again',
    )
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

/**
 * Read `size` bytes through the handle and not one byte more than `size + 1`.
 * The caller has already bounded `size`, so this can never read an unbounded
 * amount however large the file on disk turns out to be.
 */
async function readExactly(handle: StoreFileHandle, size: number): Promise<string> {
  const wanted = Math.min(size + 1, MAX_OPERATION_FILE_BYTES + 1)
  const buffer = Buffer.allocUnsafe(wanted)
  let filled = 0
  while (filled < wanted) {
    const { bytesRead } = await handle.read(buffer, filled, wanted - filled, filled)
    if (bytesRead <= 0) break
    filled += bytesRead
  }
  if (filled !== size) {
    throw new GarminWriteError(
      WRITE_ERROR_CODES.STATE_CORRUPT,
      'not_applied',
      'Operation journal changed size while it was being read; refusing a torn read',
    )
  }
  return buffer.toString('utf8', 0, filled)
}

/**
 * The account key becomes exactly one path segment below the state directory.
 * A key carrying a separator or `..` would step outside it, so it is rejected
 * before it can be joined — the same fail-closed rule the state directory gets.
 * Production derives the key as a hash; this states the invariant instead of
 * assuming it.
 */
function isSinglePathSegment(value: string): boolean {
  return value.length > 0
    && value !== '.'
    && value !== '..'
    && !value.includes('/')
    && !value.includes('\\')
    && !value.includes('\0')
}

function isUnsupportedDirectorySyncError(error: unknown): boolean {
  return isRecord(error)
    && typeof error.code === 'string'
    && UNSUPPORTED_DIRECTORY_SYNC_CODES.has(error.code)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describe(error: unknown): string {
  if (isRecord(error) && typeof error.code === 'string') return error.code
  if (error instanceof Error) return error.name
  return 'unknown error'
}

/**
 * Write-journal state security (C4).
 *
 * The journal decides whether a Garmin write is allowed to happen, so it has to
 * be trusted before it is read. These tests pin the proof itself rather than a
 * happy path:
 *
 *   - the private-path chain (owner, mode, type, link count, macOS ACL) is
 *     enforced, not repaired, and a widened journal is refused;
 *   - on Windows the DACL — not POSIX mode bits — is what decides, and the
 *     read path verifies without creating anything;
 *   - reads are bounded by the `fstat`-reported size and a torn read is
 *     reported instead of parsed;
 *   - only a platform that genuinely lacks directory fsync is tolerated, and
 *     the file that landed must be the file this process wrote;
 *   - a crashed `in_flight` marker is rolled forward to `unknown` only under the
 *     account lock, and a plain read never mutates state.
 */
import { link, lstat, mkdir, readFile, realpath, rename, rm, stat, symlink, truncate, writeFile, chmod, mkdtemp } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Stats } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { GarminWriteError, WRITE_ERROR_CODES } from '../src/write-operations/errors'
import {
  FileOperationStore,
  MAX_OPERATION_FILE_BYTES,
  nodeStoreFileSystem,
  type WriteStoreFileSystem,
} from '../src/write-operations/store'
import {
  createPosixPrivateStateGuard,
  createWindowsPrivateStateGuard,
  defaultPrivateStateGuard,
} from '../src/write-operations/private-state'
import { createWindowsPrivateAcl, type WindowsPrivateAcl } from '../src/windows-private-acl'
import { currentEffectiveUid } from '../src/private-path'
import { FileAccountLock, type AccountLock } from '../src/write-operations/lock'
import { WriteCoordinator } from '../src/write-operations/coordinator'
import { requestHash } from '../src/write-operations/identity'
import { emptyOperationDocument, type OperationDocument } from '../src/write-operations/types'

const ACCOUNT = 'account-under-test'
const NOW = () => new Date('2026-09-11T12:00:00.000Z')
const ISO = '2026-09-11T12:00:00.000Z'
const FILE_MESSAGE = 'Refusing to use a write-journal file that is not a private regular file'
const run = promisify(execFile)
const darwinOnly = process.platform === 'darwin' ? it : it.skip
const POSIX_ONLY = process.platform === 'win32' ? it.skip : it

function statOf(spec: {
  kind: 'dir' | 'file' | 'symlink'
  mode: number
  uid: number
  nlink?: number
  size?: number
  dev?: number
  ino?: number
}): Stats {
  return {
    isDirectory: () => spec.kind === 'dir',
    isFile: () => spec.kind === 'file',
    isSymbolicLink: () => spec.kind === 'symlink',
    mode: spec.mode,
    uid: spec.uid,
    nlink: spec.nlink ?? 1,
    size: spec.size ?? 0,
    dev: spec.dev ?? 1,
    ino: spec.ino ?? 1,
  } as unknown as Stats
}

function documentWith(accountKey: string, revision: number): OperationDocument {
  const document = emptyOperationDocument(accountKey)
  document.revision = revision
  return document
}

/** A v2 operation carrying one step per entry, valid enough to persist. */
function documentWithSteps(
  statuses: Array<'in_flight' | 'succeeded' | 'failed' | 'not_attempted'>,
): OperationDocument {
  const document = emptyOperationDocument(ACCOUNT)
  document.revision = 1
  document.operations['op-1'] = {
    operationId: 'op-1',
    kind: 'schedule',
    accountKey: ACCOUNT,
    schemaVersion: 2,
    previewRevision: 1,
    requestHash: requestHash({ operation: 'schedule', workoutId: 'w1' }),
    request: { operation: 'schedule', workoutId: 'w1' },
    createdAt: ISO,
    updatedAt: ISO,
    steps: statuses.map((status, index) => ({
      stepId: `s-${String(index + 1)}`,
      businessKey: `workout:w${String(index + 1)}:2026-09-20`,
      kind: 'schedule' as const,
      status,
      attempt: 1,
      evidence: status === 'succeeded' ? 'response' as const : 'none' as const,
      workoutId: `w${String(index + 1)}`,
      date: '2026-09-20',
      attempts: [{
        attempt: 1,
        outcome: status === 'in_flight'
          ? 'in_flight' as const
          : status === 'succeeded' ? 'succeeded' as const : 'failed' as const,
        startedAt: ISO,
        ...(status === 'in_flight' ? {} : { finishedAt: ISO }),
      }],
    })),
  }
  return document
}

function documentWithStep(status: 'in_flight' | 'succeeded' | 'failed' | 'not_attempted'): OperationDocument {
  return documentWithSteps([status])
}

describe('write-state security: private journal path', () => {
  let base: string

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'garmin-sec-'))
  })

  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  function seed(): Promise<FileOperationStore> {
    const store = new FileOperationStore(base, ACCOUNT)
    return store.save(documentWith(ACCOUNT, 1)).then(() => store)
  }

  it('round-trips a journal this process wrote with the private policy', async () => {
    const store = await seed()
    await expect(store.read()).resolves.toMatchObject({ revision: 1 })
    await expect(readFile(store.filePath)).resolves.toBeInstanceOf(Buffer)
  })

  POSIX_ONLY('refuses a journal file whose mode was widened', async () => {
    const store = await seed()
    await chmod(store.filePath, 0o644)

    await expect(store.read()).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
      message: expect.stringContaining(FILE_MESSAGE) as unknown as string,
    })
    // Fail closed, never "chmod and assume": the widened file is left exactly
    // as the operator would need to find it.
    expect((await stat(store.filePath)).mode & 0o777).toBe(0o644)
  })

  POSIX_ONLY('refuses a journal file owned by another user', async () => {
    await seed()
    const uid = currentEffectiveUid() ?? 0
    // The owner branch cannot be staged with a real file on a host that cannot
    // create foreign-owned files, so the traversal is injected. Everything else
    // is the real filesystem.
    const guard = createPosixPrivateStateGuard({
      platform: 'linux',
      effectiveUid: uid,
      lstat: async path => (basename(path) === 'operations.json'
        ? statOf({ kind: 'file', mode: 0o600, uid: uid + 1 })
        : lstat(path)),
    })

    const guarded = new FileOperationStore(base, ACCOUNT, nodeStoreFileSystem, undefined, undefined, { guard })
    await expect(guarded.read()).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
      message: expect.stringContaining(FILE_MESSAGE) as unknown as string,
    })

    // The same guard with the real owner in place reads the same file: the
    // rejection above is ownership, not the injection itself.
    const sameOwner = new FileOperationStore(base, ACCOUNT, nodeStoreFileSystem, undefined, undefined, {
      guard: createPosixPrivateStateGuard({ platform: 'linux', effectiveUid: uid }),
    })
    await expect(sameOwner.read()).resolves.toMatchObject({ revision: 1 })
  })

  POSIX_ONLY('refuses a hard-linked journal file', async () => {
    const store = await seed()
    await link(store.filePath, join(base, 'journal-copy'))

    await expect(store.read()).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
      message: expect.stringContaining(FILE_MESSAGE) as unknown as string,
    })
  })

  POSIX_ONLY('refuses a widened account directory', async () => {
    const store = await seed()
    await chmod(store.directory, 0o770)

    await expect(store.read()).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
    })
    // Reading must not repair what it is verifying.
    expect((await stat(store.directory)).mode & 0o777).toBe(0o770)
  })

  POSIX_ONLY('refuses a group-writable ancestor above the account directory', async () => {
    const shared = join(base, 'shared')
    await mkdir(shared, { mode: 0o700 })
    await chmod(shared, 0o777)
    const store = new FileOperationStore(shared, ACCOUNT)

    await expect(store.read()).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
      message: expect.stringContaining('group- or world-writable') as unknown as string,
    })
  })

  POSIX_ONLY('refuses a regular file where the account directory belongs', async () => {
    const store = new FileOperationStore(base, ACCOUNT)
    await writeFile(join(base, ACCOUNT), 'not a directory', { mode: 0o600 })

    await expect(store.read()).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
    })
    await expect(store.save(documentWith(ACCOUNT, 1))).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
    })
  })

  POSIX_ONLY('refuses a directory where the journal file belongs', async () => {
    const store = new FileOperationStore(base, ACCOUNT)
    await mkdir(store.directory, { recursive: true, mode: 0o700 })
    await mkdir(store.filePath, { mode: 0o700 })

    await expect(store.read()).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
      message: expect.stringContaining(FILE_MESSAGE) as unknown as string,
    })
  })

  POSIX_ONLY('accepts an ancestor symlink that resolves into the private tree', async () => {
    const real = join(base, 'real')
    await mkdir(real, { mode: 0o700 })
    await symlink(real, join(base, 'link'))

    // A legitimate platform symlink (macOS `/var` -> `/private/var`, a linked
    // home) must keep working: the check runs on the canonical path.
    const store = new FileOperationStore(join(base, 'link'), ACCOUNT)
    await store.save(documentWith(ACCOUNT, 2))
    await expect(store.read()).resolves.toMatchObject({ revision: 2 })
    await expect(readFile(join(real, ACCOUNT, 'operations.json'), 'utf8')).resolves.toContain('"revision": 2')
  })

  POSIX_ONLY('refuses a parent symlink whose target is not private', async () => {
    const hostile = join(base, 'hostile')
    await mkdir(hostile, { mode: 0o700 })
    await chmod(hostile, 0o777)
    await symlink(hostile, join(base, 'innocent-looking'))

    const store = new FileOperationStore(join(base, 'innocent-looking'), ACCOUNT)
    await expect(store.read()).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
      message: expect.stringContaining('group- or world-writable') as unknown as string,
    })
    await expect(store.save(documentWith(ACCOUNT, 3))).rejects.toBeInstanceOf(GarminWriteError)
  })

  POSIX_ONLY('refuses to replace a symlinked journal destination', async () => {
    const store = await seed()
    const target = join(base, 'elsewhere.json')
    await writeFile(target, '{"sentinel":true}\n', { mode: 0o600 })
    await rm(store.filePath)
    await symlink(target, store.filePath)

    await expect(store.save(documentWith(ACCOUNT, 9))).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
    })
    // The destination it refused to follow is untouched.
    await expect(readFile(target, 'utf8')).resolves.toBe('{"sentinel":true}\n')
  })

  darwinOnly('refuses a journal carrying a granting macOS ACL', async () => {
    const store = await seed()
    // `chmod +a` takes the ACE positionally and has no `--` end-of-options
    // marker; passing one makes chmod treat `--` as a literal file name.
    await run('/bin/chmod', ['+a', 'everyone allow read', store.filePath])

    await expect(store.read()).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
      message: expect.stringContaining('macOS ACL') as unknown as string,
    })
  })

  it('refuses a journal the ACL check rejects, and reads it when the ACL is clean', async () => {
    await seed()
    const fileGuard = (acl: () => Promise<void>) => createPosixPrivateStateGuard({
      platform: 'darwin',
      lstat: async path => (basename(path) === 'operations.json' ? lstat(path) : lstat(path)),
      darwinAcl: async path => {
        if (basename(path) === 'operations.json') await acl()
      },
    })

    const rejected = new FileOperationStore(base, ACCOUNT, nodeStoreFileSystem, undefined, undefined, {
      guard: fileGuard(async () => { throw new Error('granting or malformed ACL entry') }),
    })
    await expect(rejected.read()).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
      message: expect.stringContaining('macOS ACL that grants access') as unknown as string,
    })

    const accepted = new FileOperationStore(base, ACCOUNT, nodeStoreFileSystem, undefined, undefined, {
      guard: fileGuard(async () => undefined),
    })
    await expect(accepted.read()).resolves.toMatchObject({ revision: 1 })
  })
})

describe('write-state security: Windows DACL is the gate', () => {
  let base: string

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'garmin-win-sec-'))
  })

  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  function acl(overrides: Partial<WindowsPrivateAcl> = {}): WindowsPrivateAcl {
    return {
      prepareDirectory: jest.fn().mockResolvedValue(undefined),
      verifyDirectory: jest.fn().mockResolvedValue(undefined),
      secureFile: jest.fn().mockResolvedValue(undefined),
      verifyFile: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    }
  }

  function winStore(value: WindowsPrivateAcl, extra: { syncDirectory?: jest.Mock } = {}): FileOperationStore {
    return new FileOperationStore(base, ACCOUNT, {
      ...nodeStoreFileSystem,
      ...(extra.syncDirectory ? { syncDirectory: extra.syncDirectory } : {}),
    }, undefined, undefined, {
      platform: 'win32',
      guard: createWindowsPrivateStateGuard(async () => value),
    })
  }

  it('verifies the chain read-only, with missing components tolerated', async () => {
    const verifyDirectory = jest.fn().mockResolvedValue(undefined)
    const prepareDirectory = jest.fn().mockResolvedValue(undefined)
    const store = winStore(acl({ verifyDirectory, prepareDirectory }))

    await expect(store.read()).resolves.toMatchObject({ revision: 0 })
    // The guard is handed the symlink-resolved directory: `tmpdir()` on macOS
    // is `/var/...`, which is really `/private/var/...`. Verifying the
    // unresolved spelling would check a path the process never opens. The
    // account directory itself does not exist yet on a read, so it is resolved
    // against its nearest existing ancestor.
    expect(verifyDirectory).toHaveBeenCalledWith(join(await realpath(base), ACCOUNT), { allowMissing: true })
    // A read never creates state on Windows either.
    expect(prepareDirectory).not.toHaveBeenCalled()
  })

  it('refuses a chain whose DACL is not exactly private', async () => {
    const store = winStore(acl({
      verifyDirectory: jest.fn().mockRejectedValue(new Error('ACL validation failed')),
    }))

    await expect(store.read()).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
      message: expect.stringContaining('DACL is not private') as unknown as string,
    })
  })

  it('refuses a journal file whose DACL is not exactly private', async () => {
    const store = winStore(acl({
      verifyFile: jest.fn().mockRejectedValue(new Error('ACL validation failed')),
    }))
    await store.save(documentWith(ACCOUNT, 1)).catch(() => undefined)
    await writeFile(store.filePath, '{"schemaVersion":2,"revision":0,"accountKey":"' + ACCOUNT
      + '","operations":{},"idempotencyIndex":{}}\n', { mode: 0o600 })

    await expect(store.read()).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
      message: expect.stringContaining('file DACL is not private') as unknown as string,
    })
  })

  it('refuses to write when the DACL cannot be applied', async () => {
    const store = winStore(acl({
      prepareDirectory: jest.fn().mockRejectedValue(new Error('ACL validation failed')),
    }))

    await expect(store.save(documentWith(ACCOUNT, 1))).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
      message: expect.stringContaining('private DACL') as unknown as string,
    })
  })

  it('decides by DACL, not by POSIX mode bits', async () => {
    // 0o644 would be a hard rejection on POSIX. On Windows the mode carries no
    // meaning, so the same file must be readable: the gate really is the DACL.
    const store = winStore(acl())
    await mkdir(store.directory, { recursive: true, mode: 0o700 })
    await writeFile(store.filePath, '{"schemaVersion":2,"revision":5,"accountKey":"' + ACCOUNT
      + '","operations":{},"idempotencyIndex":{}}\n', { mode: 0o644 })

    await expect(store.read()).resolves.toMatchObject({ revision: 5 })
  })

  it('skips directory fsync entirely on Windows', async () => {
    const syncDirectory = jest.fn().mockRejectedValue(Object.assign(new Error('nope'), { code: 'EIO' }))
    const store = winStore(acl(), { syncDirectory })

    await expect(store.save(documentWith(ACCOUNT, 1))).resolves.toBeUndefined()
    expect(syncDirectory).not.toHaveBeenCalled()
  })

  it('builds its PowerShell target under SystemRoot without a shell', async () => {
    const calls: { file: string; args: readonly string[] }[] = []
    const value = await createWindowsPrivateAcl({
      systemRoot: 'C:\\Windows',
      run: async (file, args) => {
        calls.push({ file, args })
        return { stdout: '', stderr: '' }
      },
    })
    await value.verifyDirectory('C:\\Users\\runner\\.garmin', { allowMissing: true })

    expect(calls[0]?.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    // The script travels encoded; the target only ever through the environment.
    expect(calls[0]?.args).toContain('-EncodedCommand')
    expect(calls[0]?.args.join(' ')).not.toContain('garmin')
  })
})

describe('write-state security: bounded reads and corrupt content', () => {
  let base: string

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'garmin-read-sec-'))
  })

  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  async function seed(): Promise<FileOperationStore> {
    const store = new FileOperationStore(base, ACCOUNT)
    await store.save(documentWith(ACCOUNT, 4))
    return store
  }

  it('never asks for more than one byte past the reported size', async () => {
    const store = await seed()
    const size = (await stat(store.filePath)).size
    let requests = 0
    let widest = 0
    const recorded: WriteStoreFileSystem = {
      ...nodeStoreFileSystem,
      open: async (path, flags, mode) => {
        const handle = await nodeStoreFileSystem.open(path, flags, mode)
        return {
          ...handle,
          read: async (buffer, offset, length, position) => {
            requests += 1
            widest = Math.max(widest, length)
            return handle.read(buffer, offset, length, position)
          },
        }
      },
    }

    const bounded = new FileOperationStore(base, ACCOUNT, recorded)
    await expect(bounded.read()).resolves.toMatchObject({ revision: 4 })
    expect(requests).toBeGreaterThan(0)
    // The bound is the fstat size plus exactly one byte; never the file size,
    // never unbounded.
    expect(widest).toBe(size + 1)
  })

  it('reports a torn read when the file grows between stat and read', async () => {
    await seed()
    const racy: WriteStoreFileSystem = {
      ...nodeStoreFileSystem,
      open: async (path, flags, mode) => {
        const handle = await nodeStoreFileSystem.open(path, flags, mode)
        const info = await handle.stat()
        return {
          ...handle,
          // The handle reports the size it had before the file grew; the read
          // then returns more, which must not be parsed as a half-journal.
          stat: async () => statOf({
            kind: 'file',
            mode: 0o600,
            uid: currentEffectiveUid() ?? 0,
            size: info.size - 1,
            dev: info.dev,
            ino: info.ino,
          }),
        }
      },
    }

    await expect(new FileOperationStore(base, ACCOUNT, racy).read()).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
      message: expect.stringContaining('changed size') as unknown as string,
    })
  })

  it('refuses an over-cap journal without deleting or truncating it', async () => {
    const store = await seed()
    await truncate(store.filePath, MAX_OPERATION_FILE_BYTES + 1)

    await expect(store.read()).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_UNAVAILABLE,
      message: expect.stringContaining('32 MiB read cap') as unknown as string,
    })
    // Reaching the cap must never be answered by discarding the operator's
    // journal; the file is still there, at its full size.
    expect((await stat(store.filePath)).size).toBe(MAX_OPERATION_FILE_BYTES + 1)
  })

  it('refuses a journal that is not a JSON object', async () => {
    const store = await seed()
    await writeFile(store.filePath, '[]\n', { mode: 0o600 })

    await expect(store.read()).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
      message: expect.stringContaining('no schemaVersion') as unknown as string,
    })
  })

  it.each([
    ['an unknown step status', (document: OperationDocument) => {
      ;(document.operations['op-1'].steps[0] as { status: string }).status = 'probably_fine'
    }],
    ['a missing request hash', (document: OperationDocument) => {
      delete (document.operations['op-1'] as { requestHash?: string }).requestHash
    }],
    ['an attempt outcome outside the contract', (document: OperationDocument) => {
      ;(document.operations['op-1'].steps[0].attempts[0] as { outcome: string }).outcome = 'maybe'
    }],
    ['an index pointing at a missing operation', (document: OperationDocument) => {
      document.idempotencyIndex['deadbeef'] = 'op-missing'
    }],
    ['an unexpected extra field', (document: OperationDocument) => {
      ;(document.operations['op-1'] as unknown as Record<string, unknown>).surprise = true
    }],
  ])('refuses internal corruption: %s', async (_label, corruptDocument) => {
    const store = new FileOperationStore(base, ACCOUNT)
    const document = documentWithStep('succeeded')
    await store.save(document)
    corruptDocument(document)
    await writeFile(store.filePath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })

    await expect(store.read()).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
    })
  })
})

describe('write-state security: durability failures', () => {
  let base: string

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'garmin-durable-'))
  })

  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  function storeFailingSync(error: unknown): FileOperationStore {
    return new FileOperationStore(base, ACCOUNT, {
      ...nodeStoreFileSystem,
      syncDirectory: async () => { throw error },
    })
  }

  it.each(['EIO', 'EACCES', 'EPERM', 'ENOSPC'])(
    'reports a real directory-sync failure (%s) instead of calling it success',
    async (code) => {
      await expect(storeFailingSync(Object.assign(new Error('sync failed'), { code })).save(documentWith(ACCOUNT, 1)))
        .rejects.toMatchObject({
          code: WRITE_ERROR_CODES.STATE_UNAVAILABLE,
          message: expect.stringContaining('directory could not be synced') as unknown as string,
        })
    },
  )

  it.each(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'])(
    'tolerates a filesystem that does not implement directory fsync (%s)',
    async (code) => {
      const store = storeFailingSync(Object.assign(new Error('unsupported'), { code }))
      await expect(store.save(documentWith(ACCOUNT, 1))).resolves.toBeUndefined()
      await expect(store.read()).resolves.toMatchObject({ revision: 1 })
    },
  )

  it('refuses a file swapped in at the committed name', async () => {
    // On Linux the swap below reuses the committed inode number, so this case
    // is decided by the byte comparison rather than by the identity pair; on
    // macOS the identity pair differs first. Either way the commit is refused.
    const swapped: WriteStoreFileSystem = {
      ...nodeStoreFileSystem,
      rename: async (from, to) => {
        await nodeStoreFileSystem.rename(from, to)
        // Someone replaced the committed name with a different file.
        await rm(to)
        await writeFile(to, '{}\n', { mode: 0o600 })
      },
    }

    await expect(new FileOperationStore(base, ACCOUNT, swapped).save(documentWith(ACCOUNT, 1)))
      .rejects.toMatchObject({
        code: WRITE_ERROR_CODES.STATE_CORRUPT,
        message: expect.stringContaining('not the one this process wrote') as unknown as string,
      })
  })

  it('refuses a replacement that reuses the inode and matches the size', async () => {
    // A replacement is not obliged to change the identity pair. Linux hands the
    // number of a just-unlinked inode straight back to the next create (proven
    // against overlayfs in the platform matrix), so `rm` + a same-length write
    // reproduces `dev:ino` and `size` exactly. The inode signal is neutralised
    // here on purpose, on every platform, so the assertion pins the bytes
    // instead of a host-specific inode allocator: with an identity-only proof
    // this resolves, and the journal is silently a file nobody wrote.
    let reused: { dev: number; ino: number } | undefined
    let committedName: string | undefined
    const impostor = (bytes: Buffer): Buffer => {
      const mutated = Buffer.from(bytes)
      mutated[0] = bytes[0] === 0x7b ? 0x5b : 0x7b
      return mutated
    }
    const swapped: WriteStoreFileSystem = {
      ...nodeStoreFileSystem,
      rename: async (from, to) => {
        const staged = await nodeStoreFileSystem.lstat(from)
        const replacement = impostor(await readFile(from))
        await nodeStoreFileSystem.rename(from, to)
        await rm(to)
        await writeFile(to, replacement, { mode: 0o600 })
        reused = { dev: staged.dev, ino: staged.ino }
        committedName = to
      },
      lstat: async (path) => {
        const real = await nodeStoreFileSystem.lstat(path)
        if (reused === undefined || path !== committedName) return real
        return {
          isFile: () => real.isFile(),
          isSymbolicLink: () => real.isSymbolicLink(),
          size: real.size,
          dev: reused.dev,
          ino: reused.ino,
        }
      },
    }

    await expect(new FileOperationStore(base, ACCOUNT, swapped).save(documentWith(ACCOUNT, 1)))
      .rejects.toMatchObject({
        code: WRITE_ERROR_CODES.STATE_CORRUPT,
        message: expect.stringContaining('different bytes') as unknown as string,
      })
  })
})

describe('write-state security: crash roll-forward', () => {
  let base: string

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'garmin-rollfwd-'))
  })

  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  function coordinatorFor(store: FileOperationStore, lock: AccountLock = new FileAccountLock(base, ACCOUNT)) {
    return new WriteCoordinator({
      store,
      lock,
      accountKey: ACCOUNT,
      writer: { schedule: jest.fn() },
      now: NOW,
    })
  }

  it('turns an abandoned in_flight marker into an honest unknown', async () => {
    const store = new FileOperationStore(base, ACCOUNT)
    await store.save(documentWithStep('in_flight'))

    const report = await coordinatorFor(store).rollForwardAbandonedAttempts()
    expect(report.rolledForward).toEqual([{ operationId: 'op-1', stepId: 's-1' }])

    const persisted = await store.read()
    const step = persisted.operations['op-1'].steps[0]
    expect(step.status).toBe('unknown')
    expect(step.evidence).toBe('none')
    expect(step.errorCode).toBe(WRITE_ERROR_CODES.WRITE_OUTCOME_UNKNOWN)
    // The matching open attempt is closed with the same verdict, so nothing
    // later reads a dangling `in_flight`.
    expect(step.attempts[0].outcome).toBe('unknown')
    expect(step.attempts[0].finishedAt).toBe(ISO)
    expect(persisted.revision).toBe(2)
  })

  it('never invents success or failure and leaves settled steps alone', async () => {
    const store = new FileOperationStore(base, ACCOUNT)
    await store.save(documentWithSteps(['succeeded', 'failed', 'not_attempted']))
    const before = await readFile(store.filePath, 'utf8')

    const report = await coordinatorFor(store).rollForwardAbandonedAttempts()
    expect(report.rolledForward).toEqual([])

    const persisted = await store.read()
    expect(persisted.operations['op-1'].steps.map(step => step.status))
      .toEqual(['succeeded', 'failed', 'not_attempted'])
    // Nothing was rewritten: no revision bump, no byte changed.
    expect(persisted.revision).toBe(1)
    await expect(readFile(store.filePath, 'utf8')).resolves.toBe(before)
  })

  it('does not touch the journal when there is nothing to roll forward', async () => {
    const store = new FileOperationStore(base, ACCOUNT)
    await store.save(documentWith(ACCOUNT, 1))
    const before = await readFile(store.filePath, 'utf8')

    await expect(coordinatorFor(store).rollForwardAbandonedAttempts()).resolves.toEqual({ rolledForward: [] })
    await expect(readFile(store.filePath, 'utf8')).resolves.toBe(before)
  })

  it('cannot roll forward without the account lock', async () => {
    const store = new FileOperationStore(base, ACCOUNT)
    await store.save(documentWithStep('in_flight'))
    const before = await readFile(store.filePath, 'utf8')
    const refusing = {
      runExclusive: async () => {
        throw new GarminWriteError(
          WRITE_ERROR_CODES.OPERATION_BUSY,
          'not_applied',
          'Another request currently owns this account write lock; no new write was sent',
        )
      },
    }

    await expect(coordinatorFor(store, refusing).rollForwardAbandonedAttempts())
      .rejects.toMatchObject({ code: WRITE_ERROR_CODES.OPERATION_BUSY })
    // Holding the lock is positive proof that no live executor is mid-write;
    // without it the record must not be rewritten.
    await expect(readFile(store.filePath, 'utf8')).resolves.toBe(before)
  })

  it('never mutates state from a plain read', async () => {
    const store = new FileOperationStore(base, ACCOUNT)
    await store.save(documentWithStep('in_flight'))
    const before = await readFile(store.filePath, 'utf8')

    const coordinator = coordinatorFor(store)
    const found = await coordinator.getOperation('op-1')
    expect(found?.steps[0].status).toBe('in_flight')
    await expect(coordinator.listOperations()).resolves.toHaveLength(1)
    await expect(coordinator.findOperationByIdempotencyKey('anything')).resolves.toBeUndefined()

    await expect(readFile(store.filePath, 'utf8')).resolves.toBe(before)
  })
})

describe('write-state security: account key containment', () => {
  let base: string

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'garmin-key-'))
  })

  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  it.each(['..', '../escape', 'nested/key', 'back\\slash', '', '.'])(
    'refuses an account key that is not a single path segment (%p)',
    (accountKey) => {
      expect(() => new FileOperationStore(base, accountKey)).toThrow(GarminWriteError)
    },
  )

  it('keeps the journal inside the state directory for a legitimate key', async () => {
    const store = new FileOperationStore(base, ACCOUNT)
    await store.save(documentWith(ACCOUNT, 1))
    expect(store.filePath.startsWith(`${base}/`)).toBe(true)
  })
})

/**
 * The guard the running platform actually gets, and the branches only a real
 * Windows host or a real inode swap can reach. Every case here uses a seam the
 * source already exposes (`platform`, `lstat`, `darwinAcl`, the ACL resolver),
 * so they run deterministically on all three platforms instead of being
 * skipped where the code under test was least exercised.
 */
describe('write-state security: production guard assembly', () => {
  const sentinel = (): string => `/gcmcp-sentinel-${String(process.pid)}/account`

  it('assembles the Windows guard from the real DACL helper, and only for win32', async () => {
    const guard = defaultPrivateStateGuard('win32')

    // A POSIX absolute path is refused by the Windows target validator before
    // any PowerShell is spawned, so this pins the production assembly without
    // creating anything on the host that runs the test.
    await expect(guard.ensureDirectory(sentinel())).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
      message: expect.stringContaining(
        'Write-journal directory could not be given a private DACL',
      ) as unknown as string,
    })
    // The cause text below exists only in `windows-private-acl.ts`, so the
    // guard really is wired to the shipping ACL helper and not to a POSIX one.
    await expect(guard.ensureDirectory(sentinel())).rejects.toThrow(
      'Garmin session token file could not be written',
    )
    await expect(guard.verifyChain(sentinel())).rejects.toThrow(
      'Write-journal directory DACL is not private',
    )
    await expect(guard.secureNewFile(`${sentinel()}/operations.json`)).rejects.toThrow(
      'Write-journal file could not be given a private DACL',
    )
    // A file that is not there is reported absent: no helper is constructed and
    // nothing is created, which is the read path's contract on Windows too.
    await expect(guard.verifyFile(`${sentinel()}/operations.json`)).resolves.toBeUndefined()

    // The same input on the POSIX branch is decided by ownership and mode, not
    // by a DACL, so a path that simply does not exist resolves.
    await expect(defaultPrivateStateGuard('linux').verifyChain(sentinel())).resolves.toBeUndefined()
  })

  POSIX_ONLY('defaults to the running platform instead of Windows', async () => {
    // With `platform` omitted the guard is chosen from `process.platform`; on a
    // host that is not Windows that must be the POSIX guard, which is the only
    // one of the two that treats a missing path as nothing to prove.
    await expect(defaultPrivateStateGuard().verifyChain(sentinel())).resolves.toBeUndefined()
    await expect(defaultPrivateStateGuard(process.platform).verifyChain(sentinel()))
      .resolves.toBeUndefined()
  })
})

describe('write-state security: Windows guard failure branches', () => {
  const directory = 'C:\\private\\account'
  const file = 'C:\\private\\account\\operations.json'
  const enoent = () => Object.assign(new Error('gone'), { code: 'ENOENT' })
  const eacces = () => Object.assign(new Error('denied'), { code: 'EACCES' })

  function windowsAcl(overrides: Partial<WindowsPrivateAcl> = {}): WindowsPrivateAcl {
    return {
      prepareDirectory: jest.fn().mockResolvedValue(undefined),
      verifyDirectory: jest.fn().mockResolvedValue(undefined),
      secureFile: jest.fn().mockResolvedValue(undefined),
      verifyFile: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    }
  }

  it('fails closed when the path cannot be inspected at all', async () => {
    const inspect = jest.fn(async () => { throw eacces() })
    const guard = createWindowsPrivateStateGuard(async () => windowsAcl(), { lstat: inspect })

    // A directory is decided by its DACL alone, so the read path never stats it:
    // the POSIX shape of this check does not exist on Windows.
    await expect(guard.verifyChain(directory)).resolves.toBeUndefined()
    expect(inspect).not.toHaveBeenCalled()

    // A journal *file* is inspected for existence first, and an unreadable path
    // is a refusal rather than "the file is not there".
    await expect(guard.verifyFile(file)).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
      message: expect.stringContaining('path could not be inspected: denied') as unknown as string,
    })
    await expect(
      guard.verifyOpenHandle(statOf({ kind: 'file', mode: 0o600, uid: 0 }), file),
    ).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
      message: expect.stringContaining('path could not be inspected') as unknown as string,
    })
    expect(inspect).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['ensureDirectory', 'Write-journal directory could not be given a private DACL'],
    ['verifyChain', 'Write-journal directory DACL is not private'],
    ['secureNewFile', 'Write-journal file could not be given a private DACL'],
    ['verifyFile', 'Write-journal file DACL is not private'],
  ] as const)('%s fails closed with its own wording', async (action, wording) => {
    const failure = new Error('ACL validation failed')
    const guard = createWindowsPrivateStateGuard(
      async () => windowsAcl({
        prepareDirectory: jest.fn().mockRejectedValue(failure),
        verifyDirectory: jest.fn().mockRejectedValue(failure),
        secureFile: jest.fn().mockRejectedValue(failure),
        verifyFile: jest.fn().mockRejectedValue(failure),
      }),
      { lstat: async () => statOf({ kind: 'file', mode: 0o600, uid: 0 }) },
    )

    const invoke = async (): Promise<unknown> => {
      if (action === 'ensureDirectory') return guard.ensureDirectory(directory)
      if (action === 'verifyChain') return guard.verifyChain(directory)
      if (action === 'secureNewFile') return guard.secureNewFile(file)
      return guard.verifyFile(file)
    }

    await expect(invoke()).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
      message: expect.stringContaining(`${wording}: ACL validation failed`) as unknown as string,
    })
  })

  it('never re-wraps a typed write error raised by the DACL helper', async () => {
    // A typed error is a verdict the caller already understands — an unavailable
    // store is not a corrupt state, and collapsing the two would hide the
    // difference between "cannot tell" and "the journal is not private".
    const typed = new GarminWriteError(
      WRITE_ERROR_CODES.STATE_UNAVAILABLE,
      'not_applied',
      'Write-journal store is unavailable',
    )
    const guard = createWindowsPrivateStateGuard(async () => windowsAcl({
      verifyDirectory: jest.fn().mockRejectedValue(typed),
    }))

    await expect(guard.verifyChain(directory)).rejects.toBe(typed)
  })

  it('retries the DACL helper after a failed construction, then caches it', async () => {
    let attempts = 0
    const guard = createWindowsPrivateStateGuard(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('ACL helper is not available yet')
      return windowsAcl()
    })

    // The first attempt fails before any action runs: that is not a DACL
    // verdict, so the next call is allowed to build the helper again.
    await expect(guard.verifyChain(directory)).rejects.toThrow('ACL helper is not available yet')
    await expect(guard.verifyChain(directory)).resolves.toBeUndefined()
    expect(attempts).toBe(2)

    // A helper that did resolve is reused instead of re-run per action.
    let constructed = 0
    const cached = createWindowsPrivateStateGuard(async () => {
      constructed += 1
      return windowsAcl()
    })
    await cached.verifyChain(directory)
    await cached.secureNewFile(file)
    expect(constructed).toBe(1)
  })

  it('hands the exact directory to the DACL helper instead of repairing mode bits', async () => {
    const prepareDirectory = jest.fn().mockResolvedValue(undefined)
    const verifyDirectory = jest.fn().mockResolvedValue(undefined)
    const guard = createWindowsPrivateStateGuard(async () => windowsAcl({
      prepareDirectory,
      verifyDirectory,
    }))

    await expect(guard.ensureDirectory(directory)).resolves.toBeUndefined()

    expect(prepareDirectory).toHaveBeenCalledTimes(1)
    expect(prepareDirectory).toHaveBeenCalledWith(directory)
    // Applying the DACL is the whole contract; it is not a verification, and
    // POSIX mode bits are never consulted on Windows.
    expect(verifyDirectory).not.toHaveBeenCalled()
  })

  it('verifies a present journal file through the DACL helper and returns its stats', async () => {
    const verifyFile = jest.fn().mockResolvedValue(undefined)
    const info = statOf({ kind: 'file', mode: 0o600, uid: 0 })
    const guard = createWindowsPrivateStateGuard(async () => windowsAcl({ verifyFile }), {
      lstat: async () => info,
    })

    await expect(guard.verifyFile(file)).resolves.toBe(info)
    expect(verifyFile).toHaveBeenCalledWith(file)
  })

  it('reports a missing journal file as absent without building the DACL helper', async () => {
    const resolveAcl = jest.fn()
    const guard = createWindowsPrivateStateGuard(resolveAcl, {
      lstat: async () => { throw enoent() },
    })

    await expect(guard.verifyFile(file)).resolves.toBeUndefined()
    // A read of a journal that does not exist must not launch PowerShell.
    expect(resolveAcl).not.toHaveBeenCalled()
  })

  it('refuses a handle that disappeared or changed before commit', async () => {
    const gone = createWindowsPrivateStateGuard(async () => windowsAcl(), {
      lstat: async () => { throw enoent() },
    })
    await expect(
      gone.verifyOpenHandle(statOf({ kind: 'file', mode: 0o600, uid: 0 }), file),
    ).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
      message: expect.stringContaining('disappeared before it was committed') as unknown as string,
    })

    const swapped = createWindowsPrivateStateGuard(async () => windowsAcl(), {
      lstat: async () => statOf({ kind: 'file', mode: 0o600, uid: 0, ino: 2 }),
    })
    await expect(
      swapped.verifyOpenHandle(statOf({ kind: 'file', mode: 0o600, uid: 0, ino: 1 }), file),
    ).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
      message: expect.stringContaining('changed between open and commit') as unknown as string,
    })
  })

  it('treats a handle that cannot report its own stat as nothing to check', async () => {
    const inspect = jest.fn()
    const guard = createWindowsPrivateStateGuard(async () => windowsAcl(), { lstat: inspect })

    await expect(guard.verifyOpenHandle(undefined, file)).resolves.toBeUndefined()
    expect(inspect).not.toHaveBeenCalled()
  })
})

describe('write-state security: POSIX guard failure branches', () => {
  const directory = '/private/account-under-test'
  const file = '/private/account-under-test/operations.json'
  const enoent = () => Object.assign(new Error('gone'), { code: 'ENOENT' })
  const eacces = () => Object.assign(new Error('denied'), { code: 'EACCES' })
  const privateDirectory = () => statOf({ kind: 'dir', mode: 0o700, uid: 501 })
  const privateFile = () => statOf({ kind: 'file', mode: 0o600, uid: 501 })

  it('fails closed when a path cannot be inspected for a reason other than absence', async () => {
    const guard = createPosixPrivateStateGuard({
      platform: 'linux',
      effectiveUid: 501,
      lstat: async () => { throw eacces() },
    })

    await expect(guard.verifyChain(directory)).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
      message: expect.stringContaining('path could not be inspected: denied') as unknown as string,
    })
    await expect(guard.verifyFile(file)).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
      message: expect.stringContaining('path could not be inspected') as unknown as string,
    })
  })

  it.each([
    ['a regular file', statOf({ kind: 'file', mode: 0o600, uid: 501 })],
    ['a symlink', statOf({ kind: 'symlink', mode: 0o700, uid: 501 })],
  ])('refuses to treat %s as the account directory', async (_label, info) => {
    const guard = createPosixPrivateStateGuard({
      platform: 'linux',
      effectiveUid: 501,
      lstat: async () => info,
    })

    await expect(guard.ensureDirectory(directory)).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
      message: expect.stringContaining('not a directory') as unknown as string,
    })
  })

  it('reports a repair it could not apply and a directory that is still absent', async () => {
    // A widened mode is the one thing this store repairs, and the repair is
    // never assumed: if the chmod cannot be applied the write stops here.
    const widened = createPosixPrivateStateGuard({
      platform: 'linux',
      effectiveUid: 501,
      lstat: async () => statOf({ kind: 'dir', mode: 0o755, uid: 501 }),
    })
    await expect(widened.ensureDirectory('/nonexistent-repair-target/account')).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
      message: expect.stringContaining('permissions could not be tightened') as unknown as string,
    })

    // Missing all the way down: nothing was created, and the store must say so
    // rather than report a directory it never observed.
    const absent = createPosixPrivateStateGuard({
      platform: 'linux',
      effectiveUid: 501,
      lstat: async () => { throw enoent() },
    })
    await expect(absent.ensureDirectory(directory)).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
      message: expect.stringContaining('directory could not be created') as unknown as string,
    })
  })

  it('tolerates a file that vanished before the chmod and reports one that cannot be set', async () => {
    const guard = createPosixPrivateStateGuard({ platform: 'linux', effectiveUid: 501 })

    // `chmod` on a file that is already gone is the writer's race, not a
    // policy failure: the file was created with `wx` and 0o600, and the final
    // verification still has the last word.
    await expect(guard.secureNewFile('/private/account-under-test/absent.json'))
      .resolves.toBeUndefined()

    // A path the filesystem rejects outright is a real failure and must not be
    // mistaken for the tolerated race above.
    await expect(guard.secureNewFile('bad\u0000name.json')).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
      message: expect.stringContaining('file permissions could not be set') as unknown as string,
    })
  })

  it('refuses a macOS ACL that grants access and accepts a clean one', async () => {
    const base = {
      platform: 'darwin' as const,
      effectiveUid: 501,
      lstat: async (path: string) => (path === file ? privateFile() : privateDirectory()),
    }

    await expect(createPosixPrivateStateGuard({
      ...base,
      darwinAcl: async () => { throw new Error('granting or malformed ACL entry') },
    }).verifyChain(directory)).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
      message: expect.stringContaining(
        'macOS ACL that grants access: granting or malformed ACL entry',
      ) as unknown as string,
    })

    await expect(createPosixPrivateStateGuard({
      ...base,
      darwinAcl: async () => undefined,
    }).verifyChain(directory)).resolves.toBeUndefined()
  })

  it('reports an entry that disappeared or changed while its ACL was verified', async () => {
    const withShiftedInspection = (
      shift: (count: number) => Stats | undefined,
    ) => {
      const seen = new Map<string, number>()
      return createPosixPrivateStateGuard({
        platform: 'darwin',
        effectiveUid: 501,
        darwinAcl: async () => undefined,
        lstat: async (path: string) => {
          const count = (seen.get(path) ?? 0) + 1
          seen.set(path, count)
          if (path !== directory) return privateDirectory()
          const shifted = shift(count)
          if (!shifted) throw enoent()
          return shifted
        },
      })
    }

    // The entry the ACL decision was made about is no longer there.
    await expect(withShiftedInspection(count => (count > 1 ? undefined : privateDirectory()))
      .verifyChain(directory)).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
      message: expect.stringContaining('disappeared while its ACL was being verified') as unknown as string,
    })

    // Same path, different entry: the ACL verdict belongs to the inode that was
    // inspected, not to the path it was reached through.
    await expect(withShiftedInspection(count => statOf({
      kind: 'dir',
      mode: 0o700,
      uid: 501,
      ino: count > 1 ? 2 : 1,
    })).verifyChain(directory)).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
      message: expect.stringContaining('changed during ACL verification') as unknown as string,
    })
  })

  it('never consults the macOS ACL on a platform that is not darwin', async () => {
    let called = 0
    const guard = createPosixPrivateStateGuard({
      platform: 'linux',
      effectiveUid: 501,
      darwinAcl: async () => { called += 1 },
      lstat: async (path: string) => (path === file ? privateFile() : privateDirectory()),
    })

    await expect(guard.verifyChain(directory)).resolves.toBeUndefined()
    await expect(guard.verifyFile(file)).resolves.toMatchObject({ mode: 0o600 })
    expect(called).toBe(0)
  })

  it('reports a missing journal file as absent without consulting the ACL', async () => {
    let called = 0
    const guard = createPosixPrivateStateGuard({
      platform: 'darwin',
      effectiveUid: 501,
      darwinAcl: async () => { called += 1 },
      lstat: async () => { throw enoent() },
    })

    await expect(guard.verifyFile(file)).resolves.toBeUndefined()
    expect(called).toBe(0)
  })

  it('treats a handle that cannot report its own stat as nothing to check', async () => {
    const inspect = jest.fn()
    const guard = createPosixPrivateStateGuard({
      platform: 'linux',
      effectiveUid: 501,
      lstat: inspect,
    })

    await expect(guard.verifyOpenHandle(undefined, file)).resolves.toBeUndefined()
    expect(inspect).not.toHaveBeenCalled()
  })

  it('defaults the POSIX guard to the running platform and the real inspector', async () => {
    // Called with no options at all — the production assembly for every
    // non-Windows host. On macOS this installs the real `ls -lde` ACL check; on
    // a host without POSIX ACLs (`linux`) it installs none. A path that does not
    // exist is nothing to prove either way, so the assertion is identical on
    // every platform and the branch is not skipped on the host that lacks it.
    const guard = createPosixPrivateStateGuard()

    await expect(guard.verifyChain('/gcmcp-absent-account-under-test'))
      .resolves.toBeUndefined()
    await expect(guard.verifyFile('/gcmcp-absent-account-under-test/operations.json'))
      .resolves.toBeUndefined()
  })
})

describe('write-state security: POSIX guard against the real filesystem', () => {
  let base: string

  beforeEach(async () => {
    // `tmpdir()` on macOS is `/var/...`, which is really `/private/var/...`;
    // verifying the unresolved spelling would inspect a symlink the process
    // never opens, so the real path is used here exactly as the store does.
    base = await realpath(await mkdtemp(join(tmpdir(), 'garmin-posix-real-')))
  })

  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  POSIX_ONLY('reports an absent directory and a file sitting where a directory belongs', async () => {
    const guard = createPosixPrivateStateGuard({ platform: 'linux' })

    await expect(guard.ensureDirectory(join(base, 'missing', 'account'))).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
      message: expect.stringContaining('directory could not be created') as unknown as string,
    })

    const occupied = join(base, 'not-a-directory')
    await writeFile(occupied, 'sentinel\n', { mode: 0o600 })
    await expect(guard.ensureDirectory(occupied)).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
      message: expect.stringContaining('not a directory') as unknown as string,
    })
    // The file it refused is left exactly as found: no chmod, no replacement.
    expect((await stat(occupied)).mode & 0o777).toBe(0o600)
    await expect(readFile(occupied, 'utf8')).resolves.toBe('sentinel\n')
  })

  POSIX_ONLY('binds the macOS ACL decision to the real inode', async () => {
    const disappeared = join(base, 'acl-disappeared')
    await mkdir(disappeared, { mode: 0o700 })
    await expect(createPosixPrivateStateGuard({
      platform: 'darwin',
      darwinAcl: async path => {
        if (path === disappeared) await rm(disappeared, { recursive: true, force: true })
      },
    }).verifyChain(disappeared)).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
      message: expect.stringContaining('disappeared while its ACL was being verified') as unknown as string,
    })

    const swapped = join(base, 'acl-swapped')
    await mkdir(swapped, { mode: 0o700 })
    await expect(createPosixPrivateStateGuard({
      platform: 'darwin',
      darwinAcl: async path => {
        if (path !== swapped) return
        // The old entry stays alive under another name, so the replacement is
        // guaranteed to be a different inode rather than a reused number.
        await rename(swapped, `${swapped}-previous`)
        await mkdir(swapped, { mode: 0o700 })
      },
    }).verifyChain(swapped)).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
      message: expect.stringContaining('changed during ACL verification') as unknown as string,
    })

    const clean = join(base, 'acl-clean')
    await mkdir(clean, { mode: 0o700 })
    await expect(createPosixPrivateStateGuard({
      platform: 'darwin',
      darwinAcl: async () => undefined,
    }).verifyChain(clean)).resolves.toBeUndefined()
  })

  POSIX_ONLY('reports an opened handle that disappeared or changed before commit', async () => {
    const guard = createPosixPrivateStateGuard({ platform: 'linux' })

    const vanished = join(base, 'vanished.json')
    await writeFile(vanished, '{}\n', { mode: 0o600 })
    const vanishedInfo = await stat(vanished)
    await rm(vanished)
    await expect(guard.verifyOpenHandle(vanishedInfo, vanished)).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
      message: expect.stringContaining('disappeared before it was committed') as unknown as string,
    })

    const opened = join(base, 'opened.json')
    const other = join(base, 'other.json')
    await writeFile(opened, '{}\n', { mode: 0o600 })
    await writeFile(other, '{}\n', { mode: 0o600 })
    await expect(guard.verifyOpenHandle(await stat(opened), other)).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
      message: expect.stringContaining('changed between open and commit') as unknown as string,
    })
  })
})

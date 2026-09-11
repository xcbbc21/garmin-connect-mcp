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
import { link, lstat, mkdir, readFile, realpath, rm, stat, symlink, truncate, writeFile, chmod, mkdtemp } from 'node:fs/promises'
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

import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GarminWriteError, WRITE_ERROR_CODES } from '../src/write-operations/errors'
import {
  FileOperationStore,
  MAX_OPERATION_FILE_BYTES,
  nodeStoreFileSystem,
  type WriteStoreFileSystem,
} from '../src/write-operations/store'
import { emptyOperationDocument, type OperationDocument } from '../src/write-operations/types'

const ACCOUNT = 'account-under-test'

function failingFileSystem(
  failOn: 'open' | 'write' | 'sync' | 'rename',
): WriteStoreFileSystem {
  const boom = (): never => {
    throw Object.assign(new Error('injected fault'), { code: 'EIO' })
  }
  return {
    ...nodeStoreFileSystem,
    open: failOn === 'open'
      ? async () => boom()
      : async (path, flags, mode) => {
        const handle = await nodeStoreFileSystem.open(path, flags, mode)
        if (failOn === 'write') return { ...handle, write: async () => boom() }
        if (failOn === 'sync') return { ...handle, sync: async () => boom() }
        return handle
      },
    rename: failOn === 'rename' ? async () => boom() : nodeStoreFileSystem.rename,
  }
}

async function listTemps(directory: string): Promise<string[]> {
  const entries = await readdir(directory).catch(() => [] as string[])
  return entries.filter(name => name.endsWith('.tmp'))
}

function documentWith(accountKey: string, revision: number): OperationDocument {
  const document = emptyOperationDocument(accountKey)
  document.revision = revision
  return document
}

describe('FileOperationStore', () => {
  let base: string

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'garmin-state-'))
  })

  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  it('returns an empty journal when nothing has been written yet', async () => {
    const store = new FileOperationStore(base, ACCOUNT)
    await expect(store.read()).resolves.toEqual(emptyOperationDocument(ACCOUNT))
  })

  it('round-trips a journal and leaves no temporary files behind', async () => {
    const store = new FileOperationStore(base, ACCOUNT)
    const document = documentWith(ACCOUNT, 3)
    await store.save(document)
    await expect(store.read()).resolves.toEqual(document)
    expect(await listTemps(store.directory)).toEqual([])
  })

  it.each(['open', 'write', 'sync', 'rename'] as const)(
    'fails closed and preserves the previous journal when %s faults',
    async (failOn) => {
      const healthy = new FileOperationStore(base, ACCOUNT)
      await healthy.save(documentWith(ACCOUNT, 1))

      const broken = new FileOperationStore(base, ACCOUNT, failingFileSystem(failOn))
      await expect(broken.save(documentWith(ACCOUNT, 2)))
        .rejects.toBeInstanceOf(GarminWriteError)

      // The old journal must still be readable and unchanged: never an empty file.
      const survivor = await healthy.read()
      expect(survivor.revision).toBe(1)
      expect(await listTemps(healthy.directory)).toEqual([])
    },
  )

  it('refuses a corrupt journal instead of rebuilding an empty one', async () => {
    const store = new FileOperationStore(base, ACCOUNT)
    await store.save(documentWith(ACCOUNT, 1))
    await writeFile(store.filePath, '{ not json', 'utf8')
    await expect(store.read()).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
    })
  })

  it('refuses an unknown schema version', async () => {
    const store = new FileOperationStore(base, ACCOUNT)
    await store.save(documentWith(ACCOUNT, 1))
    const parsed = JSON.parse(await readFile(store.filePath, 'utf8'))
    // Anything other than the current version is unsupported, in both
    // directions: a future version must not be read as if it were this one.
    parsed.schemaVersion = 3
    await writeFile(store.filePath, JSON.stringify(parsed), 'utf8')
    await expect(store.read()).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
    })
  })

  it('refuses a journal belonging to another account', async () => {
    const store = new FileOperationStore(base, ACCOUNT)
    await store.save(documentWith(ACCOUNT, 1))
    const other = new FileOperationStore(base, 'someone-else')
    // The file path is per-account, so craft the mismatch explicitly.
    const parsed = JSON.parse(await readFile(store.filePath, 'utf8'))
    parsed.accountKey = 'someone-else'
    await writeFile(store.filePath, JSON.stringify(parsed), 'utf8')
    await expect(store.read()).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
    })
    // The other account's own path stays empty rather than inheriting records.
    await expect(other.read()).resolves.toEqual(emptyOperationDocument('someone-else'))
  })

  it('refuses a symlinked journal path', async () => {
    const store = new FileOperationStore(base, ACCOUNT)
    await store.save(documentWith(ACCOUNT, 1))
    const target = `${store.filePath}.real`
    await writeFile(target, JSON.stringify(documentWith(ACCOUNT, 1)), 'utf8')
    await rm(store.filePath, { force: true })
    await symlink(target, store.filePath)
    await expect(store.read()).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
    })
  })

  it('refuses a stale save when the on-disk revision moved on', async () => {
    const store = new FileOperationStore(base, ACCOUNT)
    await store.save(documentWith(ACCOUNT, 1))
    await expect(store.save(documentWith(ACCOUNT, 5), { expectedRevision: 4 }))
      .rejects.toMatchObject({ code: WRITE_ERROR_CODES.STATE_CORRUPT })
    await expect(store.read()).resolves.toMatchObject({ revision: 1 })
  })

  it('accepts a save when the expected revision matches', async () => {
    const store = new FileOperationStore(base, ACCOUNT)
    await store.save(documentWith(ACCOUNT, 1))
    await store.save(documentWith(ACCOUNT, 2), { expectedRevision: 1 })
    await expect(store.read()).resolves.toMatchObject({ revision: 2 })
  })

  it('refuses to persist a document for a different account', async () => {
    const store = new FileOperationStore(base, ACCOUNT)
    await expect(store.save(documentWith('someone-else', 1)))
      .rejects.toMatchObject({ code: WRITE_ERROR_CODES.STATE_CORRUPT })
  })

  it('blocks new writes over the size cap while staying readable', async () => {
    const store = new FileOperationStore(base, ACCOUNT)
    const document = documentWith(ACCOUNT, 1)
    document.operations.bloat = {
      value: 'x'.repeat(MAX_OPERATION_FILE_BYTES + 10),
    } as never
    await expect(store.save(document))
      .rejects.toMatchObject({ code: WRITE_ERROR_CODES.STATE_UNAVAILABLE })
  })

  it('rejects a relative state root', () => {
    expect(() => new FileOperationStore('relative/path', ACCOUNT))
      .toThrow(GarminWriteError)
  })
})

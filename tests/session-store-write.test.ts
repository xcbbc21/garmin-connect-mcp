import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as darwinAcl from '../src/darwin-private-acl'
import {
  bindDiSessionTokensToAccount,
  prepareSessionTokenWriteDestination,
  readSessionTokenFile,
  writeSessionTokenFile,
} from '../src/session-store'

describe('session token file writer', () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
      if (process.platform === 'darwin') {
        await removeDarwinAclRecursively(directory).catch(() => undefined)
      }
      await rm(directory, { recursive: true, force: true })
    }))
  })

  it('atomically creates a private parent directory and 0600 token file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'garmin-session-write-test-'))
    temporaryDirectories.push(root)
    const parent = join(root, 'account')
    const path = join(parent, 'session.json')
    const tokens = {
      oauth1: { oauth_token: 'oauth-one' },
      oauth2: { access_token: 'oauth-two' },
    }

    await writeSessionTokenFile(path, tokens)

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(tokens)
    expect((await stat(parent)).mode & 0o777).toBe(0o700)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readdir(parent)).toEqual(['session.json'])
  })

  it('preflights an existing private POSIX parent without changing it', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'garmin-session-write-test-'))
    temporaryDirectories.push(root)
    const parent = join(root, 'account')
    await mkdir(parent, { mode: 0o700 })
    await chmod(parent, 0o700)

    await expect(prepareSessionTokenWriteDestination(
      join(parent, 'session.json'),
    )).resolves.toBeUndefined()

    expect((await stat(parent)).mode & 0o777).toBe(0o700)
    expect(await readdir(parent)).toEqual([])
  })

  it('creates a missing POSIX parent as 0700 during preflight', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'garmin-session-write-test-'))
    temporaryDirectories.push(root)
    const intermediate = join(root, 'accounts')
    const parent = join(intermediate, 'personal')

    await expect(prepareSessionTokenWriteDestination(
      join(parent, 'session.json'),
    )).resolves.toBeUndefined()

    expect((await stat(intermediate)).mode & 0o777).toBe(0o700)
    expect((await stat(parent)).mode & 0o777).toBe(0o700)
    expect(await readdir(parent)).toEqual([])
  })

  it('rejects a Darwin child whose inherited ACL grants access despite mode 0700', async () => {
    if (process.platform !== 'darwin') return
    const root = await mkdtemp(join(tmpdir(), 'garmin-session-acl-test-'))
    temporaryDirectories.push(root)
    await chmod(root, 0o700)
    await addDarwinAcl(root, DARWIN_INHERITABLE_GRANT_ACL)
    const child = join(root, 'account')
    await mkdir(child, { mode: 0o700 })
    await chmod(child, 0o700)
    await removeDarwinAcl(root)

    await expect(darwinAcl.verifyNoGrantingDarwinAcl(root))
      .resolves.toBeUndefined()
    await expect(darwinAcl.verifyNoGrantingDarwinAcl(child))
      .rejects.toThrow('Garmin session ACL could not be verified')

    const operation = prepareSessionTokenWriteDestination(
      join(child, 'SECRET_ACCOUNT.json'),
    )

    await expect(operation).rejects.toThrow(
      'Garmin session token destination could not be prepared',
    )
    await expect(operation).rejects.not.toThrow('SECRET_ACCOUNT')
    expect((await stat(root)).mode & 0o777).toBe(0o700)
    expect((await stat(child)).mode & 0o777).toBe(0o700)
  })

  it('rejects reading an owner-mode Darwin file with a granting ACL', async () => {
    if (process.platform !== 'darwin') return
    const root = await mkdtemp(join(tmpdir(), 'garmin-session-acl-read-test-'))
    temporaryDirectories.push(root)
    const path = join(root, 'SECRET_ACCOUNT.json')
    await writeFile(path, JSON.stringify({ oauth1: {}, oauth2: {} }), {
      encoding: 'utf8',
      mode: 0o600,
    })
    await chmod(path, 0o600)
    await addDarwinAcl(path, 'group:everyone allow read')

    const operation = readSessionTokenFile(path)

    await expect(operation).rejects.toThrow(
      'Garmin session token file permissions are unsafe',
    )
    await expect(operation).rejects.not.toThrow('SECRET_ACCOUNT')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('checks an empty Darwin temporary file ACL before writing credential bytes', async () => {
    if (process.platform !== 'darwin') return
    const root = await mkdtemp(join(tmpdir(), 'garmin-session-acl-temp-test-'))
    temporaryDirectories.push(root)
    const path = join(root, 'SECRET_ACCOUNT.json')
    const verifyAcl = jest.spyOn(darwinAcl, 'verifyNoGrantingDarwinAcl')
      .mockImplementation(async (candidate) => {
        if (candidate.endsWith('.tmp')) {
          throw new Error('PRIVATE_INHERITED_ACL_DETAIL')
        }
      })

    try {
      const operation = writeSessionTokenFile(path, {
        oauth1: { secret: 'TOP_SECRET_FRAGMENT' },
        oauth2: {},
      })

      await expect(operation).rejects.toThrow(
        'Garmin session token file could not be written',
      )
      await expect(operation).rejects.not.toThrow('TOP_SECRET_FRAGMENT')
      await expect(operation).rejects.not.toThrow('PRIVATE_INHERITED_ACL_DETAIL')
      expect(verifyAcl.mock.calls.some(([candidate]) => candidate.endsWith('.tmp')))
        .toBe(true)
      expect(await readdir(root)).toEqual([])
    } finally {
      verifyAcl.mockRestore()
    }
  })

  it('rejects an existing unsafe POSIX parent during preflight', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'garmin-session-write-test-'))
    temporaryDirectories.push(root)
    const parent = join(root, 'account')
    await mkdir(parent, { mode: 0o755 })
    await chmod(parent, 0o755)

    let thrown: unknown
    try {
      await prepareSessionTokenWriteDestination(
        join(parent, 'SECRET_ACCOUNT.json'),
      )
    } catch (error) {
      thrown = error
    }

    expect(thrown).toEqual(expect.objectContaining({
      name: 'PublicToolError',
      message: 'Garmin session token destination could not be prepared',
    }))
    expect(String(thrown)).not.toContain('SECRET_ACCOUNT')
    expect((await stat(parent)).mode & 0o777).toBe(0o755)
    expect(await readdir(parent)).toEqual([])
  })

  it('rejects a private but non-writable POSIX parent during preflight', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'garmin-session-write-test-'))
    temporaryDirectories.push(root)
    const parent = join(root, 'account')
    await mkdir(parent, { mode: 0o500 })
    await chmod(parent, 0o500)

    const path = join(parent, 'SECRET_ACCOUNT.json')
    await expect(prepareSessionTokenWriteDestination(
      path,
    )).rejects.toThrow('Garmin session token destination could not be prepared')
    let thrown: unknown
    try {
      await writeSessionTokenFile(path, {
        oauth1: { secret: 'TOP_SECRET_FRAGMENT' },
        oauth2: {},
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toEqual(expect.objectContaining({
      name: 'PublicToolError',
      message: 'Garmin session token file could not be written',
    }))
    expect(String(thrown)).not.toContain('TOP_SECRET_FRAGMENT')
    expect(String(thrown)).not.toContain('SECRET_ACCOUNT')
    expect((await stat(parent)).mode & 0o777).toBe(0o500)
    expect(await readdir(parent)).toEqual([])
  })

  it('rejects a private parent below a group-or-world-writable ancestor', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'garmin-session-write-test-'))
    temporaryDirectories.push(root)
    const unsafeAncestor = join(root, 'unsafe')
    const parent = join(unsafeAncestor, 'account')
    await mkdir(parent, { recursive: true, mode: 0o700 })
    await chmod(unsafeAncestor, 0o777)
    await chmod(parent, 0o700)

    await expect(prepareSessionTokenWriteDestination(
      join(parent, 'session.json'),
    )).rejects.toThrow('Garmin session token destination could not be prepared')

    expect(await readdir(parent)).toEqual([])
  })

  it('rejects a parent that is not owned by the effective user', async () => {
    if (process.platform === 'win32' || typeof process.geteuid !== 'function') return
    const root = await mkdtemp(join(tmpdir(), 'garmin-session-write-test-'))
    temporaryDirectories.push(root)
    const parent = join(root, 'account')
    await mkdir(parent, { mode: 0o700 })
    await chmod(parent, 0o700)

    const actualUid = process.geteuid()
    const getEffectiveUid = jest
      .spyOn(process, 'geteuid')
      .mockReturnValue(actualUid + 1)
    try {
      await expect(prepareSessionTokenWriteDestination(
        join(parent, 'session.json'),
      )).rejects.toThrow('Garmin session token destination could not be prepared')
    } finally {
      getEffectiveUid.mockRestore()
    }
  })

  it('atomically round-trips a private DI session file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'garmin-session-write-test-'))
    temporaryDirectories.push(root)
    const path = join(root, 'account', 'browser.session.json')
    const session = bindDiSessionTokensToAccount({
      accessToken: 'di-access-token',
      refreshToken: 'di-refresh-token',
      clientId: 'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2',
      accessExpiresAtMs: 1_800_000_000_000,
      refreshExpiresAtMs: null,
    }, 'runner@example.com', 'global', 123456789)

    await writeSessionTokenFile(path, session)

    await expect(readSessionTokenFile(path)).resolves.toEqual(session)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('refuses to change or write through an existing broadly-readable directory', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'garmin-session-write-test-'))
    temporaryDirectories.push(root)
    const parent = join(root, 'account')
    await mkdir(parent, { mode: 0o755 })
    await chmod(parent, 0o755)

    await expect(writeSessionTokenFile(join(parent, 'session.json'), {
      oauth1: {},
      oauth2: {},
    })).rejects.toThrow('Garmin session token file could not be written')

    expect((await stat(parent)).mode & 0o777).toBe(0o755)
    expect(await readdir(parent)).toEqual([])
  })

  it('canonicalizes a symlink to a private account directory before writing', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'garmin-session-write-test-'))
    temporaryDirectories.push(root)
    const actual = join(root, 'actual')
    const linked = join(root, 'linked')
    await mkdir(actual, { mode: 0o700 })
    await chmod(actual, 0o700)
    await symlink(actual, linked, 'dir')

    await writeSessionTokenFile(join(linked, 'session.json'), {
      oauth1: {},
      oauth2: {},
    })

    expect(await readdir(actual)).toEqual(['session.json'])
    expect((await stat(join(actual, 'session.json'))).mode & 0o777).toBe(0o600)
  })

  it('rejects a symlink whose canonical target is not private', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'garmin-session-write-test-'))
    temporaryDirectories.push(root)
    const actual = join(root, 'unsafe')
    const linked = join(root, 'linked')
    await mkdir(actual, { mode: 0o755 })
    await chmod(actual, 0o755)
    await symlink(actual, linked, 'dir')

    let thrown: unknown
    try {
      await writeSessionTokenFile(join(linked, 'SECRET_ACCOUNT.json'), {
        oauth1: { secret: 'TOP_SECRET_FRAGMENT' },
        oauth2: {},
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toEqual(expect.objectContaining({
      name: 'PublicToolError',
      message: 'Garmin session token file could not be written',
    }))
    expect(String(thrown)).not.toContain('TOP_SECRET_FRAGMENT')
    expect(String(thrown)).not.toContain('SECRET_ACCOUNT')
    expect(await readdir(actual)).toEqual([])
  })

  it('rejects a symlink at the final session filename', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'garmin-session-write-test-'))
    temporaryDirectories.push(root)
    const parent = join(root, 'account')
    const path = join(parent, 'SECRET_ACCOUNT.json')
    const target = join(root, 'target.json')
    await mkdir(parent, { mode: 0o700 })
    await chmod(parent, 0o700)
    await symlink(target, path, 'file')

    let thrown: unknown
    try {
      await writeSessionTokenFile(path, {
        oauth1: { secret: 'TOP_SECRET_FRAGMENT' },
        oauth2: {},
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toEqual(expect.objectContaining({
      name: 'PublicToolError',
      message: 'Garmin session token file could not be written',
    }))
    expect(String(thrown)).not.toContain('TOP_SECRET_FRAGMENT')
    expect(String(thrown)).not.toContain('SECRET_ACCOUNT')
    expect(await readdir(parent)).toEqual(['SECRET_ACCOUNT.json'])
    expect(await readdir(root)).toEqual(['account'])
  })

  it('revalidates a symlink target when writing after preflight', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'garmin-session-write-test-'))
    temporaryDirectories.push(root)
    const safe = join(root, 'safe')
    const unsafe = join(root, 'unsafe')
    const linked = join(root, 'linked')
    await mkdir(safe, { mode: 0o700 })
    await mkdir(unsafe, { mode: 0o755 })
    await chmod(safe, 0o700)
    await chmod(unsafe, 0o755)
    await symlink(safe, linked, 'dir')
    const path = join(linked, 'session.json')

    await prepareSessionTokenWriteDestination(path)
    await unlink(linked)
    await symlink(unsafe, linked, 'dir')

    await expect(writeSessionTokenFile(path, {
      oauth1: { secret: 'TOP_SECRET_FRAGMENT' },
      oauth2: {},
    })).rejects.toThrow('Garmin session token file could not be written')
    expect(await readdir(safe)).toEqual([])
    expect(await readdir(unsafe)).toEqual([])
  })

  it('refuses a session that is too large to read back before creating a file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'garmin-session-write-test-'))
    temporaryDirectories.push(root)
    const path = join(root, 'session.json')

    await expect(writeSessionTokenFile(path, {
      oauth1: { oauth_token: 'x'.repeat(1024 * 1024) },
      oauth2: {},
    })).rejects.toThrow('Garmin session token file is too large')

    expect(await readdir(root)).toEqual([])
  })

  it.each([
    ['missing oauth2', { oauth1: { secret: 'TOP_SECRET_FRAGMENT' } }],
    ['non-object oauth token', { oauth1: [], oauth2: {} }],
    ['unexpected top-level data', {
      oauth1: {},
      oauth2: {},
      privateNote: 'TOP_SECRET_FRAGMENT',
    }],
  ])('rejects %s before creating a file', async (_case, tokens) => {
    const root = await mkdtemp(join(tmpdir(), 'garmin-session-write-test-'))
    temporaryDirectories.push(root)
    const path = join(root, 'SECRET_ACCOUNT.json')

    let thrown: unknown
    try {
      await writeSessionTokenFile(path, tokens)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toEqual(expect.objectContaining({
      name: 'PublicToolError',
      message: 'Garmin session token file is invalid',
    }))
    expect(String(thrown)).not.toContain('TOP_SECRET_FRAGMENT')
    expect(String(thrown)).not.toContain('SECRET_ACCOUNT')
    expect(await readdir(root)).toEqual([])
  })

  it('removes the temporary file and returns a fixed error when rename fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'garmin-session-write-test-'))
    temporaryDirectories.push(root)
    const path = join(root, 'SECRET_ACCOUNT')
    await mkdir(path)

    let thrown: unknown
    try {
      await writeSessionTokenFile(path, {
        oauth1: { secret: 'TOP_SECRET_FRAGMENT' },
        oauth2: {},
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toEqual(expect.objectContaining({
      name: 'PublicToolError',
      message: 'Garmin session token file could not be written',
    }))
    expect(String(thrown)).not.toContain('TOP_SECRET_FRAGMENT')
    expect(String(thrown)).not.toContain('SECRET_ACCOUNT')
    expect(await readdir(root)).toEqual(['SECRET_ACCOUNT'])
  })
})

const DARWIN_INHERITABLE_GRANT_ACL =
  'group:everyone allow list,search,add_file,add_subdirectory,readattr,' +
  'writeattr,readextattr,writeextattr,readsecurity,file_inherit,directory_inherit'

function addDarwinAcl(path: string, entry: string): Promise<void> {
  return runDarwinChmod(['+a', entry, path])
}

function removeDarwinAcl(path: string): Promise<void> {
  return runDarwinChmod(['-N', path])
}

function removeDarwinAclRecursively(path: string): Promise<void> {
  return runDarwinChmod(['-RN', path])
}

function runDarwinChmod(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('/bin/chmod', args, {
      env: { LANG: 'C', LC_ALL: 'C' },
      shell: false,
      timeout: 5_000,
    }, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

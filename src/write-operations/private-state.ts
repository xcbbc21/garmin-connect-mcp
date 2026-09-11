/**
 * Private-state proof for the write-operation journal.
 *
 * The journal sits next to the session tokens under the user's state
 * directory, so it needs the same proof before it is trusted: every ancestor
 * is a real directory owned by the effective user and not group/world
 * writable, the account directory itself is owner-only, and the journal file
 * is a single-link regular file that is neither a symlink nor group/world
 * readable. The policy assertions are the ones the session store uses — they
 * live in `../private-path.ts` and are shared, not copied, so the two stores
 * cannot drift apart.
 *
 * What is journal-specific and therefore lives here:
 *
 *   - the messages, so a failure names the write journal instead of a session;
 *   - the traversal, because it must run over an *injectable* `lstat` so the
 *     POSIX owner/mode branches can be exercised on a host that cannot create
 *     a foreign-owned file;
 *   - macOS ACL inspection, which is applied to the two entries this store
 *     creates and controls (`<state>/<accountKey>` and its `operations.json`).
 *     Directories above our own entry — the home directory, `/Users`, `/var` —
 *     get the type/owner/mode assertions on every call but not an ACL sweep:
 *     a principal able to edit an ACE up there already owns the account, and
 *     re-spawning `/bin/ls` for every ancestor of every journal read would put
 *     a process launch between the caller and a write decision.
 *
 * Nothing here creates or deletes state. A path that does not exist cannot be
 * inspected, so it is reported as absent and left to the writer; verification
 * happens again after the write, on the file that actually landed.
 */

import { type Stats } from 'node:fs'
import { chmod, lstat } from 'node:fs/promises'
import {
  ancestorPaths,
  assertPrivatePosixFile,
  assertPrivatePosixParent,
  assertSafePosixAncestor,
  assertSameFileSystemEntry,
  currentEffectiveUid,
  isNotFoundError,
  type PathGuardMessages,
} from '../private-path'
import { verifyNoGrantingDarwinAcl } from '../darwin-private-acl'
import { createWindowsPrivateAcl, type WindowsPrivateAcl } from '../windows-private-acl'
import { GarminWriteError, WRITE_ERROR_CODES } from './errors'

const MESSAGES: PathGuardMessages = {
  directory:
    'Refusing to use a write-journal path that is a symlink or not a directory',
  directoryOwner:
    'Refusing to use a write-journal directory owned by another user',
  directoryPermissions:
    'Refusing to use a group- or world-writable write-journal directory',
  anchor: 'Refusing to anchor the write journal in an unsafe directory',
  file: 'Refusing to use a write-journal file that is not a private regular file',
  destination:
    'Refusing to use a write-journal destination that is not a private regular file',
  changed: 'Write-journal path changed while it was being verified',
  noAnchor: 'Write-journal path has no filesystem anchor',
}

const FILE_MESSAGE = MESSAGES.file as string

/**
 * The proof the store needs, with platform differences behind it. Every method
 * is read-only except `ensureDirectory` and `secureNewFile`, which only ever
 * apply the private policy to entries this store is about to own.
 */
export interface PrivateStateGuard {
  /**
   * Prove the chain down to `directory` and that `directory` is itself private.
   * POSIX repairs a widened mode before proving it; Windows applies its exact
   * DACL to components it creates. Never creates the final directory on POSIX.
   */
  ensureDirectory(directory: string): Promise<void>
  /** Same proof without repairing anything; missing components are tolerated. */
  verifyChain(directory: string): Promise<void>
  /** Prove an existing journal file is private, or report it as absent. */
  verifyFile(file: string): Promise<Stats | undefined>
  /** Give a just-created empty file the platform's private policy. */
  secureNewFile(file: string): Promise<void>
  /** Prove an opened handle still names the verified private inode. */
  verifyOpenHandle(info: Stats | undefined, path: string): Promise<void>
}

export interface PosixPrivateStateGuardOptions {
  platform?: NodeJS.Platform
  /** `undefined` on a platform without POSIX ownership; injectable for tests. */
  effectiveUid?: number | undefined
  lstat?: (path: string) => Promise<Stats>
  /** macOS ACL inspection; defaults to the real `ls -lde` check on darwin. */
  darwinAcl?: (path: string) => Promise<void>
  messages?: PathGuardMessages
}

/**
 * POSIX (and macOS) implementation.
 *
 * `chmod` is used only as a best-effort *repair* of the one directory this
 * store owns, and it is always followed by re-inspection: a mode is believed
 * because it was read back, never because it was requested.
 */
export function createPosixPrivateStateGuard(
  options: PosixPrivateStateGuardOptions = {},
): PrivateStateGuard {
  const platform = options.platform ?? process.platform
  const effectiveUid = options.effectiveUid ?? currentEffectiveUid()
  const inspect = options.lstat ?? ((path: string) => lstat(path))
  const darwinAcl = options.darwinAcl
    ?? (platform === 'darwin' ? verifyNoGrantingDarwinAcl : undefined)
  const messages = { ...MESSAGES, ...options.messages }

  const inspectIfPresent = async (path: string): Promise<Stats | undefined> => {
    try {
      return await inspect(path)
    } catch (error) {
      if (isNotFoundError(error)) return undefined
      throw guardError('Write-journal path could not be inspected', error)
    }
  }

  /**
   * Re-inspect through macOS and confirm the inode did not change, so an ACL
   * decision is bound to the entry that was inspected rather than to a path
   * that may have been swapped in between.
   */
  const aclBound = async (path: string, before: Stats): Promise<Stats> => {
    if (platform !== 'darwin' || !darwinAcl) return before
    try {
      await darwinAcl(path)
    } catch (error) {
      throw guardError(
        'Refusing to use a write-journal path with a macOS ACL that grants access',
        error,
      )
    }
    const after = await inspectIfPresent(path)
    if (!after) {
      throw corrupt('Write-journal path disappeared while its ACL was being verified')
    }
    try {
      assertSameFileSystemEntry(before, after, messages.changed)
    } catch (error) {
      throw guardError('Write-journal path changed during ACL verification', error)
    }
    return after
  }

  const verifyChain = async (directory: string): Promise<void> => {
    for (const ancestor of ancestorPaths(directory)) {
      const info = await inspectIfPresent(ancestor)
      // Not created yet: there is nothing to prove, and the writer will be
      // verified again once it exists.
      if (!info) continue
      if (ancestor === directory) {
        assertPrivateDirectory(info, effectiveUid, messages)
        assertPrivateDirectory(await aclBound(ancestor, info), effectiveUid, messages)
        continue
      }
      try {
        assertSafePosixAncestor(info, effectiveUid, messages)
      } catch (error) {
        throw guardError('Write-journal ancestor directory is unsafe', error)
      }
    }
  }

  return {
    async ensureDirectory(directory: string): Promise<void> {
      const existing = await inspectIfPresent(directory)
      if (existing && !existing.isDirectory()) {
        throw corrupt(
          'Refusing to use a write-journal directory path that is not a directory',
        )
      }
      if (existing && (existing.mode & 0o077) !== 0) {
        // Repair, then prove the repair: this is the one directory the journal
        // owns, and a widened mode is almost always an upgrade artefact rather
        // than an attack. Anything else about it — owner, type, ACL — is still
        // verified below and cannot be repaired.
        try {
          await chmod(directory, 0o700)
        } catch (error) {
          throw guardError('Write-journal directory permissions could not be tightened', error)
        }
      }
      await verifyChain(directory)
      if (!(await inspectIfPresent(directory))) {
        throw corrupt('Write-journal directory could not be created')
      }
    },

    verifyChain,

    async verifyFile(file: string): Promise<Stats | undefined> {
      const info = await inspectIfPresent(file)
      if (!info) return undefined
      assertPrivateFile(info, effectiveUid)
      assertPrivateFile(await aclBound(file, info), effectiveUid)
      return info
    },

    async secureNewFile(file: string): Promise<void> {
      try {
        await chmod(file, 0o600)
      } catch (error) {
        // The file was created with `wx` and mode 0o600, so a failed chmod
        // cannot have widened it; `verifyFile` still has the final word.
        if (!isNotFoundError(error)) {
          throw guardError('Write-journal file permissions could not be set', error)
        }
      }
    },

    async verifyOpenHandle(info: Stats | undefined, path: string): Promise<void> {
      // A handle that cannot report its own stat (an injected test double)
      // cannot be checked; the real filesystem adapter always can.
      if (!info) return
      const onDisk = await inspectIfPresent(path)
      if (!onDisk) {
        throw corrupt('Write-journal file disappeared before it was committed')
      }
      try {
        assertSameFileSystemEntry(info, onDisk, messages.changed)
      } catch (error) {
        throw guardError('Write-journal file changed between open and commit', error)
      }
      assertPrivateFile(info, effectiveUid)
    },
  }
}

export interface WindowsPrivateStateGuardOptions {
  lstat?: (path: string) => Promise<Stats>
}

/**
 * Windows implementation.
 *
 * Privacy on Windows is a DACL question, so every entry is checked by the
 * exact-DACL helper instead of by POSIX mode bits, which carry no meaning
 * there. Only the inode identity of an opened handle is compared locally.
 */
export function createWindowsPrivateStateGuard(
  resolveAcl: () => Promise<WindowsPrivateAcl>,
  options: WindowsPrivateStateGuardOptions = {},
): PrivateStateGuard {
  const inspect = options.lstat ?? ((path: string) => lstat(path))
  let acl: Promise<WindowsPrivateAcl> | undefined

  const inspectIfPresent = async (path: string): Promise<Stats | undefined> => {
    try {
      return await inspect(path)
    } catch (error) {
      if (isNotFoundError(error)) return undefined
      throw guardError('Write-journal path could not be inspected', error)
    }
  }

  const useAcl = async <T>(detail: string, action: (value: WindowsPrivateAcl) => Promise<T>): Promise<T> => {
    if (!acl) {
      acl = resolveAcl().catch(error => {
        acl = undefined
        throw error
      })
    }
    try {
      return await action(await acl)
    } catch (error) {
      if (error instanceof GarminWriteError) throw error
      throw guardError(detail, error)
    }
  }

  return {
    async ensureDirectory(directory: string): Promise<void> {
      await useAcl(
        'Write-journal directory could not be given a private DACL',
        aclValue => aclValue.prepareDirectory(directory),
      )
    },

    async verifyChain(directory: string): Promise<void> {
      await useAcl(
        'Write-journal directory DACL is not private',
        aclValue => aclValue.verifyDirectory(directory, { allowMissing: true }),
      )
    },

    async verifyFile(file: string): Promise<Stats | undefined> {
      const info = await inspectIfPresent(file)
      if (!info) return undefined
      await useAcl(
        'Write-journal file DACL is not private',
        aclValue => aclValue.verifyFile(file),
      )
      return info
    },

    async secureNewFile(file: string): Promise<void> {
      await useAcl(
        'Write-journal file could not be given a private DACL',
        aclValue => aclValue.secureFile(file),
      )
    },

    async verifyOpenHandle(info: Stats | undefined, path: string): Promise<void> {
      if (!info) return
      const onDisk = await inspectIfPresent(path)
      if (!onDisk) {
        throw corrupt('Write-journal file disappeared before it was committed')
      }
      try {
        assertSameFileSystemEntry(info, onDisk, MESSAGES.changed)
      } catch (error) {
        throw guardError('Write-journal file changed between open and commit', error)
      }
    },
  }
}

/** The guard for the running platform. */
export function defaultPrivateStateGuard(
  platform: NodeJS.Platform = process.platform,
): PrivateStateGuard {
  if (platform === 'win32') {
    return createWindowsPrivateStateGuard(() => createWindowsPrivateAcl())
  }
  return createPosixPrivateStateGuard({ platform })
}

function assertPrivateDirectory(
  info: Stats,
  effectiveUid: number | undefined,
  messages: PathGuardMessages,
): void {
  try {
    assertPrivatePosixParent(info, effectiveUid, messages)
  } catch (error) {
    throw guardError('Write-journal directory is not private', error)
  }
}

function assertPrivateFile(info: Stats, effectiveUid: number | undefined): void {
  try {
    assertPrivatePosixFile(info, effectiveUid, FILE_MESSAGE)
  } catch (error) {
    throw guardError('Write-journal file is not private', error)
  }
}

function corrupt(detail: string): GarminWriteError {
  return new GarminWriteError(WRITE_ERROR_CODES.STATE_CORRUPT, 'not_applied', detail)
}

/**
 * Turn a policy assertion into the typed, fail-closed error the coordinator
 * expects, keeping the assertion's own wording so the operator sees which
 * rule failed (owner, permissions, type, ACL or inode change).
 */
function guardError(detail: string, cause: unknown): GarminWriteError {
  const because = cause instanceof Error && cause.message ? cause.message : 'verification failed'
  return corrupt(`${detail}: ${because}`)
}

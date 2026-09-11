/**
 * Shared private-path verification.
 *
 * Both the session-token store and the write-operation journal keep
 * credentials-adjacent state under the user's home directory, and both need
 * the same proof before they trust a path: every ancestor is a real directory
 * owned by the effective user and not group/world writable, the final entry is
 * a single-link regular file with owner-only permissions, macOS ACLs grant
 * nothing beyond that, and the path is bound to the inspected inode so it
 * cannot be swapped between the check and the use.
 *
 * This module is the single implementation of that proof. The default messages
 * are the session-store wording so existing behaviour and diagnostics are
 * unchanged; callers guarding a different kind of state pass their own labels.
 */

import { type Stats } from 'node:fs'
import { basename, dirname } from 'node:path'
import { lstat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { verifyNoGrantingDarwinAcl } from './darwin-private-acl'

/** Overridable messages so one guard can describe session or journal state. */
export interface PathGuardMessages {
  directory?: string
  directoryOwner?: string
  directoryPermissions?: string
  anchor?: string
  file?: string
  destination?: string
  changed?: string
  noAnchor?: string
}

export function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

export function currentEffectiveUid(): number | undefined {
  return typeof process.geteuid === 'function' ? process.geteuid() : undefined
}

export function assertSameFileSystemEntry(
  left: Stats,
  right: Stats,
  message = 'Session path changed during verification',
): void {
  if (left.dev !== right.dev || left.ino !== right.ino) {
    throw new Error(message)
  }
}

/** Every path from the filesystem root down to (and including) `path`. */
export function ancestorPaths(path: string): string[] {
  const paths: string[] = []
  let current = path
  while (true) {
    paths.unshift(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return paths
}

export function assertSafePosixAncestor(
  info: Stats,
  effectiveUid: number | undefined,
  messages: PathGuardMessages = {},
): void {
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(messages.directory ?? 'Unsafe session directory')
  }
  if (
    effectiveUid !== undefined
    && info.uid !== 0
    && info.uid !== effectiveUid
  ) {
    throw new Error(messages.directoryOwner ?? 'Unsafe session directory owner')
  }
  if (
    (info.mode & 0o022) !== 0
    && !(info.uid === 0 && (info.mode & 0o1000) !== 0)
  ) {
    throw new Error(messages.directoryPermissions ?? 'Unsafe session directory permissions')
  }
}

export function assertPosixCreationAnchor(
  info: Stats,
  effectiveUid: number | undefined,
  messages: PathGuardMessages = {},
): void {
  if (
    !info.isDirectory()
    || info.isSymbolicLink()
    || (effectiveUid !== undefined && info.uid !== effectiveUid)
    || (info.mode & 0o300) !== 0o300
    || (info.mode & 0o022) !== 0
  ) {
    throw new Error(messages.anchor ?? 'Unsafe session directory anchor')
  }
}

export function assertPrivatePosixParent(
  info: Stats,
  effectiveUid: number | undefined,
  messages: PathGuardMessages = {},
): void {
  if (
    !info.isDirectory()
    || info.isSymbolicLink()
    || (effectiveUid !== undefined && info.uid !== effectiveUid)
    || (info.mode & 0o300) !== 0o300
    || (info.mode & 0o077) !== 0
  ) {
    throw new Error(messages.directory ?? 'Unsafe session directory')
  }
}

export function assertPrivatePosixFile(
  info: Stats,
  effectiveUid: number | undefined,
  message: string,
): void {
  if (
    !info.isFile()
    || info.isSymbolicLink()
    || info.nlink !== 1
    || (effectiveUid !== undefined && info.uid !== effectiveUid)
    || (info.mode & 0o077) !== 0
  ) {
    throw new Error(message)
  }
}

/** Re-inspect a path through macOS and confirm the inode did not change. */
export async function verifyDarwinAclBoundToEntry(
  path: string,
  before: Stats,
  messages: PathGuardMessages = {},
): Promise<Stats> {
  if (process.platform !== 'darwin') return before
  await verifyNoGrantingDarwinAcl(path)
  const after = await lstat(path)
  assertSameFileSystemEntry(before, after, messages.changed)
  return after
}

export async function verifySafePosixAncestorChain(
  path: string,
  messages: PathGuardMessages = {},
): Promise<void> {
  const effectiveUid = currentEffectiveUid()
  for (const ancestor of ancestorPaths(path)) {
    const before = await lstat(ancestor)
    assertSafePosixAncestor(before, effectiveUid, messages)
    const after = await verifyDarwinAclBoundToEntry(ancestor, before, messages)
    assertSafePosixAncestor(after, effectiveUid, messages)
  }
}

export async function verifyPosixCreationAnchor(
  path: string,
  messages: PathGuardMessages = {},
): Promise<void> {
  const effectiveUid = currentEffectiveUid()
  const before = await lstat(path)
  assertPosixCreationAnchor(before, effectiveUid, messages)
  const after = await verifyDarwinAclBoundToEntry(path, before, messages)
  assertPosixCreationAnchor(after, effectiveUid, messages)
}

export async function verifyPrivatePosixParent(
  path: string,
  messages: PathGuardMessages = {},
): Promise<void> {
  const effectiveUid = currentEffectiveUid()
  const before = await lstat(path)
  assertPrivatePosixParent(before, effectiveUid, messages)
  const after = await verifyDarwinAclBoundToEntry(path, before, messages)
  assertPrivatePosixParent(after, effectiveUid, messages)
}

export async function verifySafeExistingPosixDestination(
  path: string,
  messages: PathGuardMessages = {},
): Promise<void> {
  let info: Stats
  try {
    info = await lstat(path)
  } catch (error) {
    if (isNotFoundError(error)) return
    throw error
  }
  const effectiveUid = currentEffectiveUid()
  assertPrivatePosixFile(info, effectiveUid, messages.destination ?? 'Unsafe session destination')
  const after = await verifyDarwinAclBoundToEntry(path, info, messages)
  assertPrivatePosixFile(after, effectiveUid, messages.destination ?? 'Unsafe session destination')
}

export async function verifyPrivatePosixFileHandle(
  file: FileHandle,
  path: string,
  messages: PathGuardMessages = {},
): Promise<void> {
  const label = messages.file ?? 'Unsafe session file'
  const info = await file.stat()
  const effectiveUid = currentEffectiveUid()
  assertPrivatePosixFile(info, effectiveUid, label)
  const before = await lstat(path)
  assertSameFileSystemEntry(info, before, messages.changed)
  assertPrivatePosixFile(before, effectiveUid, label)
  const after = await verifyDarwinAclBoundToEntry(path, before, messages)
  assertSameFileSystemEntry(info, after, messages.changed)
  assertPrivatePosixFile(after, effectiveUid, label)
}

/**
 * Walk up from `path` until something exists, remembering the components that
 * do not. Used to verify the full ancestor chain before creating anything.
 */
export async function findDeepestExistingPath(
  path: string,
  messages: PathGuardMessages = {},
): Promise<{ existingPath: string; missingComponents: string[] }> {
  let current = path
  const missingComponents: string[] = []
  while (true) {
    try {
      await lstat(current)
      return { existingPath: current, missingComponents }
    } catch (error) {
      if (!isNotFoundError(error)) throw error
    }

    const parent = dirname(current)
    if (parent === current) throw new Error(messages.noAnchor ?? 'Session directory has no anchor')
    missingComponents.unshift(basename(current))
    current = parent
  }
}

/**
 * Identity primitives shared by the write journal.
 *
 * Three identifiers are deliberately kept separate:
 *   - confirmationId: approval of a specific preview revision, encoded so the
 *     binding survives a process restart (see `encodeConfirmationId`)
 *   - operationId:    server-generated receipt used to query/reconcile a write
 *   - idempotencyKey: caller-supplied stable request label (never stored verbatim)
 */

import { createHash } from 'node:crypto'
import type { GarminRegion } from '../config'
import { GarminWriteError, WRITE_ERROR_CODES } from './errors'

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

/** Result control fields that must never leak into a request hash or fingerprint. */
export const CONTROL_FIELDS = ['confirmed', 'confirmationId', 'idempotencyKey'] as const

/**
 * Drop caller-supplied control fields before a request is hashed or persisted.
 *
 * `idempotencyKey` in particular is caller metadata: it is not a Garmin
 * credential, but it may still contain something the caller does not expect to
 * find in a plaintext local file, so only its account-scoped hash is stored.
 * Only top-level keys are removed — a nested field is part of the payload the
 * caller actually asked for.
 */
export function stripResultControlFields(
  request: Record<string, unknown>,
): Record<string, unknown> {
  const clone: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(request)) {
    if ((CONTROL_FIELDS as readonly string[]).includes(key)) continue
    clone[key] = value
  }
  return clone
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * Deterministic JSON: object keys are sorted, `undefined` object values are
 * dropped (matching JSON.stringify), array order is preserved. Non-finite
 * numbers and circular references are rejected rather than silently coerced.
 */
export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>()

  const serialize = (input: unknown): string => {
    if (input === undefined) return 'null'
    if (input === null) return 'null'
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) throw new RangeError('Cannot canonicalize a non-finite number')
      return JSON.stringify(input)
    }
    if (typeof input === 'string' || typeof input === 'boolean') return JSON.stringify(input)
    if (typeof input === 'bigint') return JSON.stringify(input.toString())
    if (Array.isArray(input)) {
      if (seen.has(input)) throw new RangeError('Cannot canonicalize a circular value')
      seen.add(input)
      const encoded = `[${input.map(serialize).join(',')}]`
      seen.delete(input)
      return encoded
    }
    if (typeof input === 'object') {
      const record = input as Record<string, unknown>
      if (seen.has(record)) throw new RangeError('Cannot canonicalize a circular value')
      seen.add(record)
      const keys = Object.keys(record)
        .filter(key => record[key] !== undefined)
        .sort()
      const encoded = `{${keys
        .map(key => `${JSON.stringify(key)}:${serialize(record[key])}`)
        .join(',')}}`
      seen.delete(record)
      return encoded
    }
    throw new RangeError(`Cannot canonicalize a value of type ${typeof input}`)
  }

  return serialize(value)
}

/** Hash a normalized request for approval binding and idempotency-conflict checks. */
export function requestHash(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}

/**
 * Account scope key: same trimmed, NFKC-normalized, lowercased username in the
 * same region shares one journal; regions and distinct usernames never do.
 */
export function accountKey(username: string, region: GarminRegion): string {
  const normalized = username.trim().normalize('NFKC').toLowerCase()
  return sha256Hex(`${region}\u0000${normalized}`)
}

function encodeComponent(value: string): string {
  return encodeURIComponent(value)
}

/** account + workoutId + local date. Timezone deliberately excluded. */
export function scheduleBusinessKey(
  account: string,
  workoutId: string,
  date: string,
): string {
  return `schedule:${account}:${encodeComponent(workoutId)}:${date}`
}

/** account + exact workoutScheduleId. */
export function unscheduleBusinessKey(account: string, workoutScheduleId: string): string {
  return `unschedule:${account}:${encodeComponent(workoutScheduleId)}`
}

/** account + canonical workout-definition fingerprint. */
export function createBusinessKey(account: string, definitionFingerprint: string): string {
  return `create:${account}:${definitionFingerprint}`
}

/** Reject an out-of-contract idempotency key before any network access. */
export function assertIdempotencyKey(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new GarminWriteError(
      WRITE_ERROR_CODES.INVALID_IDEMPOTENCY_KEY,
      'not_applied',
      'Invalid idempotencyKey: use 1-128 characters from A-Z a-z 0-9 . _ : -',
    )
  }
  return value
}

/** Account-scoped hash of an idempotency key. The raw key is never persisted. */
export function idempotencyKeyHash(account: string, key: string): string {
  return sha256Hex(`${account}\u0000${key}`)
}

/**
 * The approval handle a caller receives from a preview and returns on confirm.
 *
 * It is *derived* from persisted state rather than kept in an in-process map,
 * so a confirmation issued before a restart is still resolvable after it, and
 * a re-preview that advances the revision invalidates the earlier handle in
 * every process — not just the one that issued it.
 *
 * Layout: `<operationId>:<previewRevision>`.
 */
export function encodeConfirmationId(operationId: string, previewRevision: number): string {
  return `${operationId}:${previewRevision}`
}

export function decodeConfirmationId(
  value: unknown,
): { operationId: string; previewRevision: number } | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 256) return undefined
  const separator = trimmed.lastIndexOf(':')
  if (separator <= 0) return undefined
  const operationId = trimmed.slice(0, separator)
  const rawRevision = trimmed.slice(separator + 1)
  if (!/^\d{1,9}$/.test(rawRevision)) return undefined
  return { operationId, previewRevision: Number(rawRevision) }
}

/** Strip result-control fields so they never influence the template fingerprint. */
export function workoutDefinitionForFingerprint(definition: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(definition)) {
    if ((CONTROL_FIELDS as readonly string[]).includes(key)) continue
    clone[key] = value
  }
  if (typeof clone.name === 'string') clone.name = clone.name.trim()
  if (clone.sport === undefined) clone.sport = 'running'
  return clone
}

/** Canonical template hash: real definition, real defaults, original step order. */
export function workoutDefinitionFingerprint(definition: Record<string, unknown>): string {
  return sha256Hex(canonicalJson(workoutDefinitionForFingerprint(definition)))
}

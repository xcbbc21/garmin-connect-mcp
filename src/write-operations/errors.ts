/**
 * Typed write-outcome contract.
 *
 * Callers must branch on `code` / `outcome`, never on human-readable text. The
 * one distinction that matters for safety is whether we have proof the write
 * did not reach Garmin (`not_applied`) or whether it is genuinely unknown.
 * `unknown` is never downgraded to `not_applied` without endpoint evidence.
 */

import { PublicToolError } from '../utils/errors'

export type WriteOutcome = 'not_applied' | 'unknown'

export const WRITE_ERROR_CODES = {
  /** A write whose remote outcome could not be determined. Never auto-retry. */
  WRITE_OUTCOME_UNKNOWN: 'WRITE_OUTCOME_UNKNOWN',
  /** The write is proven not to have been applied. */
  WRITE_NOT_APPLIED: 'WRITE_NOT_APPLIED',
  /** The local state directory is missing, unreadable or unwritable. */
  STATE_UNAVAILABLE: 'STATE_UNAVAILABLE',
  /** The local journal is corrupt, from a newer schema, or another account. */
  STATE_CORRUPT: 'STATE_CORRUPT',
  /** A calendar range could not be read completely enough to prove absence. */
  CALENDAR_INCOMPLETE: 'CALENDAR_INCOMPLETE',
  /** The region/host does not expose a verified calendar query. */
  CALENDAR_QUERY_UNSUPPORTED: 'CALENDAR_QUERY_UNSUPPORTED',
  /** The confirmationId is missing, malformed, already used or changed. */
  CONFIRMATION_INVALID: 'CONFIRMATION_INVALID',
  /** The preview expired before it was confirmed. */
  CONFIRMATION_STALE: 'CONFIRMATION_STALE',
  /** The same idempotency key was reused with a different request. */
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  /** The idempotency key violates the allowed character/length contract. */
  INVALID_IDEMPOTENCY_KEY: 'INVALID_IDEMPOTENCY_KEY',
  /** Another process or request currently owns this account's write lock. */
  OPERATION_BUSY: 'OPERATION_BUSY',
  /** No local operation matches the supplied identifier for this account. */
  OPERATION_NOT_FOUND: 'OPERATION_NOT_FOUND',
  /** More than one matching calendar entry already exists. */
  DUPLICATE_EXISTING: 'DUPLICATE_EXISTING',
  /** An arbitrary schedule ID cannot be verified in this region. */
  SCHEDULE_LOOKUP_UNSUPPORTED: 'SCHEDULE_LOOKUP_UNSUPPORTED',
  /** The requested resume cannot proceed without a new preview. */
  RESUME_REQUIRES_PREVIEW: 'RESUME_REQUIRES_PREVIEW',
} as const

export type WriteErrorCode = typeof WRITE_ERROR_CODES[keyof typeof WRITE_ERROR_CODES]

/**
 * A write error that carries an explicit outcome classification. Local
 * validation and pre-dispatch failures are `not_applied`; anything that may
 * have reached Garmin is `unknown`.
 */
export class GarminWriteError extends Error {
  override name = 'GarminWriteError'

  constructor(
    public readonly code: WriteErrorCode,
    public readonly outcome: WriteOutcome,
    message: string,
  ) {
    super(message)
  }
}

export function isGarminWriteError(error: unknown): error is GarminWriteError {
  return error instanceof GarminWriteError
}

/**
 * A Garmin transport failure that carries an explicit outcome classification.
 *
 * It intentionally extends `PublicToolError` so existing callers keep receiving
 * a message they may surface, while new code branches on `outcome` / `code`
 * instead of parsing that message.
 */
export class GarminWriteTransportError extends PublicToolError {
  override name = 'GarminWriteTransportError'

  constructor(
    public readonly outcome: WriteOutcome,
    public readonly code: WriteErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export function isWriteTransportError(error: unknown): error is GarminWriteTransportError {
  return error instanceof GarminWriteTransportError
}

/**
 * Conservative classification for anything thrown by a write transport.
 *
 * Only an explicit `not_applied` classification is trusted; everything else
 * becomes `unknown`, because a request that reached the network may still have
 * been applied even when it failed locally.
 */
export function classifyWriteFailure(error: unknown): {
  outcome: WriteOutcome
  code: WriteErrorCode
} {
  if (error instanceof GarminWriteTransportError) {
    return { outcome: error.outcome, code: error.code }
  }
  if (error instanceof GarminWriteError) {
    return { outcome: error.outcome, code: error.code }
  }
  return { outcome: 'unknown', code: WRITE_ERROR_CODES.WRITE_OUTCOME_UNKNOWN }
}

/** Build the `unknown` error used when a write may have reached Garmin. */
export function uncertainWriteError(detail: string): GarminWriteError {
  return new GarminWriteError(
    WRITE_ERROR_CODES.WRITE_OUTCOME_UNKNOWN,
    'unknown',
    `${detail}; outcome is unknown; reconcile the operation before retrying`,
  )
}

/** Build the `not_applied` error used when a write provably never dispatched. */
export function notAppliedWriteError(code: WriteErrorCode, detail: string): GarminWriteError {
  return new GarminWriteError(code, 'not_applied', detail)
}

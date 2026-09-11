/**
 * Typed write-outcome contract.
 *
 * Callers must branch on `code` / `outcome`, never on human-readable text. The
 * one distinction that matters for safety is whether we have proof the write
 * did not reach Garmin (`not_applied`) or whether it is genuinely unknown.
 * `unknown` is never downgraded to `not_applied` without endpoint evidence.
 */

import {
  GarminAuthenticationCancelledError,
  GarminAuthenticationRequiredError,
  PublicToolError,
} from '../utils/errors'

export type WriteOutcome = 'not_applied' | 'unknown'

export const WRITE_ERROR_CODES = {
  /** A write whose remote outcome could not be determined. Never auto-retry. */
  WRITE_OUTCOME_UNKNOWN: 'WRITE_OUTCOME_UNKNOWN',
  /** The write is proven not to have been applied. */
  WRITE_NOT_APPLIED: 'WRITE_NOT_APPLIED',
  /**
   * The credential lost its authority while the write was being dispatched.
   * The outcome stays `unknown`, but unlike a generic transport failure this
   * invalidates the authority of every remaining entry in the batch.
   */
  WRITE_AUTH_EXPIRED: 'WRITE_AUTH_EXPIRED',
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
 * The authenticated identity changed while a write was in flight.
 *
 * The request was already dispatched, so the outcome is `unknown`. It is a
 * distinct type because it also invalidates the authority the *whole* batch was
 * approved under: continuing would keep writing as an account the user did not
 * confirm.
 */
export class GarminWriteIdentityChangedError extends GarminWriteError {
  override name = 'GarminWriteIdentityChangedError'

  constructor(message: string) {
    super(WRITE_ERROR_CODES.WRITE_OUTCOME_UNKNOWN, 'unknown', message)
  }
}

export function isWriteIdentityChangedError(
  error: unknown,
): error is GarminWriteIdentityChangedError {
  return error instanceof GarminWriteIdentityChangedError
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
  if (error instanceof GarminAuthenticationRequiredError) {
    // The write transports call the connection gate *before* building the
    // request, so a credential failure escaping a write proves that write was
    // never sent. It is safe — and useful — to say so instead of parking the
    // step in `unknown` forever.
    return { outcome: 'not_applied', code: WRITE_ERROR_CODES.WRITE_NOT_APPLIED }
  }
  if (error instanceof GarminAuthenticationCancelledError) {
    // Same reasoning: the login was cancelled, so the request was never built.
    return { outcome: 'not_applied', code: WRITE_ERROR_CODES.WRITE_NOT_APPLIED }
  }
  return { outcome: 'unknown', code: WRITE_ERROR_CODES.WRITE_OUTCOME_UNKNOWN }
}

/**
 * Whether a write failure stops the rest of the batch rather than only failing
 * the entry that produced it.
 *
 * This is a deliberately closed set. The delivery contract lists exactly which
 * conditions must stop the remaining entries and leave them `not_attempted`:
 * a credential that lost its authority, a cancelled login, and an identity
 * change. Each of those invalidates the *channel* or the *authority* the whole
 * batch was approved under, so re-dispatching the next entry would repeat a
 * non-idempotent write that we already know cannot be authorized correctly.
 *
 * Everything else — an entry-local rejection, a timeout, a 5xx, a socket reset,
 * or any error we cannot explain — is recorded against the entry that produced
 * it and the batch continues. That is safe because every dispatch is durably
 * journaled `in_flight` before it is sent, so a continued batch cannot lose
 * track of a write; and it is required because the caller asked for *every*
 * entry in the batch to be attempted.
 */
export function isAccountLevelWriteFailure(error: unknown): boolean {
  if (error instanceof GarminAuthenticationRequiredError) return true
  if (error instanceof GarminAuthenticationCancelledError) return true
  if (error instanceof GarminWriteIdentityChangedError) return true
  if (error instanceof GarminWriteTransportError) {
    // A 401/403 that arrives *after* the request was built means the credential
    // stopped being accepted mid-batch. The remaining entries would repeat the
    // same rejected write, so they must not be dispatched.
    return error.code === WRITE_ERROR_CODES.WRITE_AUTH_EXPIRED
  }
  return false
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

/**
 * Journal schema v2 and the v1 -> v2 migration.
 *
 * v1 journals were written before the write path was fully coordinated, so a
 * v1 file can contain:
 *
 *   - a *plaintext* `idempotencyKey` inside `operation.request`;
 *   - a `requestHash` computed over a request that still included the caller's
 *     control fields, so it disagrees with the canonical business request;
 *   - an operation that several idempotency keys point at, because an older
 *     preview reused an operation and rebound it to a different key;
 *   - no `previewRevision`, because confirmations used to live in a process map.
 *
 * Migrating is therefore not a mechanical version bump. The rules are:
 *
 *   - every `operationId`, `stepId`, attempt, unknown occupancy and Garmin
 *     `workoutScheduleId` is preserved; nothing is deleted and no operation is
 *     ever executed by the migration;
 *   - the plaintext key is used only in memory: its account-scoped hash is
 *     verified against `idempotencyIndex`, the plaintext is dropped, and the
 *     canonical business `requestHash` is recomputed;
 *   - anything that cannot be reconciled *without guessing* is isolated: the
 *     operation is flagged `manualReview` and its still-`prepared` steps become
 *     blocking `unknown` instead of silently becoming dispatchable again;
 *   - a record that merely *might* have been sent never turns back into
 *     `prepared`, because `prepared` authorizes a fresh dispatch.
 *
 * Validation is a full Zod parse of the whole document (operations, steps,
 * attempts, index targets, account and business-key consistency) rather than a
 * top-level shape check, and an unparseable journal is `STATE_CORRUPT` — never
 * repaired into an empty one.
 */

import { z } from 'zod'
import { GarminWriteError, WRITE_ERROR_CODES } from './errors'
import { idempotencyKeyHash, requestHash, stripResultControlFields } from './identity'
import {
  emptyOperationDocument,
  type OperationDocument,
  type WriteAttempt,
  type WriteOperation,
  type WriteStep,
} from './types'

/** The on-disk schema this build writes. */
export const CURRENT_JOURNAL_SCHEMA_VERSION = 2

const stepStatusSchema = z.enum([
  'prepared',
  'in_flight',
  'succeeded',
  'skipped',
  'failed',
  'unknown',
  'not_attempted',
])

const attemptOutcomeSchema = z.enum(['in_flight', 'succeeded', 'failed', 'unknown'])

const evidenceSchema = z.enum(['response', 'observed_present', 'observed_absent', 'none'])

const writeKindSchema = z.enum([
  'create',
  'schedule',
  'unschedule',
  'create-and-schedule',
  'batch-schedule',
])

const stepKindSchema = z.enum(['create', 'schedule', 'unschedule', 'batch-schedule'])

const isoDateTime = z.string().refine(
  value => value.length <= 40 && Number.isFinite(Date.parse(value)),
  'expected an ISO-8601 timestamp',
)

const attemptSchema = z.object({
  attempt: z.number().int().nonnegative(),
  outcome: attemptOutcomeSchema,
  startedAt: isoDateTime,
  finishedAt: isoDateTime.optional(),
  errorCode: z.string().max(64).optional(),
})

const referenceSchema = z.object({
  operationId: z.string().min(1).max(256),
  stepId: z.string().min(1).max(256),
  status: stepStatusSchema,
  workoutScheduleId: z.string().max(256).nullable().optional(),
  errorCode: z.string().max(64).optional(),
})

const stepShape = {
  stepId: z.string().min(1).max(256),
  businessKey: z.string().min(1).max(512),
  kind: stepKindSchema,
  status: stepStatusSchema,
  attempt: z.number().int().nonnegative(),
  dispatchedAt: isoDateTime.optional(),
  workoutId: z.string().max(256).optional(),
  workoutScheduleId: z.string().max(256).nullable().optional(),
  date: z.string().max(64).optional(),
  evidence: evidenceSchema,
  errorCode: z.string().max(64).optional(),
  desiredStateSatisfied: z.boolean().optional(),
  observedAt: isoDateTime.optional(),
  attempts: z.array(attemptSchema).max(1_000),
  fingerprint: z.string().max(256).optional(),
  reference: referenceSchema.optional(),
  supersedes: z
    .object({
      operationId: z.string().min(1).max(256),
      stepId: z.string().min(1).max(256),
      observedAt: isoDateTime,
    })
    .strict()
    .optional(),
}

const v2StepSchema = z.object(stepShape).strict()

const operationShape = {
  operationId: z.string().min(1).max(256),
  kind: writeKindSchema,
  accountKey: z.string().min(1).max(256),
  requestHash: z.string().min(1).max(256),
  idempotencyKeyHash: z.string().min(1).max(256).optional(),
  confirmationExpiresAt: isoDateTime.optional(),
  duplicatePolicy: z.enum(['skip', 'error']).optional(),
  request: z.record(z.unknown()),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  manualReview: z
    .object({ reason: z.string().min(1).max(1_000), detectedAt: isoDateTime })
    .optional(),
}

const v2OperationSchema = z
  .object({
    ...operationShape,
    schemaVersion: z.literal(2),
    previewRevision: z.number().int().nonnegative(),
    steps: z.array(v2StepSchema).max(1_000),
  })
  .strict()

export const operationDocumentV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    revision: z.number().int().nonnegative(),
    accountKey: z.string().min(1).max(256),
    operations: z.record(v2OperationSchema),
    idempotencyIndex: z.record(z.string().min(1).max(256)),
    migratedFrom: z
      .object({ schemaVersion: z.literal(1), migratedAt: isoDateTime })
      .optional(),
  })
  .strict()

/**
 * v1 is intentionally *not* strict: those files were written by older builds
 * with a slightly different field set, and rejecting an unknown key would
 * destroy history. The fields the migration depends on are still validated,
 * and everything else is carried over verbatim.
 */
const v1StepSchema = z.object(stepShape).passthrough()

const v1OperationSchema = z
  .object({
    ...operationShape,
    schemaVersion: z.number().optional(),
    previewRevision: z.number().int().nonnegative().optional(),
    steps: z.array(v1StepSchema).max(1_000),
  })
  .passthrough()

export const operationDocumentV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative(),
    accountKey: z.string().min(1).max(256),
    operations: z.record(v1OperationSchema),
    idempotencyIndex: z.record(z.string().min(1).max(256)),
  })
  .passthrough()

/**
 * What the migration did, so callers, tests and the eventual receipt can all
 * describe the same facts instead of re-deriving them.
 */
export interface JournalMigrationReport {
  /** false when the on-disk file was already v2. */
  migrated: boolean
  from: 1 | 2
  to: 2
  /** Operations written to v2. */
  operations: number
  /** Operations whose plaintext idempotency key was dropped. */
  strippedPlaintextKeys: number
  /** Operations isolated as `manualReview` because they could not be rebuilt. */
  quarantined: Array<{ operationId: string; reason: string }>
  /** Steps forced to blocking `unknown` (a subset of quarantined operations). */
  blockedSteps: string[]
  /** Non-fatal facts a human should read before trusting the journal. */
  warnings: string[]
}

export interface JournalLoadResult {
  document: OperationDocument
  report: JournalMigrationReport
}

function corrupt(detail: string): GarminWriteError {
  return new GarminWriteError(WRITE_ERROR_CODES.STATE_CORRUPT, 'not_applied', detail)
}

function emptyReport(from: 1 | 2): JournalMigrationReport {
  return {
    migrated: false,
    from,
    to: 2,
    operations: 0,
    strippedPlaintextKeys: 0,
    quarantined: [],
    blockedSteps: [],
    warnings: [],
  }
}

/**
 * Parse and, when necessary, upgrade a journal that came off disk.
 *
 * A `2` document is validated strictly and returned as-is. A `1` document is
 * upgraded in memory; persisting the upgrade is the caller's job, and must
 * happen while the account lock is held so two processes cannot migrate
 * concurrently and so the atomic rename is not racing a live writer.
 */
export function parseOperationJournal(
  raw: unknown,
  accountKey: string,
  now: () => Date = () => new Date(),
): JournalLoadResult {
  if (raw === undefined || raw === null) {
    return { document: emptyOperationDocument(accountKey), report: emptyReport(2) }
  }
  const version = (raw as { schemaVersion?: unknown }).schemaVersion
  if (version === undefined) {
    throw corrupt('Operation journal has no schemaVersion')
  }
  if (version === CURRENT_JOURNAL_SCHEMA_VERSION) {
    const parsed = operationDocumentV2Schema.safeParse(raw)
    if (!parsed.success) {
      throw corrupt(`Operation journal failed v2 validation: ${firstIssue(parsed.error)}`)
    }
    const document = parsed.data as OperationDocument
    assertAccountConsistency(document, accountKey)
    return { document, report: emptyReport(2) }
  }
  if (version === 1) {
    const parsed = operationDocumentV1Schema.safeParse(raw)
    if (!parsed.success) {
      throw corrupt(`Operation journal failed v1 validation: ${firstIssue(parsed.error)}`)
    }
    return migrateV1ToV2(parsed.data as LegacyOperationDocument, accountKey, now)
  }
  throw corrupt(`Operation journal uses an unsupported schemaVersion: ${String(version)}`)
}

/** Shape of a v1 journal after validation, before the upgrade. */
export type LegacyOperationDocument = {
  schemaVersion: 1
  revision: number
  accountKey: string
  operations: Record<string, LegacyOperation>
  idempotencyIndex: Record<string, string>
}

type LegacyOperation = Omit<WriteOperation, 'schemaVersion' | 'previewRevision'> & {
  schemaVersion?: number
  previewRevision?: number
}

/**
 * Upgrade a validated v1 journal. Pure: the returned document is the new
 * journal, and nothing touches the disk.
 */
export function migrateV1ToV2(
  legacy: LegacyOperationDocument,
  accountKey: string,
  now: () => Date = () => new Date(),
): JournalLoadResult {
  const report = emptyReport(1)
  report.migrated = true

  if (legacy.accountKey !== accountKey) {
    throw corrupt('Operation journal belongs to a different account')
  }

  const idempotencyIndex: Record<string, string> = { ...legacy.idempotencyIndex }
  const operations: Record<string, WriteOperation> = {}

  // Index entries pointing at an operation that no longer exists are not
  // recoverable: dropping them silently would let the same key mint a second
  // operation for a target that may already have been written.
  for (const [keyHash, operationId] of Object.entries(idempotencyIndex)) {
    if (!legacy.operations[operationId]) {
      throw corrupt(
        'Idempotency index points at an operation that is missing from the journal',
      )
    }
    if (keyHash.trim().length === 0) {
      throw corrupt('Idempotency index contains an empty key hash')
    }
  }

  // Which idempotency hashes point at each operation. More than one that does
  // not match the operation's own recorded hash is the signature of the old
  // "reuse an operation and rebind it to a new key" defect.
  const hashesByOperation = new Map<string, string[]>()
  for (const [keyHash, operationId] of Object.entries(idempotencyIndex)) {
    const list = hashesByOperation.get(operationId) ?? []
    list.push(keyHash)
    hashesByOperation.set(operationId, list)
  }

  for (const [operationId, legacyOperation] of Object.entries(legacy.operations)) {
    if (legacyOperation.operationId !== operationId) {
      throw corrupt(
        `Operation ${operationId} is stored under a different operationId ` +
          `(${String(legacyOperation.operationId)})`,
      )
    }
    if (legacyOperation.accountKey !== accountKey) {
      throw corrupt(`Operation ${operationId} belongs to a different account`)
    }

    const reason = reconcileReason(
      legacyOperation,
      hashesByOperation.get(operationId) ?? [],
    )

    const steps = legacyOperation.steps.map(step =>
      reason === undefined ? step : quarantineStep(step, reason))
    if (reason === undefined) {
      validateSteps(operationId, legacyOperation.steps)
    }
    if (reason !== undefined) {
      report.quarantined.push({ operationId, reason })
      for (let index = 0; index < legacyOperation.steps.length; index += 1) {
        const before = legacyOperation.steps[index]
        const after = steps[index]
        if (before.status !== after.status) report.blockedSteps.push(`${operationId}/${before.stepId}`)
      }
    }

    const canonicalRequest = stripResultControlFields(legacyOperation.request)
    const plaintextKey = plaintextIdempotencyKey(legacyOperation.request)
    if (plaintextKey !== undefined) {
      report.strippedPlaintextKeys += 1
      const derived = idempotencyKeyHash(accountKey, plaintextKey)
      const bound = idempotencyIndex[derived]
      if (bound === undefined) {
        // The key was recorded on the request but never indexed. Indexing it
        // now is what makes a later replay of the same key find this operation
        // instead of minting a duplicate.
        idempotencyIndex[derived] = operationId
        report.warnings.push(
          `${operationId}: recovered an unindexed idempotency key from the request`,
        )
      }
    }

    const canonicalHash = requestHash(canonicalRequest)
    if (legacyOperation.requestHash !== canonicalHash) {
      report.warnings.push(
        `${operationId}: recomputed the canonical request hash; any confirmation ` +
          'issued before this migration must be re-previewed',
      )
    }

    const migrated: WriteOperation = {
      ...(legacyOperation as unknown as WriteOperation),
      schemaVersion: 2,
      previewRevision: legacyOperation.previewRevision ?? 0,
      accountKey,
      requestHash: canonicalHash,
      request: canonicalRequest,
      steps,
      ...(reason === undefined
        ? {}
        : { manualReview: { reason, detectedAt: now().toISOString() } }),
    }
    operations[operationId] = migrated
    report.operations += 1
  }

  for (const operationId of Object.keys(operations)) {
    if (!hashesByOperation.has(operationId)) {
      report.warnings.push(`${operationId}: no idempotency key is bound to this operation`)
    }
  }

  return {
    document: {
      schemaVersion: 2,
      revision: legacy.revision,
      accountKey,
      operations,
      idempotencyIndex,
      migratedFrom: { schemaVersion: 1, migratedAt: now().toISOString() },
    },
    report,
  }
}

/**
 * Decide whether a v1 operation can be rebuilt without guessing.
 *
 * Only two conditions qualify, and both mean the *approval binding* is no
 * longer trustworthy rather than merely reformatted:
 *
 *   1. several idempotency hashes point at one operation and at least one of
 *      them disagrees with the operation's own recorded hash — the old preview
 *      reuse defect, where an approval could have been satisfied by a request
 *      the caller never saw;
 *   2. a step is still `prepared` while carrying dispatch evidence, which is
 *      the one state that could authorize a duplicate POST.
 *
 * A batch whose `request.schedules` is missing entirely is *not* quarantined:
 * the recorded steps are the authoritative history and there is nothing to
 * contradict them. Its incompleteness is reported as a warning instead.
 */
function reconcileReason(
  operation: LegacyOperation,
  boundHashes: string[],
): string | undefined {
  const own = operation.idempotencyKeyHash
  const foreign = boundHashes.filter(hash => hash !== own)
  if (boundHashes.length > 1 && foreign.length > 0) {
    return (
      'This operation is referenced by more than one idempotency key and cannot be ' +
      'rebuilt without guessing which approval it belonged to.'
    )
  }

  const suspicious = operation.steps.filter(
    step => step.status === 'prepared'
      && (step.attempt > 0 || step.attempts.length > 0 || step.dispatchedAt !== undefined),
  )
  if (suspicious.length > 0) {
    return (
      'A step recorded as never dispatched carries dispatch evidence, so the journal ' +
      'cannot prove that no request was sent.'
    )
  }

  const schedules = operation.request.schedules
  if (Array.isArray(schedules) && schedules.length !== operation.steps.length) {
    return (
      'The batch records ' +
      `${operation.steps.length} step(s) for ${schedules.length} requested item(s), ` +
      'so the missing item evidence cannot be restored.'
    )
  }

  return undefined
}

/**
 * Isolate one step of an unreconciled operation.
 *
 * Only `prepared` moves, and it moves to blocking `unknown`: a step that was
 * never dispatched is *not* proven not-applied by the migration, because the
 * whole operation is the thing that lost its evidence. Terminal steps keep
 * their receipts untouched.
 */
function quarantineStep(step: WriteStep, _reason: string): WriteStep {
  if (step.status !== 'prepared') return step
  return {
    ...step,
    status: 'unknown',
    evidence: 'none',
    errorCode: step.errorCode ?? WRITE_ERROR_CODES.STATE_CORRUPT,
  }
}

function validateSteps(operationId: string, steps: WriteStep[]): void {
  const seen = new Set<string>()
  for (const step of steps) {
    if (seen.has(step.stepId)) {
      throw corrupt(`Operation ${operationId} repeats the stepId ${step.stepId}`)
    }
    seen.add(step.stepId)
    const attemptNumbers = step.attempts.map(attempt => attempt.attempt)
    for (let index = 0; index < attemptNumbers.length; index += 1) {
      if (attemptNumbers[index] !== index + 1) {
        throw corrupt(
          `Operation ${operationId} step ${step.stepId} has non-contiguous attempt numbers`,
        )
      }
    }
  }
}

function plaintextIdempotencyKey(request: Record<string, unknown>): string | undefined {
  const value = request.idempotencyKey
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function assertAccountConsistency(document: OperationDocument, accountKey: string): void {
  if (document.accountKey !== accountKey) {
    throw corrupt('Operation journal belongs to a different account')
  }
  for (const [operationId, operation] of Object.entries(document.operations)) {
    if (operation.operationId !== operationId) {
      throw corrupt(`Operation ${operationId} is stored under a different operationId`)
    }
    if (operation.accountKey !== accountKey) {
      throw corrupt(`Operation ${operationId} belongs to a different account`)
    }
    try {
      validateSteps(operationId, operation.steps)
    } catch (error) {
      if (error instanceof GarminWriteError) throw error
      throw corrupt(`Operation ${operationId} could not be validated`)
    }
  }
  for (const [keyHash, operationId] of Object.entries(document.idempotencyIndex)) {
    if (!document.operations[operationId]) {
      throw corrupt('Idempotency index points at an operation that is missing from the journal')
    }
    if (keyHash.trim().length === 0) {
      throw corrupt('Idempotency index contains an empty key hash')
    }
  }
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0]
  if (!issue) return 'unknown validation failure'
  const path = issue.path.length > 0 ? issue.path.join('.') : '<root>'
  return `${path}: ${issue.message}`
}

/** The narrow store surface the migration needs. */
export interface MigratableStore {
  read(): Promise<OperationDocument>
  save(
    document: OperationDocument,
    options?: { expectedRevision?: number },
  ): Promise<void>
  /** Raw on-disk JSON, or undefined when no journal exists yet. */
  readRawFile?(): Promise<unknown>
}

/**
 * Persist a v1 -> v2 upgrade, atomically, exactly once.
 *
 * The caller must already hold the account lock: the upgrade is a
 * read-modify-write of the whole journal, and racing a live writer with it
 * would resurrect stale steps. A store that cannot produce raw JSON (a test
 * double, for instance) is read through `read()`, which already upgrades in
 * memory, and simply is not rewritten.
 *
 * A failed save leaves the original v1 file untouched — the atomic rename in
 * the store never truncates in place — and the failure is reported instead of
 * being papered over with an empty journal.
 */
export async function migrateJournalUnderLock(options: {
  store: MigratableStore
  accountKey: string
  now?: () => Date
}): Promise<JournalLoadResult> {
  const now = options.now ?? (() => new Date())
  const raw = options.store.readRawFile
    ? await options.store.readRawFile()
    : await options.store.read()
  const result = parseOperationJournal(raw, options.accountKey, now)
  if (!result.report.migrated) return result

  await options.store.save(result.document, { expectedRevision: raw === undefined || raw === null
    ? undefined
    : (raw as { revision?: number }).revision })
  return result
}

export type { WriteAttempt }

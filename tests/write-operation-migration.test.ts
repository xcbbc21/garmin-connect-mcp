/**
 * v1 -> v2 journal migration (C3).
 *
 * These tests exist because "migrate the journal" is not a version bump. A v1
 * file can carry a plaintext idempotency key, a request hash computed over a
 * request that still contained caller control fields, and — worst case — an
 * operation that two different idempotency keys pointed at because an older
 * preview rebound a reused operation.
 *
 * The migration must therefore:
 *   - keep every operationId, stepId, attempt, unknown occupancy, Garmin
 *     workoutScheduleId and batch order;
 *   - drop the plaintext key while keeping (or recovering) its hash;
 *   - never re-derive a `prepared` step from a record that might have been
 *     sent, and isolate what cannot be rebuilt without guessing;
 *   - never repair an unreadable journal into an empty one, and never leave the
 *     file in a worse state when the upgrade itself fails;
 *   - run under the account lock so two processes cannot race the rename.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GarminWriteError, WRITE_ERROR_CODES } from '../src/write-operations/errors'
import {
  CURRENT_JOURNAL_SCHEMA_VERSION,
  migrateJournalUnderLock,
  parseOperationJournal,
} from '../src/write-operations/migration'
import { FileOperationStore, nodeStoreFileSystem, type WriteStoreFileSystem } from '../src/write-operations/store'
import { FileAccountLock } from '../src/write-operations/lock'
import {
  accountKey,
  idempotencyKeyHash,
  requestHash,
  stripResultControlFields,
} from '../src/write-operations/identity'
import { WriteCoordinator } from '../src/write-operations/coordinator'
import type { OperationDocument } from '../src/write-operations/types'

const ACCOUNT = 'account-under-test'
const NOW = () => new Date('2026-09-11T12:00:00.000Z')

// ---------------------------------------------------------------------------
// v1 fixtures. Deliberately built from plain objects (not the v2 types) so the
// tests describe the on-disk legacy shape rather than the current one.
// ---------------------------------------------------------------------------

function v1Step(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stepId: 'step-1',
    businessKey: 'bk-1',
    kind: 'schedule',
    status: 'prepared',
    attempt: 0,
    evidence: 'none',
    attempts: [],
    ...over,
  }
}

function v1Operation(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    operationId: 'op-1',
    kind: 'schedule',
    accountKey: ACCOUNT,
    requestHash: 'legacy-hash',
    request: { operation: 'schedule', workoutId: 'w1', date: '2026-09-20' },
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
    steps: [v1Step()],
    ...over,
  }
}

function v1Document(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    revision: 7,
    accountKey: ACCOUNT,
    operations: (over.operations as Record<string, unknown> | undefined) ?? { 'op-1': v1Operation() },
    idempotencyIndex: (over.idempotencyIndex as Record<string, string> | undefined) ?? {},
    ...over,
  }
}

/** A v2 journal, for the cases that must be validated rather than migrated. */
function v2Document(operations: Record<string, unknown>): Record<string, unknown> {
  return { ...v1Document(), schemaVersion: 2, operations }
}

function parse(document: Record<string, unknown>) {
  return parseOperationJournal(document, ACCOUNT, NOW)
}

// ---------------------------------------------------------------------------

describe('parseOperationJournal: gatekeeping', () => {
  it('treats a missing file as a fresh v2 journal without claiming a migration', () => {
    const { document, report } = parseOperationJournal(undefined, ACCOUNT, NOW)
    expect(document).toEqual({
      schemaVersion: 2,
      revision: 0,
      accountKey: ACCOUNT,
      operations: {},
      idempotencyIndex: {},
    })
    expect(report).toMatchObject({ migrated: false, from: 2, operations: 0 })
  })

  it('accepts a current v2 journal unchanged', () => {
    const v2 = v2Document({
      'op-1': v1Operation({ schemaVersion: 2, previewRevision: 4 }),
    })
    const { document, report } = parse(v2)
    expect(report.migrated).toBe(false)
    expect(document.operations['op-1'].previewRevision).toBe(4)
  })

  it('rejects a journal with no schemaVersion rather than guessing', () => {
    const legacy = v1Document()
    delete legacy.schemaVersion
    expect(() => parse(legacy)).toThrow(
      expect.objectContaining({ code: WRITE_ERROR_CODES.STATE_CORRUPT }),
    )
  })

  it.each([0, 3, '2', null])(
    'rejects the unsupported schemaVersion %p',
    (version) => {
      expect(() => parse({ ...v1Document(), schemaVersion: version })).toThrow(
        expect.objectContaining({ code: WRITE_ERROR_CODES.STATE_CORRUPT }),
      )
    },
  )

  it('rejects a v2 journal that fails strict validation instead of reading it loosely', () => {
    const v2 = v2Document({
      'op-1': { ...v1Operation({ schemaVersion: 2, previewRevision: 0 }), unexpectedField: true },
    })
    expect(() => parse(v2)).toThrow(
      expect.objectContaining({ code: WRITE_ERROR_CODES.STATE_CORRUPT }),
    )
  })

  it('rejects a v2 journal whose step status is not a known status', () => {
    const v2 = v2Document({
      'op-1': v1Operation({
        schemaVersion: 2,
        previewRevision: 0,
        steps: [v1Step({ status: 'probably-fine' })],
      }),
    })
    expect(() => parse(v2)).toThrow(
      expect.objectContaining({ code: WRITE_ERROR_CODES.STATE_CORRUPT }),
    )
  })
})

describe('migrateV1ToV2: fidelity', () => {
  it('preserves every identifier, attempt, schedule id and batch position', () => {
    const legacy = v1Document({
      operations: {
        'op-batch': v1Operation({
          operationId: 'op-batch',
          kind: 'batch-schedule',
          request: {
            operation: 'batch-schedule',
            timezone: 'Asia/Shanghai',
            schedules: [
              { workoutId: 'A', date: '2026-09-20' },
              { workoutId: 'B', date: '2026-09-21' },
              { workoutId: 'C', date: '2026-09-22' },
            ],
          },
          steps: [
            v1Step({
              stepId: 's-1', businessKey: 'bk-A', status: 'succeeded',
              attempt: 1, evidence: 'response', workoutScheduleId: 'sid-A',
              attempts: [{ attempt: 1, outcome: 'succeeded', startedAt: '2026-09-10T00:00:00.000Z' }],
            }),
            v1Step({
              stepId: 's-2', businessKey: 'bk-B', status: 'unknown',
              attempt: 1, evidence: 'none', errorCode: 'WRITE_OUTCOME_UNKNOWN',
              attempts: [{
                attempt: 1, outcome: 'unknown', startedAt: '2026-09-10T00:01:00.000Z',
                finishedAt: '2026-09-10T00:01:05.000Z', errorCode: 'WRITE_OUTCOME_UNKNOWN',
              }],
            }),
            v1Step({
              stepId: 's-3', businessKey: 'bk-C', status: 'not_attempted', evidence: 'none',
            }),
          ],
        }),
      },
    })

    const { document, report } = parse(legacy)
    expect(report.migrated).toBe(true)
    expect(report.operations).toBe(1)
    expect(document.schemaVersion).toBe(CURRENT_JOURNAL_SCHEMA_VERSION)
    expect(document.revision).toBe(7)
    expect(document.migratedFrom).toEqual({
      schemaVersion: 1,
      migratedAt: '2026-09-11T12:00:00.000Z',
    })

    const operation = document.operations['op-batch']
    expect(operation.operationId).toBe('op-batch')
    expect(operation.steps.map(step => step.stepId)).toEqual(['s-1', 's-2', 's-3'])
    expect(operation.steps.map(step => step.businessKey)).toEqual(['bk-A', 'bk-B', 'bk-C'])
    expect(operation.steps.map(step => step.status))
      .toEqual(['succeeded', 'unknown', 'not_attempted'])
    expect(operation.steps[0].workoutScheduleId).toBe('sid-A')
    expect(operation.steps[0].attempts).toHaveLength(1)
    expect(operation.steps[1].attempts[0]).toMatchObject({
      attempt: 1, outcome: 'unknown', errorCode: 'WRITE_OUTCOME_UNKNOWN',
    })
    // The unknown occupancy is what makes the journal useful across restarts.
    // Nothing may quietly turn it into something dispatchable.
    expect(operation.manualReview).toBeUndefined()
  })

  it('defaults a missing previewRevision to 0 and keeps an existing one', () => {
    const legacy = v1Document({
      operations: {
        'op-a': v1Operation({ operationId: 'op-a' }),
        'op-b': v1Operation({ operationId: 'op-b', previewRevision: 3 }),
      },
    })
    const { document } = parse(legacy)
    expect(document.operations['op-a'].previewRevision).toBe(0)
    expect(document.operations['op-b'].previewRevision).toBe(3)
  })

  it('never upgrades any recorded step into a satisfied state', () => {
    const statuses = ['prepared', 'in_flight', 'succeeded', 'skipped', 'failed', 'unknown', 'not_attempted']
    const legacy = v1Document({
      operations: Object.fromEntries(statuses.map(status => [
        `op-${status}`,
        v1Operation({ operationId: `op-${status}`, steps: [v1Step({ stepId: `s-${status}`, status })] }),
      ])),
    })
    const { document } = parse(legacy)
    for (const status of statuses) {
      expect(document.operations[`op-${status}`].steps[0].status).toBe(status)
    }
  })

  it('carries a step reference through untouched', () => {
    const reference = {
      operationId: 'op-other', stepId: 's-other', status: 'unknown' as const,
      errorCode: 'WRITE_OUTCOME_UNKNOWN',
    }
    const legacy = v1Document({
      operations: {
        'op-1': v1Operation({ steps: [v1Step({ reference, status: 'unknown' })] }),
      },
    })
    expect(parse(legacy).document.operations['op-1'].steps[0].reference).toEqual(reference)
  })
})

describe('migrateV1ToV2: plaintext idempotency key', () => {
  it('drops the plaintext key, keeps its hash and recomputes the canonical hash', () => {
    const plaintext = 'caller-supplied-secret'
    const rawRequest = {
      operation: 'schedule', workoutId: 'w1', date: '2026-09-20',
      idempotencyKey: plaintext, confirmed: true, confirmationId: 'op-1:0',
    }
    const keyHash = idempotencyKeyHash(ACCOUNT, plaintext)
    const legacy = v1Document({
      operations: { 'op-1': v1Operation({ request: rawRequest, idempotencyKeyHash: keyHash }) },
      idempotencyIndex: { [keyHash]: 'op-1' },
    })

    const { document, report } = parse(legacy)
    const operation = document.operations['op-1']

    // The plaintext must be gone from the active journal, from every angle.
    expect(operation.request).not.toHaveProperty('idempotencyKey')
    expect(operation.request).not.toHaveProperty('confirmed')
    expect(operation.request).not.toHaveProperty('confirmationId')
    expect(JSON.stringify(document)).not.toContain(plaintext)
    expect(operation.idempotencyKeyHash).toBe(keyHash)
    expect(document.idempotencyIndex[keyHash]).toBe('op-1')
    expect(report.strippedPlaintextKeys).toBe(1)

    // The hash is canonical: exactly what a fresh preview of the same request
    // would compute, so a later replay of the key binds to this operation.
    expect(operation.requestHash).toBe(requestHash(stripResultControlFields(rawRequest)))
    expect(operation.requestHash).not.toBe('legacy-hash')
    expect(report.warnings.join(' ')).toContain('re-previewed')
  })

  it('recovers an idempotency key that was on the request but never indexed', () => {
    const plaintext = 'unindexed-key'
    const keyHash = idempotencyKeyHash(ACCOUNT, plaintext)
    const legacy = v1Document({
      operations: {
        'op-1': v1Operation({
          idempotencyKeyHash: keyHash,
          request: { operation: 'schedule', workoutId: 'w1', idempotencyKey: plaintext },
        }),
      },
      idempotencyIndex: {},
    })

    const { document, report } = parse(legacy)
    // Without the recovery the same key would mint a second operation on the
    // next preview, which is exactly the duplicate the journal exists to stop.
    expect(document.idempotencyIndex[keyHash]).toBe('op-1')
    expect(report.warnings.join(' ')).toContain('unindexed idempotency key')
  })

  it('leaves a request without a key untouched and warns that nothing is bound', () => {
    const { document, report } = parse(v1Document())
    expect(report.strippedPlaintextKeys).toBe(0)
    expect(document.idempotencyIndex).toEqual({})
    expect(document.operations['op-1'].requestHash).toBe(
      requestHash({ operation: 'schedule', workoutId: 'w1', date: '2026-09-20' }),
    )
    expect(report.warnings.join(' ')).toContain('no idempotency key is bound')
  })
})

describe('migrateV1ToV2: quarantine rather than guess', () => {
  it('isolates an operation that several disagreeing keys point at', () => {
    const legacy = v1Document({
      operations: {
        'op-1': v1Operation({
          idempotencyKeyHash: 'hash-own',
          steps: [v1Step({ status: 'prepared' })],
        }),
      },
      // The old preview reuse defect: an operation rebound to a second key.
      idempotencyIndex: { 'hash-own': 'op-1', 'hash-foreign': 'op-1' },
    })

    const { document, report } = parse(legacy)
    expect(report.quarantined).toHaveLength(1)
    expect(report.quarantined[0].operationId).toBe('op-1')
    expect(document.operations['op-1'].manualReview?.reason).toContain('more than one idempotency key')
    // `prepared` authorizes a dispatch; it must not survive as such.
    expect(document.operations['op-1'].steps[0].status).toBe('unknown')
    expect(report.blockedSteps).toEqual(['op-1/step-1'])
  })

  it('isolates a prepared step that carries dispatch evidence', () => {
    const legacy = v1Document({
      operations: {
        'op-1': v1Operation({
          steps: [
            v1Step({ stepId: 's-dirty', status: 'prepared', attempt: 1 }),
            v1Step({ stepId: 's-clean', status: 'prepared' }),
            v1Step({
              stepId: 's-done', status: 'succeeded', attempt: 1,
              evidence: 'response', workoutScheduleId: 'sid',
            }),
          ],
        }),
      },
    })

    const { document, report } = parse(legacy)
    const steps = document.operations['op-1'].steps
    expect(steps.map(step => step.status)).toEqual(['unknown', 'unknown', 'succeeded'])
    // The already-proven receipt is not touched, only the ambiguity is blocked.
    expect(steps[2].workoutScheduleId).toBe('sid')
    expect(report.blockedSteps).toEqual(['op-1/s-dirty', 'op-1/s-clean'])
  })

  it('does not treat a zeroed prepared step as suspicious', () => {
    const legacy = v1Document({
      operations: { 'op-1': v1Operation({ steps: [v1Step({ status: 'prepared' })] }) },
    })
    const { document, report } = parse(legacy)
    expect(report.quarantined).toEqual([])
    expect(document.operations['op-1'].manualReview).toBeUndefined()
    expect(document.operations['op-1'].steps[0].status).toBe('prepared')
  })

  it('isolates a batch whose step count contradicts the recorded request', () => {
    const legacy = v1Document({
      operations: {
        'op-1': v1Operation({
          kind: 'batch-schedule',
          request: {
            operation: 'batch-schedule',
            schedules: [{ workoutId: 'A', date: '2026-09-20' }, { workoutId: 'B', date: '2026-09-21' }],
          },
          steps: [v1Step({ stepId: 's-A', businessKey: 'bk-A' })],
        }),
      },
    })
    const { document, report } = parse(legacy)
    expect(report.quarantined).toHaveLength(1)
    expect(document.operations['op-1'].steps[0].status).toBe('unknown')
  })

  it('only warns when a batch request omits schedules entirely', () => {
    const legacy = v1Document({
      operations: {
        'op-1': v1Operation({
          kind: 'batch-schedule',
          request: { operation: 'batch-schedule', timezone: 'Asia/Shanghai' },
          steps: [v1Step({ stepId: 's-A', businessKey: 'bk-A' })],
        }),
      },
    })
    const { document, report } = parse(legacy)
    // The recorded steps are authoritative history; there is nothing to
    // contradict them, so they must not be destroyed by a guess.
    expect(report.quarantined).toEqual([])
    expect(document.operations['op-1'].steps[0].status).toBe('prepared')
  })
})

describe('migrateV1ToV2: fail closed', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['the index points at a missing operation', v1Document({ idempotencyIndex: { h: 'op-gone' } })],
    ['an operation is stored under a different id', v1Document({
      operations: { 'op-1': v1Operation({ operationId: 'op-other' }) },
    })],
    ['an operation belongs to another account', v1Document({
      operations: { 'op-1': v1Operation({ accountKey: 'someone-else' }) },
    })],
    ['the document belongs to another account', { ...v1Document(), accountKey: 'someone-else' }],
    ['the index contains an empty key hash', v1Document({ idempotencyIndex: { '  ': 'op-1' } })],
    ['a step repeats its stepId', v1Document({
      operations: {
        'op-1': v1Operation({ steps: [v1Step({ stepId: 'dup' }), v1Step({ stepId: 'dup' })] }),
      },
    })],
    ['attempt numbers are not contiguous', v1Document({
      operations: {
        'op-1': v1Operation({
          steps: [v1Step({
            status: 'not_attempted',
            attempts: [{ attempt: 2, outcome: 'failed', startedAt: '2026-09-10T00:00:00.000Z' }],
          })],
        }),
      },
    })],
    ['a step is missing its evidence classification', v1Document({
      operations: { 'op-1': v1Operation({ steps: [(() => { const s = v1Step(); delete s.evidence; return s })()] }) },
    })],
    ['revision is negative', { ...v1Document(), revision: -1 }],
    ['operations is not a record', { ...v1Document(), operations: [] }],
  ]

  it.each(cases)('refuses to migrate when %s', (_label, legacy) => {
    expect(() => parse(legacy)).toThrow(
      expect.objectContaining({ code: WRITE_ERROR_CODES.STATE_CORRUPT }),
    )
  })

  it('does not turn a rejected journal into an empty one', () => {
    let thrown: unknown
    try {
      parse(v1Document({ idempotencyIndex: { h: 'op-gone' } }))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(GarminWriteError)
    expect((thrown as GarminWriteError).outcome).toBe('not_applied')
  })
})

// ---------------------------------------------------------------------------
// Persistence: on-disk behaviour, atomicity and lock discipline.
// ---------------------------------------------------------------------------

describe('FileOperationStore migration', () => {
  let base: string

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'garmin-migration-'))
  })

  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  // Every version of the journal writer -- including the original v1 one -- has
  // created the file with `open(path, 'wx', 0o600)`. A fixture seeded through
  // `writeFile` without an explicit mode inherits the umask (typically 0o644),
  // which is a state this codebase cannot produce and which the private-state
  // guard correctly refuses. Seed the mode production actually writes.
  async function seedV1(store: FileOperationStore, legacy: Record<string, unknown>): Promise<void> {
    await nodeStoreFileSystem.mkdir(store.directory, { recursive: true, mode: 0o700 })
    await writeFile(store.filePath, `${JSON.stringify(legacy, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  }

  it('upgrades in memory on read without touching the file', async () => {
    const store = new FileOperationStore(base, ACCOUNT)
    const legacy = v1Document({
      operations: {
        'op-1': v1Operation({
          idempotencyKeyHash: idempotencyKeyHash(ACCOUNT, 'secret-key'),
          request: { operation: 'schedule', workoutId: 'w1', idempotencyKey: 'secret-key' },
        }),
      },
      idempotencyIndex: { [idempotencyKeyHash(ACCOUNT, 'secret-key')]: 'op-1' },
    })
    await seedV1(store, legacy)

    const document = await store.read()
    expect(document.schemaVersion).toBe(2)
    expect(store.migrationReport?.migrated).toBe(true)

    // Nothing was written: the upgrade is committed under the lock, not as a
    // side effect of a read.
    expect(JSON.parse(await readFile(store.filePath, 'utf8'))).toEqual(legacy)
    expect(JSON.parse(await readFile(store.filePath, 'utf8')).operations['op-1'].request.idempotencyKey)
      .toBe('secret-key')
  })

  it('commits the upgrade atomically under the lock and leaves no plaintext', async () => {
    const store = new FileOperationStore(base, ACCOUNT)
    const keyHash = idempotencyKeyHash(ACCOUNT, 'secret-key')
    await seedV1(store, v1Document({
      operations: {
        'op-1': v1Operation({
          idempotencyKeyHash: keyHash,
          request: { operation: 'schedule', workoutId: 'w1', idempotencyKey: 'secret-key' },
          steps: [v1Step({ status: 'unknown', errorCode: 'WRITE_OUTCOME_UNKNOWN' })],
        }),
      },
      idempotencyIndex: { [keyHash]: 'op-1' },
    }))

    const { report } = await migrateJournalUnderLock({ store, accountKey: ACCOUNT, now: NOW })
    expect(report.migrated).toBe(true)

    const onDisk = await readFile(store.filePath, 'utf8')
    expect(onDisk).not.toContain('secret-key')
    const parsed = JSON.parse(onDisk) as OperationDocument
    expect(parsed.schemaVersion).toBe(2)
    expect(parsed.revision).toBe(7)
    expect(parsed.migratedFrom?.schemaVersion).toBe(1)
    expect(parsed.idempotencyIndex[keyHash]).toBe('op-1')
    // The unknown occupancy survived the rewrite.
    expect(parsed.operations['op-1'].steps[0].status).toBe('unknown')

    // A second run is a no-op: no new revision, no second migratedFrom.
    const second = await migrateJournalUnderLock({ store, accountKey: ACCOUNT, now: NOW })
    expect(second.report.migrated).toBe(false)
    expect(JSON.parse(await readFile(store.filePath, 'utf8')).revision).toBe(7)
  })

  it.each(['open', 'write', 'sync', 'rename'] as const)(
    'keeps the v1 journal usable when the migration %s step fails',
    async (failOn) => {
      const healthy = new FileOperationStore(base, ACCOUNT)
      const legacy = v1Document({
        operations: {
          'op-1': v1Operation({
            steps: [v1Step({ status: 'unknown', errorCode: 'WRITE_OUTCOME_UNKNOWN' })],
          }),
        },
      })
      await seedV1(healthy, legacy)

      const boom = (): never => {
        throw Object.assign(new Error('injected fault'), { code: 'EIO' })
      }
      const broken: WriteStoreFileSystem = {
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

      const failing = new FileOperationStore(base, ACCOUNT, broken, undefined, NOW)
      await expect(migrateJournalUnderLock({ store: failing, accountKey: ACCOUNT, now: NOW }))
        .rejects.toBeInstanceOf(GarminWriteError)

      // The original file is byte-for-byte intact, and still readable through
      // the in-memory upgrade: a failed migration blocks nothing it should not,
      // and never substitutes an empty journal.
      expect(JSON.parse(await readFile(healthy.filePath, 'utf8'))).toEqual(legacy)
      const recovered = await healthy.readWithReport()
      expect(recovered.report.migrated).toBe(true)
      expect(recovered.document.operations['op-1'].steps[0].status).toBe('unknown')
    },
  )

  it('refuses an empty journal file instead of reading it as a new one', async () => {
    const store = new FileOperationStore(base, ACCOUNT)
    await nodeStoreFileSystem.mkdir(store.directory, { recursive: true, mode: 0o700 })
    await writeFile(store.filePath, '   \n', { encoding: 'utf8', mode: 0o600 })
    await expect(store.read()).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
    })
  })

  it('refuses to persist a document that fails its own v2 contract', async () => {
    const store = new FileOperationStore(base, ACCOUNT)
    const broken = {
      schemaVersion: 2,
      revision: 1,
      accountKey: ACCOUNT,
      operations: { 'op-1': { operationId: 'op-1' } },
      idempotencyIndex: {},
    } as unknown as OperationDocument
    await expect(store.save(broken)).rejects.toMatchObject({
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
    })
    expect(await store.read()).toMatchObject({ revision: 0, operations: {} })
  })
})

describe('WriteCoordinator.migrateJournal', () => {
  it('serializes concurrent migrations through the account lock', async () => {
    const base = mkdtempSync(join(tmpdir(), 'garmin-migrate-lock-'))
    try {
      const keyHash = idempotencyKeyHash(ACCOUNT, 'secret-key')
      const document = new FileOperationStore(base, ACCOUNT)
      await nodeStoreFileSystem.mkdir(document.directory, { recursive: true, mode: 0o700 })
      await writeFile(document.filePath, `${JSON.stringify(v1Document({
        operations: {
          'op-1': v1Operation({
            idempotencyKeyHash: keyHash,
            request: { operation: 'schedule', workoutId: 'w1', idempotencyKey: 'secret-key' },
            steps: [v1Step({ status: 'unknown', errorCode: 'WRITE_OUTCOME_UNKNOWN' })],
          }),
        },
        idempotencyIndex: { [keyHash]: 'op-1' },
      }), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })

      const coordinatorFor = () => new WriteCoordinator({
        store: new FileOperationStore(base, ACCOUNT),
        lock: new FileAccountLock(base, ACCOUNT),
        accountKey: ACCOUNT,
        writer: { schedule: jest.fn() },
        now: NOW,
      })

      const reports = await Promise.all([
        coordinatorFor().migrateJournal(),
        coordinatorFor().migrateJournal(),
        coordinatorFor().migrateJournal(),
      ])

      // Exactly one process performs the upgrade; the others observe v2.
      expect(reports.filter(report => report.migrated)).toHaveLength(1)
      const onDisk = JSON.parse(await readFile(document.filePath, 'utf8')) as OperationDocument
      expect(onDisk.schemaVersion).toBe(2)
      expect(onDisk.revision).toBe(7)
      expect(JSON.stringify(onDisk)).not.toContain('secret-key')
      expect(onDisk.operations['op-1'].steps[0].status).toBe('unknown')
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it('migrates an old journal before a write path binds a confirmation to it', async () => {
    const base = mkdtempSync(join(tmpdir(), 'garmin-migrate-service-'))
    try {
      // The service derives its own account-scoped directory, so the v1 file
      // must live exactly where the service will look for it.
      const serviceAccount = accountKey('runner@example.test', 'cn')
      const keyHash = idempotencyKeyHash(serviceAccount, 'legacy-key')
      const request = { operation: 'schedule', workoutId: 'w1', date: '2026-09-20', timezone: 'UTC' }
      const store = new FileOperationStore(base, serviceAccount)
      await nodeStoreFileSystem.mkdir(store.directory, { recursive: true, mode: 0o700 })
      await writeFile(store.filePath, `${JSON.stringify({
        schemaVersion: 1,
        revision: 2,
        accountKey: serviceAccount,
        operations: {
          'op-legacy': v1Operation({
            operationId: 'op-legacy',
            accountKey: serviceAccount,
            idempotencyKeyHash: keyHash,
            request,
            steps: [v1Step({
              stepId: 's-legacy',
              businessKey: 'bk-legacy',
              status: 'not_attempted',
              evidence: 'none',
            })],
          }),
        },
        idempotencyIndex: { [keyHash]: 'op-legacy' },
      }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })

      const { GarminToolService } = await import('../src/tool-service')
      const writer = jest.fn().mockResolvedValue({ workoutScheduleId: 'sid-new' })
      const service = new GarminToolService({
        getWorkoutDetail: jest.fn().mockResolvedValue({ workoutName: 'Easy run' }),
        scheduleWorkout: writer,
        unscheduleWorkout: jest.fn(),
        addWorkout: jest.fn(),
      } as never, {
        activityDetail: 'compact',
        fitDownloadDir: '',
        accountUsername: 'runner@example.test',
        accountRegion: 'cn',
        stateDirectory: base,
      })

      await service.scheduleWorkout({
        workoutId: 'w1', date: '2026-09-20', timezone: 'UTC',
      } as never)

      // The write path persisted the upgraded journal: v2, and the v1 hash that
      // no longer matches the canonical request was rewritten.
      const onDisk = JSON.parse(await readFile(store.filePath, 'utf8')) as OperationDocument
      expect(onDisk.schemaVersion).toBe(2)
      expect(onDisk.migratedFrom?.schemaVersion).toBe(1)
      expect(onDisk.operations['op-legacy'].requestHash).toBe(requestHash(request))
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})

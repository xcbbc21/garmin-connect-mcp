/**
 * Test helper: read the *write operations* journal straight off disk.
 *
 * Persistence assertions must never be made against an in-memory store — the
 * whole point of the journal is that a different process can read the same
 * facts. These helpers therefore open the real file the runtime writes, which
 * also means a test can prove the file itself holds no plaintext secret.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseOperationJournal } from '../../src/write-operations/migration'
import type { OperationDocument } from '../../src/write-operations/types'

/** `<stateDirectory>/<accountKey>/operations.json`, the runtime's own layout. */
export function operationJournalPath(stateDirectory: string, accountKey: string): string {
  return join(stateDirectory, accountKey, 'operations.json')
}

/** The raw file text, for assertions about what is *not* in the file. */
export function readOperationJournalText(
  stateDirectory: string,
  accountKey: string,
): string {
  return readFileSync(operationJournalPath(stateDirectory, accountKey), 'utf8')
}

/**
 * Parse the on-disk journal. Throws — rather than returning an empty document —
 * when the file is missing or unparseable, so a test can never pass by
 * accident because nothing was persisted.
 */
export function readOperationDocument(
  stateDirectory: string,
  accountKey: string,
  now: () => Date = () => new Date(),
): OperationDocument {
  const raw: unknown = JSON.parse(readOperationJournalText(stateDirectory, accountKey))
  return parseOperationJournal(raw, accountKey, now).document
}

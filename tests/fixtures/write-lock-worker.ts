/**
 * Real-subprocess lock fixture.
 *
 * Usage:
 *   node --import tsx tests/fixtures/write-lock-worker.ts <stateDir> <account> <holdMs> <waitMs> <eventsFile>
 *
 * Appends one JSON event per line to <eventsFile> so a parent test can prove
 * that two processes never overlapped inside the critical section. Exit code 3
 * means the lock could not be acquired within the wait budget (OPERATION_BUSY).
 */
import { appendFileSync } from 'node:fs'
import { FileAccountLock } from '../../src/write-operations/lock'
import { WRITE_ERROR_CODES, isGarminWriteError } from '../../src/write-operations/errors'

const [stateDir, account, holdMsRaw, waitMsRaw, eventsFile] = process.argv.slice(2)
const holdMs = Number(holdMsRaw ?? '0')
const waitMs = Number(waitMsRaw ?? '5000')

function record(event: string, extra: Record<string, unknown> = {}): void {
  appendFileSync(eventsFile, `${JSON.stringify({ event, pid: process.pid, t: Date.now(), ...extra })}\n`)
}

async function main(): Promise<void> {
  const lock = new FileAccountLock(stateDir, account, undefined, { waitTimeoutMs: waitMs })
  try {
    await lock.runExclusive(async () => {
      record('start')
      await new Promise(resolve => setTimeout(resolve, holdMs))
      record('end')
    })
    process.exitCode = 0
  } catch (error) {
    if (isGarminWriteError(error) && error.code === WRITE_ERROR_CODES.OPERATION_BUSY) {
      record('busy')
      process.exitCode = 3
      return
    }
    record('error', { message: error instanceof Error ? error.message : 'unknown' })
    process.exitCode = 4
  }
}

void main()

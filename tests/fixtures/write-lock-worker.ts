/**
 * Real-subprocess lock fixture.
 *
 * Usage:
 *   node --import tsx tests/fixtures/write-lock-worker.ts <stateDir> <account> <holdMs> <waitMs> <eventsFile>
 *
 * Appends one JSON event per line to <eventsFile> so a parent test can prove
 * that two processes never overlapped inside the critical section. A parent
 * must never sleep and hope this process reached the lock: it waits for
 * `ready` (arguments parsed, about to contend) or `start` (recorded *inside*
 * the critical section, so the lock is provably held).
 *
 * Exit codes:
 *   0  the critical section ran to completion
 *   3  the lock was not free within the wait budget (OPERATION_BUSY)
 *   4  unexpected failure; the same detail is also written to stderr, redacted
 *   5  the watchdog fired before the run finished
 *
 * `GARMIN_LOCK_WORKER_WATCHDOG_MS` shortens the watchdog so a test can
 * exercise the timeout path without waiting out the real budget.
 */
import { appendFileSync, writeSync } from 'node:fs'
import { FileAccountLock } from '../../src/write-operations/lock'
import { WRITE_ERROR_CODES, isGarminWriteError } from '../../src/write-operations/errors'
import { redactSensitiveText } from '../../src/utils/errors'

const DEFAULT_WATCHDOG_MS = 30_000

const [stateDir, account, holdMsRaw, waitMsRaw, eventsFile] = process.argv.slice(2)
const holdMs = Number(holdMsRaw ?? '0')
const waitMs = Number(waitMsRaw ?? '5000')
const watchdogMs = Number(process.env.GARMIN_LOCK_WORKER_WATCHDOG_MS ?? DEFAULT_WATCHDOG_MS)

/** Set once an outcome is committed, so a late crash cannot overwrite it. */
let reported = false

function record(event: string, extra: Record<string, unknown> = {}): void {
  if (!eventsFile) return
  appendFileSync(eventsFile, `${JSON.stringify({ event, pid: process.pid, t: Date.now(), ...extra })}\n`)
}

/**
 * Report one failure on both channels a parent can observe: the structured
 * events file and stderr.
 *
 * Redacted, because an unexpected failure may carry credentials, and written
 * synchronously, because a dying child cannot assume a buffered write is
 * flushed — the parent's stderr capture is the only text it is guaranteed to
 * receive.
 */
function fail(exitCode: number, event: string, error: unknown): void {
  if (reported) return
  reported = true
  const detail = redactSensitiveText(error)
  record(event, { message: detail })
  writeSync(2, `${redactSensitiveText(`write-lock-worker: ${event}: ${detail}`)}\n`)
  process.exitCode = exitCode
}

/** Report and leave immediately; for paths where a pending timer would hang the process. */
function die(exitCode: number, event: string, error: unknown): void {
  fail(exitCode, event, error)
  process.exit(exitCode)
}

const watchdog = setTimeout(() => {
  die(5, 'timeout', new Error(`the run did not finish within ${watchdogMs}ms`))
}, watchdogMs)

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    die(4, 'signal', new Error(`received ${signal}`))
  })
}
process.on('uncaughtException', error => {
  die(4, 'error', error)
})
process.on('unhandledRejection', reason => {
  die(4, 'error', reason)
})

async function main(): Promise<void> {
  if (!stateDir || !account || !eventsFile) {
    // Echoing the received arguments is what makes the redaction below
    // falsifiable: a caller that passes a credential as an argument must see
    // it removed from the diagnostic rather than copied into it.
    const received = process.argv.slice(2).map(value => JSON.stringify(value)).join(' ')
    // `die`, not `fail`: the watchdog timer is still pending here, so merely
    // setting an exit code would leave the process alive for the full budget.
    die(4, 'error', new Error(`usage: write-lock-worker <stateDir> <account> <holdMs> <waitMs> <eventsFile>; received: ${received}`))
    return
  }

  const lock = new FileAccountLock(stateDir, account, undefined, { waitTimeoutMs: waitMs })
  record('ready')

  try {
    await lock.runExclusive(async () => {
      record('start')
      await new Promise(resolve => setTimeout(resolve, holdMs))
      record('end')
    })
    reported = true
    clearTimeout(watchdog)
    process.exitCode = 0
  } catch (error) {
    clearTimeout(watchdog)
    if (isGarminWriteError(error) && error.code === WRITE_ERROR_CODES.OPERATION_BUSY) {
      reported = true
      record('busy')
      process.exitCode = 3
      return
    }
    fail(4, 'error', error)
  }
}

void main().catch(error => {
  clearTimeout(watchdog)
  fail(4, 'error', error)
})

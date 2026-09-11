const DEFAULT_MCP_CLOSE_TIMEOUT_MS = 35_000
const MAX_MCP_CLOSE_TIMEOUT_MS = 2 * 60 * 1000

export type McpShutdownSignal = 'SIGHUP' | 'SIGINT' | 'SIGTERM'

export interface McpShutdownTarget {
  close(): Promise<void>
}

export interface McpShutdownHooksOptions {
  input?: NodeJS.ReadStream
  signals?: NodeJS.Process
  exit?: (code: number) => void
  closeTimeoutMs?: number
  /**
   * Aborted the moment a shutdown is requested, before any draining starts.
   *
   * An in-progress write batch watches this signal between entries, so closing
   * the server stops it from dispatching further non-idempotent writes instead
   * of queueing them behind a transport that is about to disappear. Already
   * dispatched entries are never abandoned: their real outcome is still
   * recorded, because an abort is a local decision and says nothing about what
   * Garmin did with a request that was already sent.
   */
  pendingWrites?: AbortController
}

export interface McpShutdownHooks {
  shutdown(exitCode?: number): Promise<void>
  dispose(): void
}

/**
 * Close the MCP server when its stdio owner disappears or terminates it.
 * Authentication cleanup is awaited, but an outer deadline prevents a broken
 * dependency from leaving a stdio child process and loopback listener behind.
 */
export function installMcpShutdownHooks(
  target: McpShutdownTarget,
  options: McpShutdownHooksOptions = {},
): McpShutdownHooks {
  const input = options.input ?? process.stdin
  const signals = options.signals ?? process
  const exit = options.exit ?? (code => process.exit(code))
  const closeTimeoutMs = boundedCloseTimeout(options.closeTimeoutMs)
  let shutdownOperation: Promise<void> | undefined
  let requestedExitCode = 0
  let disposed = false

  const onEnd = (): void => {
    void shutdown(0)
  }
  const onClose = (): void => {
    void shutdown(0)
  }
  const signalHandlers: Record<McpShutdownSignal, () => void> = {
    SIGHUP: () => void shutdown(129),
    SIGINT: () => void shutdown(130),
    SIGTERM: () => void shutdown(143),
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    input.removeListener('end', onEnd)
    input.removeListener('close', onClose)
    for (const signal of shutdownSignals()) {
      signals.removeListener(signal, signalHandlers[signal])
    }
  }

  const shutdown = (exitCode = 0): Promise<void> => {
    if (exitCode !== 0) requestedExitCode = exitCode
    if (shutdownOperation) return shutdownOperation
    try {
      input.pause()
    } catch {
      // Continue cleanup even if an injected or already-broken stream fails.
    }
    // Announce the shutdown before draining: a running batch must stop sending
    // new entries now, not after `close()` has already been attempted.
    options.pendingWrites?.abort()
    shutdownOperation = closeWithin(target, closeTimeoutMs)
      .finally(() => {
        dispose()
        exit(requestedExitCode)
      })
    return shutdownOperation
  }

  input.once('end', onEnd)
  input.once('close', onClose)
  for (const signal of shutdownSignals()) {
    // Keep signals intercepted throughout the bounded drain. Hosts commonly
    // close stdin first and send SIGTERM during their grace period; restoring
    // Node's default handler early would kill an in-progress atomic commit.
    signals.on(signal, signalHandlers[signal])
  }

  return { shutdown, dispose }
}

async function closeWithin(
  target: McpShutdownTarget,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>(resolve => {
    timer = setTimeout(resolve, timeoutMs)
  })
  const close = Promise.resolve()
    .then(() => target.close())
    .catch(() => undefined)
  try {
    await Promise.race([close, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function boundedCloseTimeout(value: unknown): number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0
    && value <= MAX_MCP_CLOSE_TIMEOUT_MS
    ? value
    : DEFAULT_MCP_CLOSE_TIMEOUT_MS
}

function shutdownSignals(): readonly McpShutdownSignal[] {
  return ['SIGHUP', 'SIGINT', 'SIGTERM']
}

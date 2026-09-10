import { safeUpstreamLogLine } from './utils/errors'

export interface GarminLogger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** Logging never uses stdout, which belongs exclusively to MCP JSON-RPC. */
export function createStderrLogger(): GarminLogger {
  const write = (level: string) => (message: string) => {
    process.stderr.write('[' + level + '] ' + safeUpstreamLogLine([message]) + '\n')
  }
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') }
}

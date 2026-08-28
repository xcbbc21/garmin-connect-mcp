import {
  runCapturedServiceTicketDiAuthSetup,
  type BrowserDiAuthCanaryHttp,
  type CapturedServiceTicketDiAuthSetupOptions,
} from './browser-auth-canary'
import { createAxiosCanaryHttpAdapter } from './browser-auth-canary-runtime'
import type { GarminRegion } from './config'
import { EmbeddedAuthController } from './embedded-auth-controller'
import { EmbeddedAuthFlowManager } from './embedded-auth-flow'
import { EmbeddedAuthServer } from './embedded-auth-server'
import {
  prepareSessionTokenWriteDestination,
  writeSessionTokenFile,
  type GarminDiSessionFile,
} from './session-store'

export interface EmbeddedAuthRuntimeConfig {
  username: string
  region: GarminRegion
  sessionTokenFile: string
}

export interface EmbeddedAuthRuntimeOptions {
  http?: BrowserDiAuthCanaryHttp
  writeSession?: (
    path: string,
    session: GarminDiSessionFile,
  ) => Promise<void>
  replaceSession?: (writeSession: () => Promise<void>) => Promise<void>
  prepareDestination?: (path: string) => Promise<void>
}

/**
 * Assemble the shared loopback authentication runtime.
 *
 * This seam intentionally has no Cordis dependency and does not create a
 * Playwright browser. The Host RPC, CLI, and MCP transports can therefore use
 * the same controller while deciding independently how the bridge URL opens.
 */
export function createEmbeddedAuthController(
  config: EmbeddedAuthRuntimeConfig,
  options: EmbeddedAuthRuntimeOptions = {},
): EmbeddedAuthController {
  const http = options.http ?? createAxiosCanaryHttpAdapter()
  const persistSession = options.writeSession ?? writeSessionTokenFile
  const prepareDestination = options.prepareDestination
    ?? prepareSessionTokenWriteDestination
  const flows = new EmbeddedAuthFlowManager({
    authenticate: async (input) => {
      await runCapturedServiceTicketDiAuthSetup(
        {
          region: input.region,
          username: input.username,
          sessionTokenFile: input.sessionTokenFile,
          serviceTicket: input.ticket.serviceTicket,
          serviceUrl: input.ticket.serviceUrl,
          loopbackOrigin: input.loopbackOrigin,
          signal: input.signal,
          confirmIdentity: input.confirmIdentity,
        } satisfies CapturedServiceTicketDiAuthSetupOptions,
        {
          http,
          writeSession: (path, session) => {
            const commit = () => persistSession(path, session)
            return options.replaceSession
              ? options.replaceSession(commit)
              : commit()
          },
        },
      )
    },
  })
  const server = new EmbeddedAuthServer(flows)
  return new EmbeddedAuthController({
    ...config,
    flows,
    server,
    prepareDestination,
  })
}

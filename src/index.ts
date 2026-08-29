import { Context } from '@deepseek-ai/cordis'
import { Config, resolveConfig } from './config'
import { GarminClient } from './client'
import {
  registerEmbeddedAuthRpc,
  resolveEmbeddedAuthConfig,
} from './embedded-auth-rpc'
import { registerTools } from './tools'

export const name = 'garmin-connect'
export { Config, resolveConfig }
export const inject = ['tools']

export function apply(ctx: Context, config: Config) {
  const resolvedConfig = resolveEmbeddedAuthConfig(resolveConfig(config))
  const client = new GarminClient(ctx, resolvedConfig, {
    allowUnconfigured: true,
  })

  // Kick off the Garmin login in the background. Tool calls auto-connect on
  // first use, so a slow or temporarily failing login never blocks plugin
  // activation (dsh's Cordis fork has no 'ready' lifecycle event).
  const initialConnection = client.connect().catch(() => undefined)

  // Register all AI-callable tools
  registerTools(ctx, client, resolvedConfig)

  // Compatible DSH hosts gain an optional loopback-only browser sign-in UI.
  // The Garmin ticket and resulting session never cross into the web client.
  registerEmbeddedAuthRpc(ctx, resolvedConfig, {
    getAuthenticatedAccount: async () => {
      await initialConnection
      return client.getAuthenticatedAccount()
    },
    getAuthenticationRequirement: async () => {
      await initialConnection
      return client.getAuthenticationRequirement()
    },
    replaceSession: writer => client.replacePersistedSession(writer),
  })
}

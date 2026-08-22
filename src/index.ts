import { Context } from '@deepseek-ai/cordis'
import { Config, resolveConfig } from './config'
import { GarminClient } from './client'
import { registerEmbeddedAuthRpc } from './embedded-auth-rpc'
import { registerTools } from './tools'

export const name = 'garmin-connect'
export { Config, resolveConfig }
export const inject = ['tools']

export function apply(ctx: Context, config: Config) {
  const resolvedConfig = resolveConfig(config)
  const client = new GarminClient(ctx, resolvedConfig)

  // Kick off the Garmin login in the background. Tool calls auto-connect on
  // first use, so a slow or temporarily failing login never blocks plugin
  // activation (dsh's Cordis fork has no 'ready' lifecycle event).
  void client.connect().catch(() => {})

  // Register all AI-callable tools
  registerTools(ctx, client, resolvedConfig)

  // Compatible DSH hosts gain an optional loopback-only browser sign-in UI.
  // The Garmin ticket and resulting session never cross into the web client.
  registerEmbeddedAuthRpc(ctx, resolvedConfig)
}

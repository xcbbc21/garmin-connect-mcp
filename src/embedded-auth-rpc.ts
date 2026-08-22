import type { Context } from '@deepseek-ai/cordis'
import type {
  ConnectionRpcHandler,
  HostConnectionHandle,
} from '@deepseek-ai/dsh-client-connection'
import { defaultAccountSessionPath } from './auth-cli'
import {
  runCapturedServiceTicketDiAuthSetup,
  type CapturedServiceTicketDiAuthSetupOptions,
} from './browser-auth-canary'
import { createAxiosCanaryHttpAdapter } from './browser-auth-canary-runtime'
import type { Config } from './config'
import {
  EmbeddedAuthController,
  type EmbeddedAuthBeginResult,
  type EmbeddedAuthCancelResult,
  type EmbeddedAuthStatusResult,
} from './embedded-auth-controller'
import { EmbeddedAuthFlowManager } from './embedded-auth-flow'
import { EmbeddedAuthServer } from './embedded-auth-server'
import { writeSessionTokenFile } from './session-store'

const RPC_CHANNEL = '/garmin-auth'
const RPC_EFFECT_LABEL = 'garmin-connect: embedded auth rpc'
const ACCOUNT_ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/

type EmbeddedAuthRpcResult =
  | EmbeddedAuthBeginResult
  | EmbeddedAuthStatusResult
  | EmbeddedAuthCancelResult

export interface EmbeddedAuthRpcController {
  begin(signal?: AbortSignal): Promise<EmbeddedAuthBeginResult>
  status(payload: unknown): EmbeddedAuthStatusResult
  cancel(payload: unknown): EmbeddedAuthCancelResult
  close(): Promise<void>
}

export type EmbeddedAuthRpcControllerFactory = (
  config: Config,
) => EmbeddedAuthRpcController

/**
 * Register the private Host half of embedded Garmin authentication.
 *
 * Connection is intentionally optional: older DSH hosts can still load the
 * plugin, while compatible hosts expose this channel only to loopback pages.
 */
export function registerEmbeddedAuthRpc(
  ctx: Context,
  config: Config,
  createController: EmbeddedAuthRpcControllerFactory = createDefaultController,
): void {
  ctx.inject(['connection'], (connectionCtx) => {
    const controller = createController(config)
    const connection = connectionCtx.connection as HostConnectionHandle
    const disposeRpc = connection.rpc.handle(
      RPC_CHANNEL,
      createRpcHandler(controller),
      { authority: 'loopback' },
    )

    connectionCtx.effect(
      () => async () => {
        try {
          await disposeRpc()
        } finally {
          await controller.close()
        }
      },
      RPC_EFFECT_LABEL,
    )
  })
}

function createRpcHandler(
  controller: EmbeddedAuthRpcController,
): ConnectionRpcHandler {
  return async (endpoint, payload, signal) => {
    const unavailable = (): { ok: true; value: EmbeddedAuthRpcResult } => ({
      ok: true,
      value: { success: false, code: 'unavailable' },
    })

    try {
      if (signal.aborted) return unavailable()
      if (endpoint === 'begin') {
        if (!isExactEmptyObject(payload)) return unavailable()
        return { ok: true, value: await controller.begin(signal) }
      }
      if (endpoint === 'status') {
        return { ok: true, value: controller.status(payload) }
      }
      if (endpoint === 'cancel') {
        return { ok: true, value: controller.cancel(payload) }
      }
      return unavailable()
    } catch {
      return unavailable()
    }
  }
}

function createDefaultController(config: Config): EmbeddedAuthRpcController {
  const account = process.env.GARMIN_ACCOUNT?.trim() || 'default'
  const sessionTokenFile = config.sessionTokenFile?.trim()
    || (ACCOUNT_ALIAS_PATTERN.test(account)
      ? defaultAccountSessionPath(account)
      : '')
  const http = createAxiosCanaryHttpAdapter()
  const flows = new EmbeddedAuthFlowManager({
    authenticate: input => runCapturedServiceTicketDiAuthSetup(
      {
        ...input,
        serviceTarget: 'sso-embed',
      } satisfies CapturedServiceTicketDiAuthSetupOptions,
      {
        http,
        writeSession: writeSessionTokenFile,
      },
    ).then(() => undefined),
  })
  const server = new EmbeddedAuthServer(flows)
  return new EmbeddedAuthController({
    username: config.username,
    region: config.region,
    sessionTokenFile,
    flows,
    server,
  })
}

function isExactEmptyObject(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return (prototype === Object.prototype || prototype === null)
    && Object.keys(value).length === 0
}

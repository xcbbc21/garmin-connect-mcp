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
import type { Config, GarminRegion } from './config'
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

type Environment = Readonly<Record<string, string | undefined>>

type EmbeddedAuthRpcResult =
  | EmbeddedAuthAccountResult
  | EmbeddedAuthBeginResult
  | EmbeddedAuthStatusResult
  | EmbeddedAuthCancelResult

export type EmbeddedAuthAccountResult = {
  success: true
  authenticated: false
} | {
  success: true
  authenticated: true
  email: string
  region: GarminRegion
} | {
  success: false
  code: 'unavailable'
}

export interface EmbeddedAuthAuthenticatedAccount {
  email: string
  region: GarminRegion
}

export type EmbeddedAuthAuthenticatedAccountProvider = () =>
  | EmbeddedAuthAuthenticatedAccount
  | undefined
  | Promise<EmbeddedAuthAuthenticatedAccount | undefined>

export interface EmbeddedAuthRpcController {
  begin(
    signal?: AbortSignal,
    requestedRegion?: GarminRegion,
  ): Promise<EmbeddedAuthBeginResult>
  status(payload: unknown): EmbeddedAuthStatusResult
  cancel(payload: unknown): EmbeddedAuthCancelResult
  close(): Promise<void>
}

export type EmbeddedAuthRpcControllerFactory = (
  config: Config,
) => EmbeddedAuthRpcController

export interface EmbeddedAuthRpcRegistrationOptions {
  createController?: EmbeddedAuthRpcControllerFactory
  getAuthenticatedAccount?: EmbeddedAuthAuthenticatedAccountProvider
  replaceSession?: (writeSession: () => Promise<void>) => Promise<void>
}

/** Resolve the one session path shared by the embedded Host and Garmin client. */
export function resolveEmbeddedAuthConfig(
  config: Config,
  env: Environment = process.env,
): Config {
  const configuredPath = config.sessionTokenFile?.trim()
  if (configuredPath) return { ...config, sessionTokenFile: configuredPath }

  const account = env.GARMIN_ACCOUNT?.trim() || 'default'
  return {
    ...config,
    sessionTokenFile: ACCOUNT_ALIAS_PATTERN.test(account)
      ? defaultAccountSessionPath(account, env)
      : '',
  }
}

/**
 * Register the private Host half of embedded Garmin authentication.
 *
 * Connection is intentionally optional: older DSH hosts can still load the
 * plugin, while compatible hosts expose this channel only to loopback pages.
 */
export function registerEmbeddedAuthRpc(
  ctx: Context,
  config: Config,
  options: EmbeddedAuthRpcRegistrationOptions | EmbeddedAuthRpcControllerFactory = {},
): void {
  const registration = typeof options === 'function'
    ? { createController: options }
    : options
  const createController = registration.createController
    ?? ((value: Config) => createDefaultController(
      value,
      registration.replaceSession,
    ))
  ctx.inject(['connection'], (connectionCtx) => {
    const controller = createController(config)
    const connection = connectionCtx.connection as HostConnectionHandle
    const disposeRpc = connection.rpc.handle(
      RPC_CHANNEL,
      createRpcHandler(controller, registration.getAuthenticatedAccount),
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
  getAuthenticatedAccount?: EmbeddedAuthAuthenticatedAccountProvider,
): ConnectionRpcHandler {
  return async (endpoint, payload, signal) => {
    const unavailable = (): { ok: true; value: EmbeddedAuthRpcResult } => ({
      ok: true,
      value: { success: false, code: 'unavailable' },
    })

    try {
      if (signal.aborted) return unavailable()
      if (endpoint === 'account') {
        if (!isExactEmptyObject(payload)) return unavailable()
        const rawAccount = await getAuthenticatedAccount?.()
        if (rawAccount === undefined) {
          return {
            ok: true,
            value: { success: true, authenticated: false },
          }
        }
        const account = exactAuthenticatedAccount(rawAccount)
        if (!account) return unavailable()
        return {
          ok: true,
          value: {
            success: true,
            authenticated: true,
            email: account.email,
            region: account.region,
          },
        }
      }
      if (endpoint === 'begin') {
        const requestedRegion = exactBeginRegion(payload)
        if (!requestedRegion) return unavailable()
        const result = await controller.begin(signal, requestedRegion)
        if (signal.aborted) {
          if (result.success) {
            try {
              controller.cancel({ flowId: result.flowId })
            } catch {
              // Cancellation is best effort at this already-aborted boundary.
            }
          }
          return unavailable()
        }
        return { ok: true, value: result }
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

function createDefaultController(
  config: Config,
  replaceSession?: (writeSession: () => Promise<void>) => Promise<void>,
): EmbeddedAuthRpcController {
  const http = createAxiosCanaryHttpAdapter()
  const flows = new EmbeddedAuthFlowManager({
    authenticate: async (input) => {
      await runCapturedServiceTicketDiAuthSetup(
        {
          ...input,
          serviceTarget: 'sso-embed',
        } satisfies CapturedServiceTicketDiAuthSetupOptions,
        {
          http,
          writeSession: (path, session) => {
            const writeSession = () => writeSessionTokenFile(path, session)
            return replaceSession ? replaceSession(writeSession) : writeSession()
          },
        },
      )
    },
  })
  const server = new EmbeddedAuthServer(flows)
  return new EmbeddedAuthController({
    username: config.username,
    region: config.region,
    sessionTokenFile: config.sessionTokenFile ?? '',
    flows,
    server,
  })
}

function exactBeginRegion(value: unknown): GarminRegion | undefined {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return undefined
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const keys = Object.keys(value)
    if (keys.length !== 1 || keys[0] !== 'region') return undefined
    const region = (value as Record<string, unknown>).region
    return region === 'cn' || region === 'global' ? region : undefined
  } catch {
    return undefined
  }
}

function isExactEmptyObject(value: unknown): boolean {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false
    }
    const prototype = Object.getPrototypeOf(value)
    return (prototype === Object.prototype || prototype === null)
      && Object.keys(value).length === 0
  } catch {
    return false
  }
}

function exactAuthenticatedAccount(
  value: unknown,
): EmbeddedAuthAuthenticatedAccount | undefined {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return undefined
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const keys = Object.keys(value).sort()
    if (keys.length !== 2 || keys[0] !== 'email' || keys[1] !== 'region') {
      return undefined
    }
    const { email, region } = value as Record<string, unknown>
    if (
      typeof email !== 'string'
      || email.length === 0
      || email.length > 320
      || email !== email.trim()
      || /[\u0000-\u001f\u007f-\u009f]/.test(email)
      || (region !== 'cn' && region !== 'global')
    ) {
      return undefined
    }
    return { email, region }
  } catch {
    return undefined
  }
}

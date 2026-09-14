import { randomUUID } from 'node:crypto'
import { UrlElicitationRequiredError } from '@modelcontextprotocol/sdk/types.js'
import { ACCOUNT_ALIAS_PATTERN } from './account-session'
import type { GarminRegion } from './config'
import {
  createEmbeddedAuthController,
  type EmbeddedAuthRuntimeConfig,
} from './embedded-auth-runtime'
import type { EmbeddedAuthPublicState } from './embedded-auth-flow'
import {
  LocalAuthBroker,
  type LocalAuthBeginResult,
} from './local-auth-broker'
import {
  GarminAuthenticationRequiredError,
  PublicToolError,
} from './utils/errors'

const ELICITATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const SUCCESS_GRACE_MS = 2_000
const DEFAULT_NOTIFICATION_TIMEOUT_MS = 1_000

export interface McpAuthProtocol {
  getClientCapabilities(): {
    elicitation?: {
      form?: unknown
      url?: unknown
    }
  } | undefined
  createElicitationCompletionNotifier(elicitationId: string): () => Promise<void>
}

export interface McpAuthBroker {
  begin(region: GarminRegion, signal?: AbortSignal): Promise<LocalAuthBeginResult>
  wait(signal?: AbortSignal): Promise<EmbeddedAuthPublicState>
  close(): Promise<void>
}

export interface McpGarminAuthCoordinatorOptions extends EmbeddedAuthRuntimeConfig {
  protocol: McpAuthProtocol
  account: string
  replaceSession?: (writeSession: () => Promise<void>) => Promise<void>
  createBroker?: () => McpAuthBroker
  createElicitationId?: () => string
  sleep?: (milliseconds: number) => Promise<void>
  notificationTimeoutMs?: number
}

interface ActiveElicitation {
  broker: McpAuthBroker
  id: string
  url: string
  notifyComplete: () => Promise<void>
}

/**
 * Turns a typed Garmin authentication failure into one shared MCP URL
 * elicitation. The tool call is never replayed automatically: after the
 * completion notification, the MCP client/user decides whether to retry it.
 */
export class McpGarminAuthCoordinator {
  private readonly protocol: McpAuthProtocol
  private readonly account: string
  private readonly region: GarminRegion
  private readonly createBroker: () => McpAuthBroker
  private readonly createElicitationId: () => string
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly notificationTimeoutMs: number
  private active?: ActiveElicitation
  private starting?: Promise<ActiveElicitation>
  private readonly finishing = new Set<McpAuthBroker>()
  private readonly watchers = new Set<Promise<void>>()
  private closed = false

  constructor(options: McpGarminAuthCoordinatorOptions) {
    if (!ACCOUNT_ALIAS_PATTERN.test(options.account)) {
      throw new PublicToolError('Garmin account alias is invalid')
    }
    if (
      !options.username.trim()
      || (options.region !== 'cn' && options.region !== 'global')
      || !options.sessionTokenFile.trim()
    ) {
      throw new PublicToolError('Garmin browser authentication is unavailable')
    }
    this.protocol = options.protocol
    this.account = options.account
    this.region = options.region
    this.createElicitationId = options.createElicitationId ?? randomUUID
    this.sleep = options.sleep ?? delay
    this.notificationTimeoutMs = boundedNotificationTimeout(
      options.notificationTimeoutMs,
    )
    this.createBroker = options.createBroker ?? (() => {
      const controller = createEmbeddedAuthController({
        username: options.username,
        region: options.region,
        sessionTokenFile: options.sessionTokenFile,
      }, {
        replaceSession: options.replaceSession,
      })
      return new LocalAuthBroker({ controller })
    })
  }

  async requireAuthentication(error: unknown): Promise<never> {
    if (!(error instanceof GarminAuthenticationRequiredError)) throw error
    if (!this.supportsUrlElicitation()) throw this.fallbackError()

    const active = await this.getOrStart()
    throw new UrlElicitationRequiredError([{
      mode: 'url',
      message: 'Open this local page to sign in to Garmin and complete verification.',
      url: active.url,
      elicitationId: active.id,
    }])
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const active = this.active
    if (active) await active.broker.close()
    await Promise.allSettled(
      [...this.finishing].map(broker => broker.close()),
    )
    const starting = this.starting
    if (starting) {
      const started = await starting.catch(() => undefined)
      if (started && started !== active) await started.broker.close()
    }
    await Promise.allSettled([...this.watchers])
  }

  private supportsUrlElicitation(): boolean {
    try {
      return this.protocol.getClientCapabilities()?.elicitation?.url !== undefined
    } catch {
      return false
    }
  }

  private async getOrStart(): Promise<ActiveElicitation> {
    if (this.closed) throw this.fallbackError()
    if (this.active) return this.active
    if (!this.starting) {
      const starting = this.start()
      this.starting = starting
      void starting.finally(() => {
        if (this.starting === starting) this.starting = undefined
      }).catch(() => undefined)
    }
    return this.starting
  }

  private async start(): Promise<ActiveElicitation> {
    let broker: McpAuthBroker
    try {
      broker = this.createBroker()
    } catch {
      throw this.fallbackError()
    }
    try {
      const started = await broker.begin(this.region, undefined)
      if (this.closed) throw this.fallbackError()
      const id = this.createElicitationId()
      if (!ELICITATION_ID_PATTERN.test(id)) throw this.fallbackError()
      const active: ActiveElicitation = {
        broker,
        id,
        url: started.url,
        notifyComplete: this.protocol.createElicitationCompletionNotifier(id),
      }
      this.active = active
      const watcher = this.watch(active)
      this.watchers.add(watcher)
      void watcher.finally(() => this.watchers.delete(watcher)).catch(() => undefined)
      return active
    } catch (error) {
      await broker.close().catch(() => undefined)
      if (error instanceof PublicToolError) throw error
      throw this.fallbackError()
    }
  }

  private async watch(active: ActiveElicitation): Promise<void> {
    let state: EmbeddedAuthPublicState | undefined
    try {
      state = await active.broker.wait()
    } catch {
      // The client still needs a completion notification so it can leave the
      // pending browser state and decide whether to retry.
    }
    if (this.active === active) this.active = undefined
    this.finishing.add(active.broker)
    try {
      if (state === 'succeeded' && !this.closed) {
        await this.sleep(SUCCESS_GRACE_MS).catch(() => undefined)
      }
    } finally {
      try {
        await active.broker.close()
      } catch {
        // Cleanup stays local and must not become an unhandled background error.
      } finally {
        this.finishing.delete(active.broker)
      }
    }
    await notifyWithin(
      active.notifyComplete,
      this.notificationTimeoutMs,
    )
  }

  private fallbackError(): PublicToolError {
    return new PublicToolError(
      'Garmin authentication is required. Run ' +
      `garmin-connect-auth serve --account ${this.account} ` +
      '--open in a trusted local terminal. ' +
      'If this MCP server sets GARMIN_SESSION_TOKEN_FILE, use the same ' +
      'destination with --output; then retry. An account-matching file may ' +
      'replace an explicitly rejected GARMIN_SESSION_TOKEN.',
    )
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, milliseconds)
    timer.unref?.()
  })
}

async function notifyWithin(
  notify: () => Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>(resolve => {
    timer = setTimeout(resolve, timeoutMs)
  })
  const notification = Promise.resolve()
    .then(notify)
    .catch(() => undefined)
  try {
    await Promise.race([notification, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function boundedNotificationTimeout(value: number | undefined): number {
  return Number.isSafeInteger(value) && value! >= 1 && value! <= 10_000
    ? value!
    : DEFAULT_NOTIFICATION_TIMEOUT_MS
}

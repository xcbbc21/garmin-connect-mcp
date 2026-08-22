import type { GarminRegion } from './config'
import type {
  EmbeddedAuthFlowManager,
  EmbeddedAuthPublicState,
} from './embedded-auth-flow'
import type { EmbeddedAuthServer } from './embedded-auth-server'

const MAX_USERNAME_LENGTH = 320
const MAX_SESSION_TOKEN_PATH_LENGTH = 4 * 1024
const FLOW_ID_PATTERN = /^[a-f0-9]{64}$/
const CSRF_PATTERN = /^[A-Za-z0-9_-]{32,128}$/
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/

export type EmbeddedAuthControllerFlowPort = Pick<
  EmbeddedAuthFlowManager,
  'start' | 'publicStatus' | 'bridgeBootstrap' | 'cancel'
>

export type EmbeddedAuthControllerServerPort = Pick<
  EmbeddedAuthServer,
  'start' | 'bridgeUrl' | 'close'
>

export interface EmbeddedAuthControllerOptions {
  username: string
  region: GarminRegion
  sessionTokenFile: string
  flows: EmbeddedAuthControllerFlowPort
  server: EmbeddedAuthControllerServerPort
}

export type EmbeddedAuthBeginResult =
  | {
    success: true
    flowId: string
    bridgeUrl: string
    expiresAt: number
  }
  | {
    success: false
    code: 'configuration' | 'busy' | 'unavailable'
  }

export type EmbeddedAuthStatusResult =
  | { success: true; status: EmbeddedAuthPublicState }
  | { success: false; code: 'invalid' | 'unavailable' }

export type EmbeddedAuthCancelResult =
  | { success: true }
  | { success: false; code: 'invalid' | 'unavailable' }

interface NormalizedConfiguration {
  username: string
  region: GarminRegion
  sessionTokenFile: string
}

/**
 * Host-side facade used by a DSH route (or another trusted local caller).
 *
 * It deliberately exposes only an opaque flow handle and coarse status. The
 * account, token path, Garmin ticket, CSRF, profile, and dependency errors stay
 * behind the controller boundary.
 */
export class EmbeddedAuthController {
  private readonly username: unknown
  private readonly region: unknown
  private readonly sessionTokenFile: unknown
  private readonly flows?: EmbeddedAuthControllerFlowPort
  private readonly server?: EmbeddedAuthControllerServerPort
  private currentFlowId?: string
  private bridgeOrigin?: string
  private beginning = false
  private closed = false

  constructor(options: EmbeddedAuthControllerOptions) {
    this.username = options?.username
    this.region = options?.region
    this.sessionTokenFile = options?.sessionTokenFile
    this.flows = options?.flows
    this.server = options?.server
  }

  async begin(
    signal?: AbortSignal,
    requestedRegion?: GarminRegion,
  ): Promise<EmbeddedAuthBeginResult> {
    const configuration = normalizeConfiguration(
      this.username,
      this.region,
      this.sessionTokenFile,
    )
    if (!configuration) return configurationFailure()
    if (
      requestedRegion !== undefined
      && requestedRegion !== configuration.region
    ) {
      return configurationFailure()
    }
    if (this.closed || isAborted(signal)) return unavailableFailure()
    if (this.beginning) return busyFailure()
    if (!this.flows || !this.server) return unavailableFailure()

    if (this.currentFlowId) {
      const currentStatus = this.readPublicStatus(this.currentFlowId)
      if (!currentStatus) return unavailableFailure()
      if (currentStatus === 'in_progress') return busyFailure()
    }

    this.beginning = true
    let orphanFlowId: string | undefined
    try {
      const bridgeOrigin = this.bridgeOrigin ?? await this.server.start()
      if (
        this.closed
        || isAborted(signal)
        || !isSafeLoopbackOrigin(bridgeOrigin)
      ) {
        return unavailableFailure()
      }
      this.bridgeOrigin = bridgeOrigin

      const started = this.flows.start({
        ...configuration,
        bridgeOrigin,
      })
      if (!isStartedFlow(started)) return unavailableFailure()
      orphanFlowId = started.flowId

      if (this.closed || isAborted(signal)) {
        this.cancelBestEffort(orphanFlowId)
        return unavailableFailure()
      }

      const bridgeUrl = this.server.bridgeUrl(started.flowId)
      if (!isSafeBridgeUrl(bridgeUrl, bridgeOrigin, started.flowId)) {
        this.cancelBestEffort(orphanFlowId)
        return unavailableFailure()
      }

      this.currentFlowId = started.flowId
      orphanFlowId = undefined
      return {
        success: true,
        flowId: started.flowId,
        bridgeUrl,
        expiresAt: started.expiresAt,
      }
    } catch {
      if (orphanFlowId) this.cancelBestEffort(orphanFlowId)
      return unavailableFailure()
    } finally {
      this.beginning = false
    }
  }

  status(payload: unknown): EmbeddedAuthStatusResult {
    const flowId = exactCurrentFlowId(payload, this.currentFlowId)
    if (!flowId) return invalidFailure()

    const status = this.readPublicStatus(flowId)
    if (!status) return unavailableFailure()
    return { success: true, status }
  }

  cancel(payload: unknown): EmbeddedAuthCancelResult {
    const flowId = exactCurrentFlowId(payload, this.currentFlowId)
    if (!flowId) return invalidFailure()
    if (!this.flows) return unavailableFailure()

    try {
      const bootstrap = this.flows.bridgeBootstrap(flowId)
      if (!isTrustedCsrf(bootstrap?.csrf)) return unavailableFailure()
      this.flows.cancel(flowId, bootstrap.csrf)
      return { success: true }
    } catch {
      return unavailableFailure()
    }
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.currentFlowId) this.cancelBestEffort(this.currentFlowId)
    try {
      await this.server?.close()
    } catch {
      // Shutdown is best effort and must not surface sensitive dependency text.
    }
  }

  private readPublicStatus(flowId: string): EmbeddedAuthPublicState | undefined {
    try {
      const status = this.flows?.publicStatus(flowId)
      if (!isExactPublicStatus(status)) return undefined
      return status.state
    } catch {
      return undefined
    }
  }

  private cancelBestEffort(flowId: string): void {
    if (!this.flows) return
    try {
      const bootstrap = this.flows.bridgeBootstrap(flowId)
      if (!isTrustedCsrf(bootstrap?.csrf)) return
      this.flows.cancel(flowId, bootstrap.csrf)
    } catch {
      // Cleanup failures are intentionally collapsed at this trust boundary.
    }
  }
}

function normalizeConfiguration(
  usernameValue: unknown,
  regionValue: unknown,
  sessionTokenFileValue: unknown,
): NormalizedConfiguration | undefined {
  if (typeof usernameValue !== 'string') return undefined
  const username = usernameValue.trim()
  if (
    username.length === 0
    || username.length > MAX_USERNAME_LENGTH
    || CONTROL_CHARACTER_PATTERN.test(username)
  ) {
    return undefined
  }
  if (regionValue !== 'global' && regionValue !== 'cn') return undefined
  if (
    typeof sessionTokenFileValue !== 'string'
    || sessionTokenFileValue.trim().length === 0
    || sessionTokenFileValue.length > MAX_SESSION_TOKEN_PATH_LENGTH
    || CONTROL_CHARACTER_PATTERN.test(sessionTokenFileValue)
  ) {
    return undefined
  }
  return {
    username,
    region: regionValue,
    sessionTokenFile: sessionTokenFileValue,
  }
}

function exactCurrentFlowId(
  payload: unknown,
  currentFlowId: string | undefined,
): string | undefined {
  try {
    if (!isPlainObject(payload)) return undefined
    const keys = Object.keys(payload)
    if (keys.length !== 1 || keys[0] !== 'flowId') return undefined
    const flowId = payload.flowId
    if (typeof flowId !== 'string' || flowId !== currentFlowId) return undefined
    return flowId
  } catch {
    return undefined
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isExactPublicStatus(
  value: unknown,
): value is { state: EmbeddedAuthPublicState } {
  if (!isPlainObject(value)) return false
  const keys = Object.keys(value)
  return keys.length === 1
    && keys[0] === 'state'
    && isPublicState(value.state)
}

function isPublicState(value: unknown): value is EmbeddedAuthPublicState {
  return value === 'in_progress'
    || value === 'succeeded'
    || value === 'failed'
    || value === 'cancelled'
    || value === 'expired'
}

function isStartedFlow(
  value: unknown,
): value is { flowId: string; expiresAt: number } {
  if (!isPlainObject(value)) return false
  return FLOW_ID_PATTERN.test(String(value.flowId))
    && typeof value.expiresAt === 'number'
    && Number.isSafeInteger(value.expiresAt)
    && value.expiresAt > 0
}

function isTrustedCsrf(value: unknown): value is string {
  return typeof value === 'string' && CSRF_PATTERN.test(value)
}

function isAborted(signal: AbortSignal | undefined): boolean {
  try {
    return signal?.aborted === true
  } catch {
    return true
  }
}

function isSafeLoopbackOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 128) return false
  try {
    const parsed = new URL(value)
    return parsed.origin === value
      && parsed.protocol === 'http:'
      && parsed.hostname === '127.0.0.1'
      && parsed.port.length > 0
      && parsed.username === ''
      && parsed.password === ''
      && parsed.pathname === '/'
      && parsed.search === ''
      && parsed.hash === ''
  } catch {
    return false
  }
}

function isSafeBridgeUrl(
  value: unknown,
  expectedOrigin: string,
  flowId: string,
): value is string {
  if (typeof value !== 'string' || value.length > 512) return false
  try {
    const parsed = new URL(value)
    return parsed.origin === expectedOrigin
      && parsed.username === ''
      && parsed.password === ''
      && parsed.pathname === `/garmin-auth/bridge/${flowId}`
      && parsed.search === ''
      && parsed.hash === ''
  } catch {
    return false
  }
}

function configurationFailure(): EmbeddedAuthBeginResult {
  return { success: false, code: 'configuration' }
}

function busyFailure(): EmbeddedAuthBeginResult {
  return { success: false, code: 'busy' }
}

function invalidFailure(): EmbeddedAuthStatusResult & EmbeddedAuthCancelResult {
  return { success: false, code: 'invalid' }
}

function unavailableFailure():
  EmbeddedAuthBeginResult & EmbeddedAuthStatusResult & EmbeddedAuthCancelResult {
  return { success: false, code: 'unavailable' }
}

import { spawn as spawnChildProcess, type ChildProcess } from 'node:child_process'
import type { GarminRegion } from './config'
import {
  BrowserCanaryControlError,
} from './browser-auth-canary'
import type {
  EmbeddedAuthBeginResult,
  EmbeddedAuthCancelResult,
  EmbeddedAuthStatusResult,
} from './embedded-auth-controller'
import type { EmbeddedAuthPublicState } from './embedded-auth-flow'
import { PublicToolError } from './utils/errors'

const FLOW_ID_PATTERN = /^[a-f0-9]{64}$/
const DEFAULT_POLL_INTERVAL_MS = 300
const DEFAULT_SUCCESS_GRACE_MS = 2_000

export interface LocalAuthBrokerController {
  begin(
    signal?: AbortSignal,
    requestedRegion?: GarminRegion,
  ): Promise<EmbeddedAuthBeginResult>
  status(payload: unknown): EmbeddedAuthStatusResult
  cancel(payload: unknown): EmbeddedAuthCancelResult
  close(): Promise<void>
}

export interface LocalAuthBrokerOptions {
  controller: LocalAuthBrokerController
  openBrowser?: (url: string) => Promise<void>
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  pollIntervalMs?: number
  successGraceMs?: number
}

export interface LocalAuthBeginResult {
  url: string
  expiresAt: number
}

export interface LocalAuthSuccessResult {
  success: true
  region: GarminRegion
}

interface ActiveFlow extends LocalAuthBeginResult {
  flowId: string
  terminal?: EmbeddedAuthPublicState
}

/**
 * Own one local browser-authentication lifecycle without exposing its ticket,
 * token, account, or session path. CLI and MCP adapters may choose who opens
 * the returned loopback URL, but only this broker polls the coarse Host state.
 */
export class LocalAuthBroker {
  private readonly controller: LocalAuthBrokerController
  private readonly openBrowser: (url: string) => Promise<void>
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  private readonly pollIntervalMs: number
  private readonly successGraceMs: number
  private active?: ActiveFlow
  private closed = false

  constructor(options: LocalAuthBrokerOptions) {
    if (!options || !isController(options.controller)) {
      throw unavailableError()
    }
    this.controller = options.controller
    this.openBrowser = options.openBrowser ?? openLoopbackAuthInSystemBrowser
    this.sleep = options.sleep ?? abortableSleep
    this.pollIntervalMs = boundedDelay(
      options.pollIntervalMs,
      DEFAULT_POLL_INTERVAL_MS,
      50,
      5_000,
    )
    this.successGraceMs = boundedDelay(
      options.successGraceMs,
      DEFAULT_SUCCESS_GRACE_MS,
      0,
      10_000,
    )
  }

  async begin(
    region: GarminRegion,
    signal?: AbortSignal,
  ): Promise<LocalAuthBeginResult> {
    if (this.closed || this.active || isAborted(signal)) {
      throw unavailableError()
    }

    try {
      const started = await this.controller.begin(signal, region)
      if (
        !started.success
        || !isSafeBridgeUrl(started.bridgeUrl, started.flowId)
        || !Number.isSafeInteger(started.expiresAt)
        || started.expiresAt <= 0
      ) {
        throw unavailableError()
      }
      this.active = {
        flowId: started.flowId,
        url: started.bridgeUrl,
        expiresAt: started.expiresAt,
      }
      return { url: started.bridgeUrl, expiresAt: started.expiresAt }
    } catch (error) {
      await this.close()
      if (error instanceof PublicToolError) throw error
      throw unavailableError()
    }
  }

  async wait(signal?: AbortSignal): Promise<EmbeddedAuthPublicState> {
    const active = this.active
    if (this.closed || !active) throw unavailableError()
    if (active.terminal) return active.terminal

    for (;;) {
      if (isAborted(signal)) {
        this.cancelActive()
        throw new BrowserCanaryControlError('CANCELLED')
      }

      let result: EmbeddedAuthStatusResult
      try {
        result = this.controller.status({ flowId: active.flowId })
      } catch {
        throw unavailableError()
      }
      if (!result.success) throw unavailableError()
      if (result.status !== 'in_progress') {
        active.terminal = result.status
        return result.status
      }

      try {
        await this.sleep(this.pollIntervalMs, signal)
      } catch (error) {
        if (isAborted(signal)) {
          this.cancelActive()
          throw new BrowserCanaryControlError('CANCELLED')
        }
        if (error instanceof BrowserCanaryControlError) throw error
        throw unavailableError()
      }
    }
  }

  async authenticateInSystemBrowser(
    region: GarminRegion,
    signal?: AbortSignal,
  ): Promise<LocalAuthSuccessResult> {
    try {
      const started = await this.begin(region, signal)
      try {
        await this.openBrowser(started.url)
      } catch {
        this.cancelActive()
        throw new PublicToolError('The system browser could not be opened')
      }

      const state = await this.wait(signal)
      if (state === 'succeeded') {
        // The atomic session commit has already completed. Ignore subsequent
        // cancellation during this short display-only grace period.
        if (this.successGraceMs > 0) {
          await this.sleep(this.successGraceMs, undefined).catch(() => undefined)
        }
        return { success: true, region }
      }
      if (state === 'cancelled') {
        throw new BrowserCanaryControlError('CANCELLED')
      }
      if (state === 'expired') {
        throw new BrowserCanaryControlError('TIMED_OUT')
      }
      throw new PublicToolError('Garmin browser authentication failed')
    } finally {
      await this.close()
    }
  }

  cancel(): void {
    this.cancelActive()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.cancelActive()
    try {
      await this.controller.close()
    } catch {
      // Cleanup failures stay behind the local Host trust boundary.
    }
  }

  private cancelActive(): void {
    const active = this.active
    if (!active || active.terminal) return
    try {
      this.controller.cancel({ flowId: active.flowId })
    } catch {
      // Cancellation is best effort; controller.close() performs final cleanup.
    }
    active.terminal = 'cancelled'
  }
}

type SupportedPlatform = 'darwin' | 'linux' | 'win32'
type Spawn = (
  command: string,
  args: readonly string[],
  options: {
    detached: true
    shell: false
    stdio: 'ignore'
  },
) => ChildProcess

export interface SystemBrowserOptions {
  platform?: string
  spawn?: Spawn
}

/** Open only a validated local Garmin bridge URL without invoking a shell. */
export async function openLoopbackAuthInSystemBrowser(
  url: string,
  options: SystemBrowserOptions = {},
): Promise<void> {
  if (!isSafeBridgeUrlWithoutExpectedFlow(url)) {
    throw new PublicToolError('The system browser could not be opened')
  }
  const platform = options.platform ?? process.platform
  const launch = browserLaunch(platform as SupportedPlatform, url)
  if (!launch) throw new PublicToolError('The system browser could not be opened')
  const spawn = options.spawn ?? (spawnChildProcess as Spawn)

  await new Promise<void>((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(launch.command, launch.args, {
        detached: true,
        shell: false,
        stdio: 'ignore',
      })
    } catch {
      reject(new PublicToolError('The system browser could not be opened'))
      return
    }
    const fail = (): void => {
      reject(new PublicToolError('The system browser could not be opened'))
    }
    child.once('error', fail)
    child.once('spawn', () => {
      child.off('error', fail)
      child.unref()
      resolve()
    })
  })
}

function browserLaunch(
  platform: SupportedPlatform,
  url: string,
): { command: string; args: string[] } | undefined {
  if (platform === 'darwin') return { command: '/usr/bin/open', args: [url] }
  if (platform === 'linux') return { command: 'xdg-open', args: [url] }
  if (platform === 'win32') {
    return {
      command: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', url],
    }
  }
  return undefined
}

function isSafeBridgeUrl(value: string, flowId: string): boolean {
  return FLOW_ID_PATTERN.test(flowId)
    && isSafeBridgeUrlWithoutExpectedFlow(value, flowId)
}

function isSafeBridgeUrlWithoutExpectedFlow(
  value: unknown,
  expectedFlowId?: string,
): value is string {
  if (typeof value !== 'string' || value.length > 512) return false
  try {
    const parsed = new URL(value)
    const match = /^\/garmin-auth\/bridge\/([a-f0-9]{64})$/.exec(parsed.pathname)
    return parsed.protocol === 'http:'
      && parsed.hostname === '127.0.0.1'
      && parsed.port.length > 0
      && parsed.username === ''
      && parsed.password === ''
      && parsed.search === ''
      && parsed.hash === ''
      && Boolean(match)
      && (expectedFlowId === undefined || match?.[1] === expectedFlowId)
  } catch {
    return false
  }
}

function isController(value: unknown): value is LocalAuthBrokerController {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<LocalAuthBrokerController>
  return typeof candidate.begin === 'function'
    && typeof candidate.status === 'function'
    && typeof candidate.cancel === 'function'
    && typeof candidate.close === 'function'
}

function boundedDelay(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return Number.isSafeInteger(value) && value! >= minimum && value! <= maximum
    ? value!
    : fallback
}

function isAborted(signal: AbortSignal | undefined): boolean {
  try {
    return signal?.aborted === true
  } catch {
    return true
  }
}

function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (isAborted(signal)) {
    return Promise.reject(new BrowserCanaryControlError('CANCELLED'))
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }
    const onAbort = (): void => finish(new BrowserCanaryControlError('CANCELLED'))
    const timer = setTimeout(() => finish(), milliseconds)
    timer.unref?.()
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function unavailableError(): PublicToolError {
  return new PublicToolError('Garmin browser authentication is unavailable')
}

import {
  createHash,
  randomBytes as secureRandomBytes,
  timingSafeEqual,
} from 'node:crypto'
import type { GarminRegion } from './config'
import {
  createGarminEmbeddedAuthFrameConfig,
  type GarminEmbeddedAuthFrameConfig,
} from './embedded-auth-url'
import { isUsableGarminServiceTicket } from './service-ticket'
import { PublicToolError } from './utils/errors'

const RANDOM_TOKEN_BYTES = 32
const DEFAULT_FLOW_TTL_MS = 5 * 60 * 1000
const MAX_FLOW_TTL_MS = 10 * 60 * 1000
const MAX_USERNAME_LENGTH = 320
const MAX_SESSION_TOKEN_PATH_LENGTH = 4 * 1024
const MAX_IDENTITY_CODE_POINTS = 120
const UNSAFE_IDENTITY_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g

export const GARMIN_EMBEDDED_AUTH_FLOW_REJECTED =
  'Garmin embedded authentication request was rejected'

/** A deliberately fixed error that is safe to return from local HTTP routes. */
export class GarminEmbeddedAuthFlowError extends PublicToolError {
  override name = 'GarminEmbeddedAuthFlowError'

  constructor() {
    super(GARMIN_EMBEDDED_AUTH_FLOW_REJECTED)
  }
}

export type EmbeddedAuthFlowState =
  | 'awaiting_garmin'
  | 'exchanging'
  | 'waiting_confirmation'
  | 'saving'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'expired'

export type EmbeddedAuthPublicState =
  | 'in_progress'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'expired'

export interface EmbeddedAuthIdentity {
  displayName?: string
  userName?: string
}

export interface EmbeddedAuthStartInput {
  region: GarminRegion
  username: string
  sessionTokenFile: string
  bridgeOrigin: string
}

export interface EmbeddedAuthStartResult {
  flowId: string
  expiresAt: number
}

export interface EmbeddedAuthAuthenticateInput {
  region: GarminRegion
  username: string
  sessionTokenFile: string
  serviceTicket: string
  signal: AbortSignal
  confirmIdentity(identity: EmbeddedAuthIdentity): Promise<boolean>
}

export interface EmbeddedAuthBridgeBootstrap extends GarminEmbeddedAuthFrameConfig {
  csrf: string
}

export type EmbeddedAuthAuthenticate = (
  input: EmbeddedAuthAuthenticateInput,
) => Promise<void> | void

export interface EmbeddedAuthBridgeStatus {
  state: EmbeddedAuthFlowState
  identity?: EmbeddedAuthIdentity
}

export interface EmbeddedAuthPublicStatus {
  state: EmbeddedAuthPublicState
}

export interface EmbeddedAuthFlowManagerOptions {
  authenticate: EmbeddedAuthAuthenticate
  now?: () => number
  randomBytes?: (size: number) => Buffer
  ttlMs?: number
}

interface ConfirmationDeferred {
  promise: Promise<boolean>
  resolve(value: boolean): void
  settled: boolean
}

interface EmbeddedAuthFlowRecord extends EmbeddedAuthStartInput {
  flowId: string
  csrf: string
  expiresAtMs: number
  state: EmbeddedAuthFlowState
  controller: AbortController
  timer?: ReturnType<typeof setTimeout>
  identity?: EmbeddedAuthIdentity
  confirmation?: ConfirmationDeferred
  identityRequested: boolean
  frameConfig: GarminEmbeddedAuthFrameConfig
}

/**
 * In-memory, single-use coordinator for the local embedded Garmin sign-in UI.
 *
 * The public status deliberately carries only a coarse state. The Garmin
 * service ticket, configured account, file path, and authentication errors are
 * never retained in a status object.
 */
export class EmbeddedAuthFlowManager {
  private readonly authenticate: EmbeddedAuthAuthenticate
  private readonly now: () => number
  private readonly randomBytes: (size: number) => Buffer
  private readonly ttlMs: number
  private readonly flows = new Map<string, EmbeddedAuthFlowRecord>()

  constructor(options: EmbeddedAuthFlowManagerOptions) {
    if (!options || typeof options.authenticate !== 'function') {
      throw rejection()
    }
    const ttlMs = options.ttlMs ?? DEFAULT_FLOW_TTL_MS
    if (
      !Number.isSafeInteger(ttlMs)
      || ttlMs <= 0
      || ttlMs > MAX_FLOW_TTL_MS
    ) {
      throw rejection()
    }
    this.authenticate = options.authenticate
    this.now = options.now ?? Date.now
    this.randomBytes = options.randomBytes ?? secureRandomBytes
    this.ttlMs = ttlMs
  }

  start(input: EmbeddedAuthStartInput): EmbeddedAuthStartResult {
    try {
      const normalized = normalizeStartInput(input)
      const frameConfig = createGarminEmbeddedAuthFrameConfig(
        normalized.region,
        normalized.bridgeOrigin,
      )
      const flowId = this.uniqueFlowId()
      const csrf = this.independentCsrf(flowId)
      const startedAtMs = this.now()
      if (!Number.isFinite(startedAtMs)) throw rejection()
      const expiresAtMs = startedAtMs + this.ttlMs
      if (!Number.isSafeInteger(expiresAtMs)) throw rejection()

      const flow: EmbeddedAuthFlowRecord = {
        ...normalized,
        flowId,
        csrf,
        expiresAtMs,
        state: 'awaiting_garmin',
        controller: new AbortController(),
        identityRequested: false,
        frameConfig,
      }
      const timer = setTimeout(() => this.expireFlow(flow, true), this.ttlMs)
      timer.unref?.()
      flow.timer = timer
      this.flows.set(flowId, flow)

      return { flowId, expiresAt: expiresAtMs }
    } catch {
      throw rejection()
    }
  }

  /** Read by the trusted loopback bridge while rendering its private page. */
  bridgeBootstrap(flowId: string): EmbeddedAuthBridgeBootstrap {
    const flow = this.lookup(flowId)
    this.expireFlow(flow)
    if (flow.state === 'expired') throw rejection()
    return {
      csrf: flow.csrf,
      ...flow.frameConfig,
    }
  }

  submitTicket(flowId: string, csrf: string, serviceTicket: string): void {
    const flow = this.authorize(flowId, csrf)
    if (
      flow.state !== 'awaiting_garmin'
      || !isUsableGarminServiceTicket(serviceTicket)
    ) {
      throw rejection()
    }

    // This transition happens before the callback is entered, so re-entrant and
    // concurrent submissions cannot deliver a second ticket.
    flow.state = 'exchanging'
    const input: EmbeddedAuthAuthenticateInput = {
      region: flow.region,
      username: flow.username,
      sessionTokenFile: flow.sessionTokenFile,
      serviceTicket,
      signal: flow.controller.signal,
      confirmIdentity: identity => this.requestIdentityConfirmation(flow, identity),
    }

    let operation: Promise<void>
    try {
      operation = Promise.resolve(this.authenticate(input))
    } catch {
      this.failFlow(flow)
      return
    }
    void operation.then(
      () => this.completeAuthentication(flow),
      () => this.failFlow(flow),
    )
  }

  bridgeStatus(flowId: string, csrf: string): EmbeddedAuthBridgeStatus {
    const flow = this.authorize(flowId, csrf)
    const status: EmbeddedAuthBridgeStatus = { state: flow.state }
    if (flow.identity) status.identity = { ...flow.identity }
    return status
  }

  publicStatus(flowId: string): EmbeddedAuthPublicStatus {
    const flow = this.lookup(flowId)
    this.expireFlow(flow)
    return { state: publicStateFor(flow.state) }
  }

  confirm(flowId: string, csrf: string, accepted: boolean): void {
    const flow = this.authorize(flowId, csrf)
    if (
      flow.state !== 'waiting_confirmation'
      || typeof accepted !== 'boolean'
      || !flow.confirmation
      || flow.confirmation.settled
    ) {
      throw rejection()
    }

    if (accepted) {
      flow.state = 'saving'
      settleConfirmation(flow, true)
      return
    }
    this.cancelFlow(flow)
  }

  cancel(flowId: string, csrf: string): void {
    const flow = this.authorize(flowId, csrf)
    if (isTerminal(flow.state)) throw rejection()
    this.cancelFlow(flow)
  }

  private uniqueFlowId(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = this.randomToken()
      if (!this.flows.has(candidate)) return candidate
    }
    throw rejection()
  }

  private independentCsrf(flowId: string): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = this.randomToken()
      if (!constantTimeEqual(candidate, flowId)) return candidate
    }
    throw rejection()
  }

  private randomToken(): string {
    const bytes = this.randomBytes(RANDOM_TOKEN_BYTES)
    if (!Buffer.isBuffer(bytes) || bytes.byteLength !== RANDOM_TOKEN_BYTES) {
      throw rejection()
    }
    return bytes.toString('hex')
  }

  private lookup(flowId: string): EmbeddedAuthFlowRecord {
    if (typeof flowId !== 'string' || flowId.length > 128) throw rejection()
    const flow = this.flows.get(flowId)
    if (!flow) throw rejection()
    return flow
  }

  private authorize(flowId: string, csrf: string): EmbeddedAuthFlowRecord {
    const flow = this.lookup(flowId)
    if (
      typeof csrf !== 'string'
      || csrf.length > 128
      || !constantTimeEqual(flow.csrf, csrf)
    ) {
      throw rejection()
    }
    this.expireFlow(flow)
    return flow
  }

  private async requestIdentityConfirmation(
    flow: EmbeddedAuthFlowRecord,
    candidate: EmbeddedAuthIdentity,
  ): Promise<boolean> {
    this.expireFlow(flow)
    if (
      flow.state !== 'exchanging'
      || flow.identityRequested
      || flow.controller.signal.aborted
    ) {
      throw rejection()
    }
    const identity = sanitizeIdentity(candidate)
    if (!identity) throw rejection()

    flow.identityRequested = true
    flow.identity = identity
    flow.state = 'waiting_confirmation'
    const confirmation = createConfirmationDeferred()
    flow.confirmation = confirmation
    return confirmation.promise
  }

  private completeAuthentication(flow: EmbeddedAuthFlowRecord): void {
    this.expireFlow(flow)
    if (isTerminal(flow.state)) return
    if (flow.state !== 'saving') {
      this.failFlow(flow)
      return
    }
    flow.state = 'succeeded'
  }

  private failFlow(flow: EmbeddedAuthFlowRecord): void {
    this.expireFlow(flow)
    if (isTerminal(flow.state)) return
    flow.state = 'failed'
    flow.controller.abort()
    settleConfirmation(flow, false)
  }

  private cancelFlow(flow: EmbeddedAuthFlowRecord): void {
    flow.state = 'cancelled'
    flow.controller.abort()
    settleConfirmation(flow, false)
  }

  private expireFlow(flow: EmbeddedAuthFlowRecord, force = false): void {
    if (flow.state === 'expired') return
    if (!force) {
      try {
        const currentTime = this.now()
        if (Number.isFinite(currentTime) && currentTime < flow.expiresAtMs) return
      } catch {
        // A broken clock dependency must fail closed without surfacing its error.
      }
    }
    flow.state = 'expired'
    flow.controller.abort()
    settleConfirmation(flow, false)
    flow.identity = undefined
    flow.username = ''
    flow.sessionTokenFile = ''
    clearFlowTimer(flow)
  }
}

function normalizeStartInput(input: EmbeddedAuthStartInput): EmbeddedAuthStartInput {
  if (!input || (input.region !== 'global' && input.region !== 'cn')) {
    throw rejection()
  }
  if (typeof input.username !== 'string') throw rejection()
  const username = input.username.trim()
  if (
    username.length === 0
    || username.length > MAX_USERNAME_LENGTH
    || containsControlCharacter(username)
  ) {
    throw rejection()
  }
  if (
    typeof input.sessionTokenFile !== 'string'
    || input.sessionTokenFile.trim().length === 0
    || input.sessionTokenFile.length > MAX_SESSION_TOKEN_PATH_LENGTH
    || containsControlCharacter(input.sessionTokenFile)
  ) {
    throw rejection()
  }
  return {
    region: input.region,
    username,
    sessionTokenFile: input.sessionTokenFile,
    bridgeOrigin: input.bridgeOrigin,
  }
}

function sanitizeIdentity(candidate: EmbeddedAuthIdentity): EmbeddedAuthIdentity | undefined {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return undefined
  }
  const displayName = sanitizeIdentityValue(candidate.displayName)
  const userName = sanitizeIdentityValue(candidate.userName)
  if (!displayName && !userName) return undefined
  return {
    ...(displayName ? { displayName } : {}),
    ...(userName ? { userName } : {}),
  }
}

function sanitizeIdentityValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value
    .normalize('NFKC')
    .replace(UNSAFE_IDENTITY_CHARACTERS, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (!normalized) return undefined
  return Array.from(normalized).slice(0, MAX_IDENTITY_CODE_POINTS).join('')
}

function containsControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f]/.test(value)
}

function createConfirmationDeferred(): ConfirmationDeferred {
  let resolvePromise!: (value: boolean) => void
  const confirmation: ConfirmationDeferred = {
    promise: new Promise<boolean>((resolve) => {
      resolvePromise = resolve
    }),
    resolve(value: boolean) {
      resolvePromise(value)
    },
    settled: false,
  }
  return confirmation
}

function settleConfirmation(flow: EmbeddedAuthFlowRecord, value: boolean): void {
  const confirmation = flow.confirmation
  if (!confirmation || confirmation.settled) return
  confirmation.settled = true
  confirmation.resolve(value)
}

function publicStateFor(state: EmbeddedAuthFlowState): EmbeddedAuthPublicState {
  switch (state) {
    case 'succeeded':
    case 'failed':
    case 'cancelled':
    case 'expired':
      return state
    default:
      return 'in_progress'
  }
}

function isTerminal(state: EmbeddedAuthFlowState): boolean {
  return state === 'succeeded'
    || state === 'failed'
    || state === 'cancelled'
    || state === 'expired'
}

function clearFlowTimer(flow: EmbeddedAuthFlowRecord): void {
  if (flow.timer) clearTimeout(flow.timer)
  flow.timer = undefined
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest()
  const rightDigest = createHash('sha256').update(right).digest()
  return timingSafeEqual(leftDigest, rightDigest)
}

function rejection(): GarminEmbeddedAuthFlowError {
  return new GarminEmbeddedAuthFlowError()
}

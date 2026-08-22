import { PublicToolError } from './utils/errors'
import { isUsableGarminServiceTicket } from './service-ticket'

const MAX_EMBEDDED_AUTH_MESSAGE_BYTES = 4 * 1024

export const GARMIN_EMBEDDED_AUTH_MESSAGE_REJECTED =
  'Garmin embedded authentication message was rejected'

/** Fixed-message error safe to display outside the trusted authentication UI. */
export class GarminEmbeddedAuthMessageError extends PublicToolError {
  override name = 'GarminEmbeddedAuthMessageError'

  constructor() {
    super(GARMIN_EMBEDDED_AUTH_MESSAGE_REJECTED)
  }
}

export interface GarminEmbeddedAuthMessageContext {
  observedOrigin: string
  expectedOrigin: string
  sourceMatches: boolean
  expectedServiceUrl: string
}

export interface GarminEmbeddedAuthMessage {
  serviceTicket: string
  serviceUrl: string
}

/** Parse the public value emitted by Garmin's embedded SSO helper. */
export function parseGarminEmbeddedAuthMessage(
  payload: unknown,
  context: GarminEmbeddedAuthMessageContext,
): GarminEmbeddedAuthMessage {
  try {
    return parseGarminEmbeddedAuthMessageUnchecked(payload, context)
  } catch {
    throw new GarminEmbeddedAuthMessageError()
  }
}

function parseGarminEmbeddedAuthMessageUnchecked(
  payload: unknown,
  context: GarminEmbeddedAuthMessageContext,
): GarminEmbeddedAuthMessage {
  if (
    context.observedOrigin !== context.expectedOrigin
    || context.sourceMatches !== true
  ) {
    throw new GarminEmbeddedAuthMessageError()
  }
  let decoded = payload
  for (let layer = 0; layer < 2 && typeof decoded === 'string'; layer += 1) {
    if (exceedsUtf8ByteLimit(decoded, MAX_EMBEDDED_AUTH_MESSAGE_BYTES)) {
      throw new GarminEmbeddedAuthMessageError()
    }
    decoded = JSON.parse(decoded)
  }
  if (!isExactMessageObject(decoded)) {
    throw new GarminEmbeddedAuthMessageError()
  }
  const message = decoded
  if (
    message.serviceUrl !== context.expectedServiceUrl
    || !isUsableGarminServiceTicket(message.serviceTicket)
    || exceedsUtf8ByteLimit(
      JSON.stringify(message),
      MAX_EMBEDDED_AUTH_MESSAGE_BYTES,
    )
  ) {
    throw new GarminEmbeddedAuthMessageError()
  }
  return {
    serviceTicket: message.serviceTicket,
    serviceUrl: message.serviceUrl,
  }
}

function exceedsUtf8ByteLimit(value: string, limit: number): boolean {
  if (value.length > limit) return true
  return new TextEncoder().encode(value).byteLength > limit
}

function isExactMessageObject(value: unknown): value is GarminEmbeddedAuthMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false

  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== 2
    || !keys.includes('serviceTicket')
    || !keys.includes('serviceUrl')
  ) {
    return false
  }

  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined
      && descriptor.enumerable
      && 'value' in descriptor
  })
}

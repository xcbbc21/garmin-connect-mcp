import type { GarminRegion } from './config'
import { PublicToolError } from './utils/errors'

const INVALID_CONFIGURATION_MESSAGE =
  'Garmin embedded authentication configuration is invalid'

export interface GarminEmbeddedAuthFrameConfig {
  frameUrl: string
  ssoOrigin: string
  serviceUrl: string
}

/** Build Garmin's fixed GAuth iframe URL for a dedicated loopback bridge. */
export function createGarminEmbeddedAuthFrameConfig(
  region: GarminRegion,
  bridgeOrigin: string,
): GarminEmbeddedAuthFrameConfig {
  if ((region !== 'global' && region !== 'cn') || !isExactLoopbackOrigin(bridgeOrigin)) {
    throw new PublicToolError(INVALID_CONFIGURATION_MESSAGE)
  }

  const domain = region === 'cn' ? 'garmin.cn' : 'garmin.com'
  const ssoOrigin = `https://sso.${domain}`
  const serviceUrl = `${ssoOrigin}/sso/embed`
  const frameUrl = new URL(`${ssoOrigin}/sso/signin`)
  frameUrl.searchParams.set('id', 'gauth-widget')
  frameUrl.searchParams.set('embedWidget', 'true')
  frameUrl.searchParams.set('gauthHost', `${ssoOrigin}/sso`)
  frameUrl.searchParams.set('service', serviceUrl)
  frameUrl.searchParams.set('source', bridgeOrigin)
  frameUrl.searchParams.set('consumeServiceTicket', 'false')

  return { frameUrl: frameUrl.toString(), ssoOrigin, serviceUrl }
}

function isExactLoopbackOrigin(candidate: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return false
  }
  const port = Number(parsed.port)
  return parsed.protocol === 'http:'
    && parsed.hostname === '127.0.0.1'
    && parsed.port !== ''
    && Number.isInteger(port)
    && port >= 1
    && port <= 65_535
    && parsed.username === ''
    && parsed.password === ''
    && parsed.pathname === '/'
    && parsed.search === ''
    && parsed.hash === ''
    && parsed.origin === candidate
}

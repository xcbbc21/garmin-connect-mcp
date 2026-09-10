/** The only coarse authentication states that may cross process boundaries. */
export const GARMIN_AUTHENTICATION_REQUIRED_REASONS = [
  'missing',
  'expired',
  'rejected',
  'challenge',
] as const

export type GarminAuthenticationRequiredReason =
  typeof GARMIN_AUTHENTICATION_REQUIRED_REASONS[number]

/** Browser-only detail retained locally; it must not be sent over the MCP transport. */
export type GarminBrowserChallengeKind = 'mfa' | 'verification'

export type GarminAuthenticationRequirementRegion = 'cn' | 'global'

/** Bounded, secret-free state that may be handed to a local UI. */
export interface GarminAuthenticationRequirement {
  reason: GarminAuthenticationRequiredReason
  region: GarminAuthenticationRequirementRegion
  revision: number
}

export function isGarminAuthenticationRequiredReason(
  value: unknown,
): value is GarminAuthenticationRequiredReason {
  return typeof value === 'string'
    && (GARMIN_AUTHENTICATION_REQUIRED_REASONS as readonly string[]).includes(value)
}

import type { GarminAuthenticationRequirement } from './protocol'

export interface AutomaticGarminAuthenticationState {
  active: boolean
  isLoopback: boolean
  lastHandledRevision: number | undefined
}

export interface AutomaticGarminAuthenticationDecision {
  region: GarminAuthenticationRequirement['region']
  revision: number
}

/** Claim one Host-issued auth requirement without creating reopen loops. */
export function nextAutomaticGarminAuthentication(
  requirement: GarminAuthenticationRequirement | undefined,
  state: AutomaticGarminAuthenticationState,
): AutomaticGarminAuthenticationDecision | undefined {
  if (
    !requirement
    || !state.isLoopback
    || state.active
    || state.lastHandledRevision === requirement.revision
  ) {
    return undefined
  }
  return {
    region: requirement.region,
    revision: requirement.revision,
  }
}

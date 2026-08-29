// Keep the auth domain browser-safe so Host and DSH client validate the same
// bounded vocabulary without pulling Node-only code into the web bundle.
export {
  GARMIN_AUTHENTICATION_REQUIRED_REASONS,
  isGarminAuthenticationRequiredReason,
} from './client/auth-requirement'
export type {
  GarminAuthenticationRequirement,
  GarminAuthenticationRequirementRegion,
  GarminAuthenticationRequiredReason,
  GarminBrowserChallengeKind,
} from './client/auth-requirement'

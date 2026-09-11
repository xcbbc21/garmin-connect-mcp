/** Public, framework-independent API. Importing this module starts no service. */
export { createMcpServer } from './mcp'
export type { CreateMcpServerOptions, McpAuthenticationHandler } from './mcp'
export { GarminClient } from './client'
export type { GarminClientOptions } from './client'
export { GarminToolService } from './tool-service'
export type {
  CalendarRangeArgs,
  GarminDataClient,
  GarminToolServiceOptions,
  ReconcileWriteOperationArgs,
  ResumeWriteOperationArgs,
} from './tool-service'
export { resolveConfig, resolveAccountAlias } from './config'
export type { Config, ConfigEnvironment, GarminRegion } from './config'
export { createStderrLogger } from './logger'
export type { GarminLogger } from './logger'

/**
 * Calendar read contract and the recovery vocabulary a caller needs to branch
 * on a write result without parsing message text.
 */
export { MAX_CALENDAR_RANGE_DAYS, describeCalendarCapability } from './calendar/adapter'
export type {
  CalendarEntry,
  CalendarMissingRange,
  CalendarRange,
  CalendarSnapshot,
} from './calendar/types'
export {
  CalendarCapabilityError,
  CalendarRangeError,
  CalendarTargetError,
  CALENDAR_WARNING_CODES,
  observeCalendarTarget,
} from './calendar/types'
export type { CalendarLookup } from './write-operations/reconcile'
export { RECONCILE_BUDGET_MS, RECONCILE_MAX_READS } from './write-operations/reconcile'
export { GarminWriteError, WRITE_ERROR_CODES, isGarminWriteError } from './write-operations/errors'
export type { WriteErrorCode, WriteOutcome } from './write-operations/errors'

import { z } from 'zod'
import { isAbsolute, join, normalize } from 'node:path'
import { homedir } from 'node:os'
import { assertAccountAlias, defaultAccountSessionPath, platformConfigRoot } from './account-session'
import { PublicToolError } from './utils/errors'
import { resolveFitDownloadDir } from './utils/path'

export { resolveFitDownloadDir } from './utils/path'

export type GarminRegion = 'global' | 'cn'

/** This distribution is intentionally bound to Garmin Connect China. */
export const DEFAULT_GARMIN_REGION: GarminRegion = 'cn'

export interface Config {
  /** Garmin account email address */
  username: string
  /** Garmin account password (loaded from env by default) */
  password?: string
  /** Pre-authenticated session token — avoids storing the password entirely */
  sessionToken?: string
  /** Path to a JSON file containing a pre-authenticated session token */
  sessionTokenFile?: string
  /** Internal server identity; the public runtime is fixed to China. */
  region: GarminRegion
  /** In-memory cache TTL in seconds (0 = disabled) */
  cacheTtl: number
  /** Garmin request timeout in milliseconds */
  requestTimeoutMs?: number
  /** Logging verbosity */
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  /** Default activity detail: compact, or expanded full data with private fields filtered */
  activityDetail: 'compact' | 'full'
  /** FIT parent; output is separated by the fixed Garmin region and account */
  fitDownloadDir: string
  /**
   * Absolute local directory holding the account-scoped write journal and
   * lock. Independent of the session file path, so every login alias for the
   * same account shares one recovery log. Optional in the type so existing
   * callers keep compiling; `resolveConfig` always populates it and the tool
   * service resolves the platform default when a caller omits it.
   */
  stateDirectory?: string
}

export type ConfigEnvironment = Record<string, string | undefined>

// No credentials or environment values are captured in schema metadata.
const configSchema = z.object({
  username: z.string().min(1),
  password: z.string().optional(),
  sessionToken: z.string().optional(),
  sessionTokenFile: z.string(),
  region: z.enum(['global', 'cn']),
  cacheTtl: z.number().finite().min(0),
  requestTimeoutMs: z.number().finite().positive(),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']),
  activityDetail: z.enum(['compact', 'full']),
  fitDownloadDir: z.string(),
  stateDirectory: z.string(),
})

export function resolveAccountAlias(env: ConfigEnvironment = process.env): string {
  const account = env.GARMIN_ACCOUNT?.trim() || 'default'
  assertAccountAlias(account)
  return account
}

/** Resolve explicit options over runtime environment; importing never loads dotenv. */
export function resolveConfig(
  input: Partial<Config> = {},
  env: ConfigEnvironment = process.env,
): Config {
  const account = resolveAccountAlias(env)
  const username = preferNonEmpty(input.username, env.GARMIN_USERNAME).trim()
  if (!username) throw new PublicToolError('GARMIN_USERNAME is required')
  if (env.GARMIN_REGION?.trim()) {
    throw new PublicToolError(
      'GARMIN_REGION is no longer supported; Garmin MCP is fixed to China (cn)',
    )
  }
  if (input.region !== undefined && input.region !== DEFAULT_GARMIN_REGION) {
    throw new PublicToolError('region selection is no longer supported; Garmin MCP is fixed to China (cn)')
  }
  const region = DEFAULT_GARMIN_REGION
  const result = configSchema.safeParse({
    username,
    password: input.password?.trim() ? input.password : env.GARMIN_PASSWORD,
    sessionToken: input.sessionToken?.trim() ? input.sessionToken : env.GARMIN_SESSION_TOKEN,
    sessionTokenFile: preferNonEmpty(input.sessionTokenFile, env.GARMIN_SESSION_TOKEN_FILE).trim()
      || defaultAccountSessionPath(account, env),
    region,
    activityDetail: input.activityDetail
      ?? (env.GARMIN_ACTIVITY_DETAIL === 'full' ? 'full' : 'compact'),
    fitDownloadDir: resolveFitDownloadDir(preferNonEmpty(input.fitDownloadDir, env.GARMIN_FIT_DOWNLOAD_DIR)),
    stateDirectory: resolveStateDirectory(
      input.stateDirectory ?? env.GARMIN_STATE_DIR,
      env,
    ),
    cacheTtl: input.cacheTtl ?? envNumber(env.GARMIN_CACHE_TTL, 300, true),
    requestTimeoutMs: input.requestTimeoutMs ?? envNumber(env.GARMIN_REQUEST_TIMEOUT_MS, 15_000, false),
    logLevel: input.logLevel ?? envChoice(
      env.GARMIN_LOG_LEVEL, ['debug', 'info', 'warn', 'error'] as const, 'info',
    ),
  })
  if (!result.success) {
    // Zod issues can contain values supplied by callers; expose field names only.
    const fields = [...new Set(result.error.issues.map(issue => issue.path[0]))].join(', ')
    throw new PublicToolError('Invalid Garmin configuration fields: ' + fields)
  }
  return result.data
}

/**
 * Resolve the write-journal root. Must be an absolute local path; relative
 * values are rejected so the journal can never depend on the server CWD. When
 * unset, it defaults to `<platform config root>/garmin-connect-mcp/state`.
 */
export function resolveStateDirectory(
  value: string | undefined,
  env: ConfigEnvironment = process.env,
): string {
  const configured = value?.trim()
  if (!configured) {
    return join(platformConfigRoot(env), 'garmin-connect-mcp', 'state')
  }
  const expanded = configured === '~'
    ? (env.HOME?.trim() || homedir())
    : configured
  if (!isAbsolute(expanded)) {
    throw new PublicToolError('GARMIN_STATE_DIR must be an absolute local path')
  }
  return normalize(expanded)
}

function preferNonEmpty(primary: string | undefined, fallback: string | undefined): string {
  if (primary?.trim()) return primary
  return fallback?.trim() ? fallback : ''
}

function envNumber(value: string | undefined, fallback: number, allowZero: boolean): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || (!allowZero && parsed === 0)) return fallback
  return parsed
}

function envChoice<const T extends readonly string[]>(
  value: string | undefined, allowed: T, fallback: T[number],
): T[number] {
  return value !== undefined && allowed.includes(value) ? value as T[number] : fallback
}

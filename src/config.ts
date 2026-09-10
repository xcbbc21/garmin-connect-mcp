import { z } from 'zod'
import { assertAccountAlias, defaultAccountSessionPath } from './account-session'
import { PublicToolError } from './utils/errors'
import { resolveFitDownloadDir } from './utils/path'

export { resolveFitDownloadDir } from './utils/path'

export type GarminRegion = 'global' | 'cn'

export interface Config {
  /** Garmin account email address */
  username: string
  /** Garmin account password (loaded from env by default) */
  password?: string
  /** Pre-authenticated session token — avoids storing the password entirely */
  sessionToken?: string
  /** Path to a JSON file containing a pre-authenticated session token */
  sessionTokenFile?: string
  /** Garmin server region */
  region: GarminRegion
  /** In-memory cache TTL in seconds (0 = disabled) */
  cacheTtl: number
  /** Garmin request timeout in milliseconds */
  requestTimeoutMs?: number
  /** Logging verbosity */
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  /** Default activity detail: compact, or expanded full data with private fields filtered */
  activityDetail: 'compact' | 'full'
  /** User-selected FIT parent; output is separated by Garmin region and account */
  fitDownloadDir: string
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
  const region = input.region ?? env.GARMIN_REGION ?? 'global'
  if (region !== 'global' && region !== 'cn') {
    throw new PublicToolError('GARMIN_REGION must be exactly global or cn')
  }
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

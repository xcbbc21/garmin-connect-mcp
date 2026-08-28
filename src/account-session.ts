import { homedir } from 'node:os'
import path from 'node:path'
import { PublicToolError } from './utils/errors'

export const ACCOUNT_ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/

export function assertAccountAlias(value: string): void {
  if (!ACCOUNT_ALIAS_PATTERN.test(value)) {
    throw new PublicToolError(
      'Invalid account alias; use lowercase letters, numbers, underscores, or hyphens',
    )
  }
}

export function defaultAccountSessionPath(
  account: string,
  env: Record<string, string | undefined> = process.env,
): string {
  assertAccountAlias(account)
  const configRoot = env.XDG_CONFIG_HOME?.trim()
    || env.LOCALAPPDATA?.trim()
    || env.APPDATA?.trim()
    || path.join(env.HOME?.trim() || homedir(), '.config')
  return path.resolve(
    configRoot,
    'dsh-plugin-garmin-connect',
    'accounts',
    `${account}.session.json`,
  )
}

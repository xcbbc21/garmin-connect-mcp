import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { PublicToolError } from './utils/errors'

const DARWIN_LS = '/bin/ls'
const DARWIN_ACL_ERROR = 'Garmin session ACL could not be verified'
const DARWIN_ACL_MAX_BUFFER_BYTES = 64 * 1024
const DARWIN_ACL_TIMEOUT_MS = 5_000
const MAX_TARGET_BYTES = 4 * 1024
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/
const ACL_ENTRY_PATTERN =
  /^\s+\d+:\s+.+\s+(?:inherited\s+)?(allow|deny)\s+[a-z][a-z0-9_-]*(?:,[a-z][a-z0-9_-]*)*\s*$/

export interface DarwinAclCommandOptions {
  encoding: 'utf8'
  env: {
    LANG: 'C'
    LC_ALL: 'C'
  }
  maxBuffer: number
  shell: false
  timeout: number
}

export type DarwinAclCommandRunner = (
  file: string,
  args: readonly string[],
  options: DarwinAclCommandOptions,
) => Promise<{ stdout: string; stderr: string }>

export interface DarwinAclVerificationOptions {
  run?: DarwinAclCommandRunner
}

/**
 * Reject Darwin ACL entries that grant access beyond POSIX owner-only mode.
 * Deny-only entries (including the standard macOS home `deny delete` ACE) are
 * safe because they can only remove rights. The caller binds this path-based
 * inspection to lstat/fstat inode identity before handling credential bytes.
 */
export async function verifyNoGrantingDarwinAcl(
  path: string,
  options: DarwinAclVerificationOptions = {},
): Promise<void> {
  try {
    if (
      typeof path !== 'string'
      || !isAbsolute(path)
      || CONTROL_CHARACTER_PATTERN.test(path)
      || Buffer.byteLength(path, 'utf8') > MAX_TARGET_BYTES
    ) {
      throw new Error('Invalid ACL target')
    }

    const run = options.run ?? runDarwinAclCommand
    const result = await run(DARWIN_LS, ['-lde', '--', path], {
      encoding: 'utf8',
      env: { LANG: 'C', LC_ALL: 'C' },
      maxBuffer: DARWIN_ACL_MAX_BUFFER_BYTES,
      shell: false,
      timeout: DARWIN_ACL_TIMEOUT_MS,
    })
    if (
      typeof result.stdout !== 'string'
      || typeof result.stderr !== 'string'
      || result.stderr.length !== 0
      || Buffer.byteLength(result.stdout, 'utf8') > DARWIN_ACL_MAX_BUFFER_BYTES
      || Buffer.byteLength(result.stderr, 'utf8') > DARWIN_ACL_MAX_BUFFER_BYTES
    ) {
      throw new Error('Invalid ACL inspection output')
    }

    const lines = result.stdout.split(/\r?\n/)
    if (!lines[0]?.trim()) throw new Error('Missing ACL target output')
    for (const line of lines.slice(1)) {
      if (line.length === 0) continue
      const entry = ACL_ENTRY_PATTERN.exec(line)
      if (!entry || entry[1] !== 'deny') {
        throw new Error('Granting or malformed ACL entry')
      }
    }
  } catch {
    throw new PublicToolError(DARWIN_ACL_ERROR)
  }
}

const runDarwinAclCommand: DarwinAclCommandRunner = (
  file,
  args,
  options,
) => new Promise((resolve, reject) => {
  execFile(file, [...args], options, (error, stdout, stderr) => {
    if (error) {
      reject(error)
      return
    }
    resolve({ stdout, stderr })
  })
})

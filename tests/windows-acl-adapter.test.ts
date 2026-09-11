import type { WindowsAclCommandOptions } from '../src/windows-private-acl'

/**
 * The shipping ACL adapter spawns PowerShell through `execFile`. On a POSIX
 * host that child process can never start, so `runWindowsCommand`'s *resolve*
 * branch is unreachable there and no injection seam exists for it: `run` is the
 * seam *above* this function, not inside it.
 *
 * This file substitutes `node:child_process` so the adapter's own contract is
 * pinned on every platform: which executable and argument vector it builds, how
 * an `execFile` callback maps into `{ stdout, stderr }`, and that a spawn error
 * is propagated rather than swallowed.
 *
 * SCOPE — this is adapter-contract coverage only. It is not evidence about real
 * Windows DACLs, and it must never be counted as such. Real DACL behaviour is
 * verified by the win32-only host integration suite in
 * `tests/windows-private-acl.test.ts`, which this file deliberately does not
 * mock.
 */
jest.mock('node:child_process', () => ({ execFile: jest.fn() }))

import { execFile } from 'node:child_process'
import { createWindowsPrivateAcl } from '../src/windows-private-acl'

const mockedExecFile = execFile as unknown as jest.Mock

type ExecFileCallback = (
  error: Error | null,
  stdout: string,
  stderr: string,
) => void

function succeedWith(stdout = '', stderr = ''): void {
  mockedExecFile.mockImplementation((
    _file: string,
    _args: readonly string[],
    _options: unknown,
    callback: ExecFileCallback,
  ) => {
    callback(null, stdout, stderr)
  })
}

function failWith(error: Error): void {
  mockedExecFile.mockImplementation((
    _file: string,
    _args: readonly string[],
    _options: unknown,
    callback: ExecFileCallback,
  ) => {
    callback(error, '', '')
  })
}

function callOf(index: number): [string, string[], WindowsAclCommandOptions] {
  return mockedExecFile.mock.calls[index] as [
    string,
    string[],
    WindowsAclCommandOptions,
  ]
}

describe('Windows ACL command adapter (adapter contract, not a real DACL check)', () => {
  const systemRoot = 'C:\\Windows'

  beforeEach(() => {
    mockedExecFile.mockReset()
  })

  it('spawns the absolute shell-free PowerShell with the encoded ACL script', async () => {
    succeedWith()
    const acl = await createWindowsPrivateAcl({ systemRoot })

    await expect(acl.prepareDirectory('C:\\private\\account')).resolves.toBeUndefined()

    expect(mockedExecFile).toHaveBeenCalledTimes(1)
    const [file, args, options] = callOf(0)

    expect(file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(args.slice(0, 4)).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
    ])
    // The encoded argument must be the real exact-DACL script, not a placeholder.
    const script = Buffer.from(args[4], 'base64').toString('utf16le')
    expect(script).toContain('Assert-ExactPrivateDirectoryChain')
    expect(script).toContain('Assert-NoReparseChain')

    expect(options.encoding).toBe('utf8')
    expect(options.shell).toBe(false)
    expect(options.windowsHide).toBe(true)
    expect(options.maxBuffer).toBe(64 * 1024)
    expect(options.timeout).toBe(120_000)
    expect(options.env.SystemRoot).toBe(systemRoot)
    expect(options.env.WINDIR).toBe(systemRoot)
    expect(options.env.GARMIN_ACL_OPERATION).toBe('prepare-directory')
    expect(options.env.GARMIN_ACL_TARGET).toBe('C:\\private\\account')
    expect(options.env.GARMIN_ACL_ALLOW_MISSING).toBe('0')
  })

  it('passes allowMissing through to the child process environment', async () => {
    succeedWith()
    const acl = await createWindowsPrivateAcl({ systemRoot })

    await acl.verifyDirectory('C:\\private\\account', { allowMissing: true })
    await acl.verifyDirectory('C:\\private\\account')
    await acl.secureFile('C:\\private\\account\\session.tmp')
    await acl.verifyFile('C:\\private\\account\\session.json')

    expect(callOf(0)[2].env.GARMIN_ACL_OPERATION).toBe('verify-directory')
    expect(callOf(0)[2].env.GARMIN_ACL_ALLOW_MISSING).toBe('1')
    expect(callOf(1)[2].env.GARMIN_ACL_ALLOW_MISSING).toBe('0')
    expect(callOf(2)[2].env.GARMIN_ACL_OPERATION).toBe('secure-file')
    expect(callOf(2)[2].env.GARMIN_ACL_TARGET).toBe('C:\\private\\account\\session.tmp')
    expect(callOf(3)[2].env.GARMIN_ACL_OPERATION).toBe('verify-file')
    expect(callOf(3)[2].env.GARMIN_ACL_TARGET).toBe('C:\\private\\account\\session.json')
  })

  it('treats a bounded stdout/stderr payload as success', async () => {
    // The resolve branch carries the child's output; the adapter only rejects
    // once that output exceeds the buffer cap.
    succeedWith('ok\n', 'warning\n')
    const acl = await createWindowsPrivateAcl({ systemRoot })

    await expect(acl.secureFile('C:\\private\\account\\session.tmp'))
      .resolves.toBeUndefined()
    expect(mockedExecFile).toHaveBeenCalledTimes(1)
  })

  it('fails closed when the child process reports an error', async () => {
    failWith(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
    const acl = await createWindowsPrivateAcl({ systemRoot })

    let thrown: unknown
    try {
      await acl.verifyFile('C:\\Users\\runner\\.garmin\\session.json')
    } catch (error) {
      thrown = error
    }

    expect(thrown).toEqual(expect.objectContaining({
      name: 'PublicToolError',
      message: 'Garmin session token file could not be written',
    }))
    // The spawn error itself must not be echoed to the caller.
    expect(String(thrown)).not.toContain('ENOENT')
  })
})

import type {
  DarwinAclCommandOptions,
  DarwinAclCommandRunner,
} from '../src/darwin-private-acl'
import { verifyNoGrantingDarwinAcl } from '../src/darwin-private-acl'

describe('Darwin non-granting ACL verification', () => {
  it('uses absolute shell-free ls and accepts the standard deny-only home ACL', async () => {
    const calls: Array<{
      file: string
      args: readonly string[]
      options: DarwinAclCommandOptions
    }> = []
    const run: DarwinAclCommandRunner = async (file, args, options) => {
      calls.push({ file, args, options })
      return {
        stdout: [
          'drwx------@ 2 runner staff 64 Aug 28 12:00 /private/account',
          ' 0: group:everyone deny delete',
          '',
        ].join('\n'),
        stderr: '',
      }
    }

    await expect(verifyNoGrantingDarwinAcl('/private/account', { run }))
      .resolves.toBeUndefined()

    expect(calls).toEqual([{
      file: '/bin/ls',
      args: ['-lde', '--', '/private/account'],
      options: {
        encoding: 'utf8',
        env: { LANG: 'C', LC_ALL: 'C' },
        maxBuffer: 64 * 1024,
        shell: false,
        timeout: 5_000,
      },
    }])
  })

  it.each([
    [
      'granting entry',
      ' 0: group:everyone inherited allow read,write,file_inherit',
    ],
    ['unknown action', ' 0: group:everyone audit read'],
    ['malformed continuation', ' PRIVATE_ACL_MARKER'],
  ])('rejects a %s with one fixed error', async (_label, aclLine) => {
    const run: DarwinAclCommandRunner = async () => ({
      stdout: `-rw-------@ 1 runner staff 8 Aug 28 12:00 /private/session\n${aclLine}\n`,
      stderr: '',
    })

    const operation = verifyNoGrantingDarwinAcl(
      '/private/SECRET_ACCOUNT/session.json',
      { run },
    )

    await expect(operation).rejects.toThrow(
      'Garmin session ACL could not be verified',
    )
    await expect(operation).rejects.not.toThrow('SECRET_ACCOUNT')
    await expect(operation).rejects.not.toThrow('PRIVATE_ACL_MARKER')
  })

  it('accepts an xattr marker without ACL continuation lines', async () => {
    const run: DarwinAclCommandRunner = async () => ({
      stdout: '-rw-------@ 1 runner staff 8 Aug 28 12:00 /private/session\n',
      stderr: '',
    })

    await expect(verifyNoGrantingDarwinAcl('/private/session', { run }))
      .resolves.toBeUndefined()
  })

  it('normalizes command errors and injected output without leaking either', async () => {
    const marker = 'PRIVATE_ACL_COMMAND_OUTPUT'
    const run: DarwinAclCommandRunner = async () => {
      throw new Error(marker)
    }

    const operation = verifyNoGrantingDarwinAcl('/private/SECRET_ACCOUNT', { run })

    await expect(operation).rejects.toThrow(
      'Garmin session ACL could not be verified',
    )
    await expect(operation).rejects.not.toThrow(marker)
    await expect(operation).rejects.not.toThrow('SECRET_ACCOUNT')
  })
})

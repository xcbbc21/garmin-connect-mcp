import {
  runAuthCanary,
  runAuthServe,
  runAuthSetup,
  runBrowserAuthSetup,
  type AuthCliIO,
} from '../src/auth-cli'

const TOKENS = {
  oauth1: { oauth_token: 'TOKEN_ONE' },
  oauth2: { access_token: 'TOKEN_TWO' },
}

function io(): AuthCliIO {
  return {
    prompt: jest.fn(async (label: string) => label.includes('password') ? 'password' : 'yes'),
    write: jest.fn(),
  }
}

describe('China-only authentication entry points', () => {
  it('uses China for terminal login when no region is supplied', async () => {
    const authenticate = jest.fn(async () => ({ tokens: TOKENS, usedMfa: false }))
    const writeSession = jest.fn().mockResolvedValue(undefined)

    await expect(runAuthSetup({
      argv: ['login'],
      env: { GARMIN_USERNAME: 'runner@example.test' },
      io: io(),
      dependencies: { authenticate, writeSession },
    })).resolves.toMatchObject({ region: 'cn' })
    expect(authenticate).toHaveBeenCalledWith(expect.objectContaining({ region: 'cn' }))
  })

  it('uses China for browser login, serve, and canary without region flags', async () => {
    const setup = jest.fn(async () => ({ ok: true as const, region: 'cn' as const, persisted: true as const }))
    await expect(runBrowserAuthSetup({
      argv: ['login', '--browser'],
      env: { GARMIN_USERNAME: 'runner@example.test' },
      io: io(),
      dependencies: { setup, prepareDestination: jest.fn().mockResolvedValue(undefined) },
    })).resolves.toMatchObject({ region: 'cn' })
    expect(setup).toHaveBeenCalledWith(expect.objectContaining({ region: 'cn' }))

    const authenticate = jest.fn(async () => ({ success: true as const, region: 'cn' as const }))
    await expect(runAuthServe({
      argv: ['serve', '--open', '--account', 'default'],
      env: { GARMIN_USERNAME: 'runner@example.test' },
      io: io(),
      dependencies: { authenticate, prepareDestination: jest.fn().mockResolvedValue(undefined) },
    })).resolves.toMatchObject({ region: 'cn' })
    expect(authenticate).toHaveBeenCalledWith(expect.objectContaining({ region: 'cn' }))

    const canary = jest.fn(async () => ({ ok: true as const, region: 'cn' as const, persisted: false as const }))
    await expect(runAuthCanary({
      argv: ['canary'],
      io: io(),
      dependencies: { canary },
    })).resolves.toMatchObject({ region: 'cn' })
    expect(canary).toHaveBeenCalledWith(expect.objectContaining({ region: 'cn' }))
  })
})

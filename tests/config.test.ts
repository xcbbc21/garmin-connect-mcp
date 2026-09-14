import {
  resolveAccountAlias,
  resolveConfig,
  resolveFitDownloadDir,
  resolveStateDirectory,
} from '../src/config'

const env = { GARMIN_USERNAME: 'runner@example.test' }

describe('runtime configuration', () => {
  it('resolves defaults without credentials and assigns the default account path', () => {
    expect(resolveConfig({}, { ...env, XDG_CONFIG_HOME: '/private/config' })).toMatchObject({
      username: env.GARMIN_USERNAME, password: undefined, sessionToken: undefined,
      sessionTokenFile: '/private/config/garmin-connect-mcp/accounts/default.session.json',
      region: 'cn', cacheTtl: 300, requestTimeoutMs: 15000,
      logLevel: 'info', activityDetail: 'compact', fitDownloadDir: '',
      stateDirectory: '/private/config/garmin-connect-mcp/state',
    })
  })
  it.each(['global', 'cn ', 'CN', 'mars'])('rejects the removed region environment setting: %s', region => {
    expect(() => resolveConfig({}, { ...env, GARMIN_REGION: region }))
      .toThrow('GARMIN_REGION is no longer supported')
  })
  it('requires a username and rejects escaping account aliases', () => {
    expect(() => resolveConfig({}, {})).toThrow('GARMIN_USERNAME is required')
    expect(() => resolveConfig({}, { ...env, GARMIN_ACCOUNT: '../escape' })).toThrow('Invalid account alias')
    expect(resolveAccountAlias({ GARMIN_ACCOUNT: ' personal-cn ' })).toBe('personal-cn')
  })
  it('honors explicit non-empty settings over environment values', () => {
    expect(resolveConfig({
      username: 'explicit@example.test', password: 'explicit-password',
      sessionToken: 'explicit-token', sessionTokenFile: '/explicit/session.json',
      region: 'cn', cacheTtl: 0, logLevel: 'error', activityDetail: 'full',
    }, { ...env, GARMIN_PASSWORD: 'env-password', GARMIN_SESSION_TOKEN: 'env-token',
      GARMIN_SESSION_TOKEN_FILE: '/env/session.json' })).toMatchObject({
      username: 'explicit@example.test', password: 'explicit-password',
      sessionToken: 'explicit-token', sessionTokenFile: '/explicit/session.json',
      region: 'cn', cacheTtl: 0, logLevel: 'error', activityDetail: 'full',
    })
  })
  it('resolves environment values at call time and falls back for blank overrides', () => {
    const runtime = { ...env, GARMIN_PASSWORD: 'env-password', GARMIN_SESSION_TOKEN: 'env-token' }
    expect(resolveConfig({ username: '', password: '', sessionToken: '' }, runtime))
      .toMatchObject({ username: env.GARMIN_USERNAME, password: 'env-password', sessionToken: 'env-token' })
    runtime.GARMIN_USERNAME = 'changed@example.test'
    expect(resolveConfig({}, runtime).username).toBe('changed@example.test')
  })
  it('retains existing environment numeric and enum fallback semantics', () => {
    expect(resolveConfig({}, { ...env, GARMIN_CACHE_TTL: '0', GARMIN_REQUEST_TIMEOUT_MS: '4321',
      GARMIN_LOG_LEVEL: 'warn', GARMIN_ACTIVITY_DETAIL: 'full' })).toMatchObject({
      cacheTtl: 0, requestTimeoutMs: 4321, logLevel: 'warn', activityDetail: 'full',
    })
    for (const invalid of ['', '-1', 'NaN', 'Infinity']) {
      expect(resolveConfig({}, { ...env, GARMIN_CACHE_TTL: invalid, GARMIN_REQUEST_TIMEOUT_MS: invalid,
        GARMIN_LOG_LEVEL: 'verbose', GARMIN_ACTIVITY_DETAIL: 'everything' })).toMatchObject({
        cacheTtl: 300, requestTimeoutMs: 15000, logLevel: 'info', activityDetail: 'compact',
      })
    }
    expect(resolveConfig({}, { ...env, GARMIN_REQUEST_TIMEOUT_MS: '0' }).requestTimeoutMs).toBe(15000)
  })
  it('rejects invalid explicit numeric options without exposing credential values', () => {
    for (const input of [{ cacheTtl: -1 }, { requestTimeoutMs: 0 }, { cacheTtl: Infinity }]) {
      expect(() => resolveConfig(input, env)).toThrow('Invalid Garmin configuration fields')
    }
  })
  it('leaves FIT disabled unless selected and resolves selected paths', () => {
    expect(resolveFitDownloadDir('', '/private/home')).toBe('')
    expect(resolveFitDownloadDir('~/private-fit', '/private/home')).toBe('/private/home/private-fit')
    expect(resolveConfig({}, { ...env, GARMIN_FIT_DOWNLOAD_DIR: '/private/fit' }).fitDownloadDir).toBe('/private/fit')
  })
})

describe('write-journal state directory', () => {
  it('defaults under the platform config root, independent of the session file', () => {
    expect(resolveStateDirectory(undefined, { XDG_CONFIG_HOME: '/private/config' }))
      .toBe('/private/config/garmin-connect-mcp/state')
    expect(resolveStateDirectory(undefined, { HOME: '/private/home' }))
      .toBe('/private/home/.config/garmin-connect-mcp/state')
  })

  it('accepts an absolute override and expands a bare tilde', () => {
    expect(resolveConfig({}, { ...env, GARMIN_STATE_DIR: '/private/state' }).stateDirectory)
      .toBe('/private/state')
    expect(resolveStateDirectory('~', { HOME: '/private/home' }))
      .toBe('/private/home')
  })

  it('rejects relative paths before any journal is opened', () => {
    expect(() => resolveStateDirectory('relative/state', { HOME: '/private/home' }))
      .toThrow('GARMIN_STATE_DIR must be an absolute local path')
    expect(() => resolveConfig({}, { ...env, GARMIN_STATE_DIR: 'relative/state' }))
      .toThrow('GARMIN_STATE_DIR must be an absolute local path')
  })
})

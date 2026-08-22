import type { Context } from '@deepseek-ai/cordis'
import type { Config } from '../src/config'

const mockConnect = jest.fn().mockRejectedValue(new Error('not authenticated yet'))
const mockAcceptPersistedSessionUpdate = jest.fn().mockResolvedValue(undefined)
const mockClient = {
  connect: mockConnect,
  acceptPersistedSessionUpdate: mockAcceptPersistedSessionUpdate,
}
const mockRegisterTools = jest.fn()
const mockRegisterEmbeddedAuthRpc = jest.fn()
const mockResolveEmbeddedAuthConfig = jest.fn((config: Config) => ({
  ...config,
  sessionTokenFile: '/private/config/accounts/default.session.json',
}))

jest.mock('../src/client', () => ({
  GarminClient: jest.fn(() => mockClient),
}))
jest.mock('../src/config', () => ({
  Config: {},
  resolveConfig: (value: Config) => value,
}))
jest.mock('../src/tools', () => ({ registerTools: mockRegisterTools }))
jest.mock('../src/embedded-auth-rpc', () => ({
  registerEmbeddedAuthRpc: mockRegisterEmbeddedAuthRpc,
  resolveEmbeddedAuthConfig: mockResolveEmbeddedAuthConfig,
}))

import { GarminClient } from '../src/client'
import { apply } from '../src/index'

const config: Config = {
  username: 'runner@example.test',
  password: '',
  sessionToken: '',
  sessionTokenFile: '',
  region: 'global',
  cacheTtl: 0,
  requestTimeoutMs: 15_000,
  logLevel: 'info',
  activityDetail: 'compact',
  fitDownloadDir: '',
}

describe('plugin activation', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('registers embedded auth even when eager Garmin connection is unavailable', async () => {
    apply({} as Context, config)
    await Promise.resolve()

    expect(GarminClient).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sessionTokenFile: '/private/config/accounts/default.session.json',
      }),
    )
    expect(mockRegisterTools).toHaveBeenCalledTimes(1)
    expect(mockRegisterEmbeddedAuthRpc).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { onSessionSaved: expect.any(Function) },
    )

    const options = mockRegisterEmbeddedAuthRpc.mock.calls[0][2]
    await options.onSessionSaved()
    expect(mockAcceptPersistedSessionUpdate).toHaveBeenCalledTimes(1)
  })
})

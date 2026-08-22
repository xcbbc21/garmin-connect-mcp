import { createGarminEmbeddedAuthFrameConfig } from '../src/embedded-auth-url'

describe('Garmin embedded authentication frame URL', () => {
  it.each([
    {
      region: 'global' as const,
      ssoOrigin: 'https://sso.garmin.com',
    },
    {
      region: 'cn' as const,
      ssoOrigin: 'https://sso.garmin.cn',
    },
  ])('builds the fixed $region GAuth widget contract', ({ region, ssoOrigin }) => {
    const bridgeOrigin = 'http://127.0.0.1:43127'
    const result = createGarminEmbeddedAuthFrameConfig(region, bridgeOrigin)
    const frameUrl = new URL(result.frameUrl)

    expect(result).toEqual({
      frameUrl: expect.any(String),
      ssoOrigin,
      serviceUrl: `${ssoOrigin}/sso/embed`,
    })
    expect(frameUrl.origin + frameUrl.pathname).toBe(`${ssoOrigin}/sso/signin`)
    expect(Array.from(frameUrl.searchParams.entries())).toEqual([
      ['id', 'gauth-widget'],
      ['embedWidget', 'true'],
      ['gauthHost', `${ssoOrigin}/sso`],
      ['service', `${ssoOrigin}/sso/embed`],
      ['source', bridgeOrigin],
      ['consumeServiceTicket', 'false'],
    ])
  })

  it.each([
    'https://127.0.0.1:43127',
    'http://localhost:43127',
    'http://127.0.0.1',
    'http://127.0.0.1:43127/path',
    'http://user@127.0.0.1:43127',
    'http://127.0.0.2:43127',
  ])('rejects a bridge source outside the exact loopback origin contract: %s', (
    bridgeOrigin,
  ) => {
    expect(() => createGarminEmbeddedAuthFrameConfig('cn', bridgeOrigin))
      .toThrow('Garmin embedded authentication configuration is invalid')
  })

  it('rejects a runtime region outside the closed global/cn set', () => {
    expect(() => createGarminEmbeddedAuthFrameConfig(
      'staging' as 'global',
      'http://127.0.0.1:43127',
    )).toThrow('Garmin embedded authentication configuration is invalid')
  })
})

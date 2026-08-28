import {
  GARMIN_EMBEDDED_AUTH_MESSAGE_REJECTED,
  GarminEmbeddedAuthMessageError,
  parseGarminEmbeddedAuthMessage,
} from '../src/embedded-auth-message'

const expectedOrigin = 'https://sso.garmin.cn'
const expectedServiceUrl = 'https://sso.garmin.cn/sso/embed'
const expectedBridgeOrigin = 'http://127.0.0.1:43123'
const expectedContext = {
  observedOrigin: expectedOrigin,
  expectedOrigin,
  sourceMatches: true,
  expectedServiceUrl,
  expectedBridgeOrigin,
}

function expectRejected(action: () => unknown, secret?: string): void {
  let caught: unknown
  try {
    action()
  } catch (error) {
    caught = error
  }

  expect(caught).toBeInstanceOf(GarminEmbeddedAuthMessageError)
  expect((caught as Error).message).toBe(
    GARMIN_EMBEDDED_AUTH_MESSAGE_REJECTED,
  )
  if (secret) expect((caught as Error).message).not.toContain(secret)
}

describe('Garmin embedded authentication message parser', () => {
  it('accepts a valid object from the expected Garmin iframe', () => {
    expect(parseGarminEmbeddedAuthMessage(
      {
        serviceTicket: 'ST-valid_ticket.123~safe',
        serviceUrl: expectedServiceUrl,
      },
      {
        ...expectedContext,
      },
    )).toEqual({
      serviceTicket: 'ST-valid_ticket.123~safe',
      serviceUrl: expectedServiceUrl,
    })
  })

  it('accepts the exact loopback bridge origin as Garmin service URL', () => {
    expect(parseGarminEmbeddedAuthMessage(
      {
        serviceTicket: 'ST-loopback-service',
        serviceUrl: expectedBridgeOrigin,
      },
      expectedContext,
    )).toEqual({
      serviceTicket: 'ST-loopback-service',
      serviceUrl: expectedBridgeOrigin,
    })
  })

  it('accepts Garmin data encoded as one JSON string', () => {
    const payload = JSON.stringify({
      serviceTicket: 'ST-json-string',
      serviceUrl: expectedServiceUrl,
    })

    expect(parseGarminEmbeddedAuthMessage(payload, expectedContext)).toEqual({
      serviceTicket: 'ST-json-string',
      serviceUrl: expectedServiceUrl,
    })
  })

  it('accepts Garmin data encoded as two JSON string layers', () => {
    const payload = JSON.stringify(JSON.stringify({
      serviceTicket: 'ST-double-json-string',
      serviceUrl: expectedServiceUrl,
    }))

    expect(parseGarminEmbeddedAuthMessage(payload, expectedContext)).toEqual({
      serviceTicket: 'ST-double-json-string',
      serviceUrl: expectedServiceUrl,
    })
  })

  it('rejects a message from any origin other than the exact expected origin', () => {
    const ticket = 'ST-origin-secret'

    expectRejected(() => parseGarminEmbeddedAuthMessage(
      { serviceTicket: ticket, serviceUrl: expectedServiceUrl },
      { ...expectedContext, observedOrigin: 'https://sso.garmin.com' },
    ), ticket)
  })

  it('rejects a message that did not come from the expected iframe window', () => {
    const ticket = 'ST-wrong-source-secret'

    expectRejected(() => parseGarminEmbeddedAuthMessage(
      { serviceTicket: ticket, serviceUrl: expectedServiceUrl },
      { ...expectedContext, sourceMatches: false },
    ), ticket)
  })

  it('rejects a message for a different service URL', () => {
    const ticket = 'ST-wrong-service-secret'

    expectRejected(() => parseGarminEmbeddedAuthMessage(
      {
        serviceTicket: ticket,
        serviceUrl: 'https://connect.garmin.cn/app',
      },
      expectedContext,
    ), ticket)
  })

  it.each([
    ['another loopback origin', 'http://127.0.0.1:43124'],
    ['a path on the bridge origin', `${expectedBridgeOrigin}/garmin-auth/bridge`],
    ['a query on the bridge origin', `${expectedBridgeOrigin}?ticket=secret`],
    ['a fragment on the bridge origin', `${expectedBridgeOrigin}#secret`],
    ['credentials on the bridge URL', 'http://user:pass@127.0.0.1:43123'],
    ['a trailing slash', `${expectedBridgeOrigin}/`],
  ])('rejects %s instead of the exact bridge origin', (_label, serviceUrl) => {
    expectRejected(() => parseGarminEmbeddedAuthMessage(
      {
        serviceTicket: 'ST-forged-loopback-service',
        serviceUrl,
      },
      expectedContext,
    ))
  })

  it.each([
    ['a non-loopback origin', 'https://example.com'],
    ['a bridge path', `${expectedBridgeOrigin}/path`],
    ['a bridge query', `${expectedBridgeOrigin}?secret=1`],
    ['a bridge fragment', `${expectedBridgeOrigin}#secret`],
    ['bridge credentials', 'http://user:pass@127.0.0.1:43123'],
  ])('rejects a parser context containing %s', (_label, expectedBridgeOrigin) => {
    expectRejected(() => parseGarminEmbeddedAuthMessage(
      {
        serviceTicket: 'ST-untrusted-parser-context',
        serviceUrl: expectedBridgeOrigin,
      },
      { ...expectedContext, expectedBridgeOrigin },
    ))
  })

  it('rejects a service ticket containing unsafe characters', () => {
    const ticket = 'ST-secret?redirect=https://attacker.test'

    expectRejected(() => parseGarminEmbeddedAuthMessage(
      { serviceTicket: ticket, serviceUrl: expectedServiceUrl },
      expectedContext,
    ), ticket)
  })

  it('rejects a service ticket longer than 2 KiB', () => {
    const ticket = `ST-${'a'.repeat(2_046)}`

    expectRejected(() => parseGarminEmbeddedAuthMessage(
      { serviceTicket: ticket, serviceUrl: expectedServiceUrl },
      expectedContext,
    ), ticket)
  })

  it('rejects message objects with any additional field', () => {
    const ticket = 'ST-extra-field-secret'

    expectRejected(() => parseGarminEmbeddedAuthMessage(
      {
        serviceTicket: ticket,
        serviceUrl: expectedServiceUrl,
        account: 'runner@example.test',
      },
      expectedContext,
    ), ticket)
  })

  it('rejects an encoded message larger than 4 KiB before parsing it', () => {
    const ticket = 'ST-oversize-secret'
    const payload = JSON.stringify({
      serviceTicket: ticket,
      serviceUrl: expectedServiceUrl,
    }) + ' '.repeat(4_096)

    expectRejected(
      () => parseGarminEmbeddedAuthMessage(payload, expectedContext),
      ticket,
    )
  })

  it('replaces JSON parsing failures with the fixed public error', () => {
    const malformedSecret = 'ST-malformed-secret'

    expectRejected(
      () => parseGarminEmbeddedAuthMessage(
        `{"serviceTicket":"${malformedSecret}"`,
        expectedContext,
      ),
      malformedSecret,
    )
  })
})

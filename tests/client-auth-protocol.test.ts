import {
  parseGarminAuthBeginRpcResult,
  parseGarminAuthCancelRpcResult,
  parseGarminAuthStatusRpcResult,
} from '../src/client/protocol'

const flowId = 'a'.repeat(64)

describe('DSH Garmin authentication client protocol', () => {
  it('accepts a bounded loopback bridge begin result', () => {
    expect(parseGarminAuthBeginRpcResult({
      ok: true,
      value: {
        success: true,
        flowId,
        bridgeUrl: `http://127.0.0.1:43127/garmin-auth/bridge/${flowId}`,
        expiresAt: 1_900_000_000_000,
      },
    })).toEqual({
      success: true,
      flowId,
      bridgeUrl: `http://127.0.0.1:43127/garmin-auth/bridge/${flowId}`,
      expiresAt: 1_900_000_000_000,
    })
  })

  it.each([
    `https://127.0.0.1:43127/garmin-auth/bridge/${flowId}`,
    `http://localhost:43127/garmin-auth/bridge/${flowId}`,
    `http://127.0.0.1:43127/garmin-auth/bridge/${'b'.repeat(64)}`,
    `http://127.0.0.1:43127/garmin-auth/bridge/${flowId}?ticket=ST-secret`,
    `http://127.0.0.1:43127/other/${flowId}`,
  ])('rejects an unsafe or mismatched bridge URL: %s', (bridgeUrl) => {
    expect(parseGarminAuthBeginRpcResult({
      ok: true,
      value: {
        success: true,
        flowId,
        bridgeUrl,
        expiresAt: 1_900_000_000_000,
      },
    })).toEqual({ success: false, code: 'unavailable' })
  })

  it('folds transport and untrusted server errors into a fixed client code', () => {
    const secret = 'ST-private-ticket runner@example.test /private/session.json'

    expect(parseGarminAuthBeginRpcResult({
      ok: false,
      error: { code: 'internal', message: secret, details: {} },
    })).toEqual({ success: false, code: 'unavailable' })
    expect(JSON.stringify(parseGarminAuthBeginRpcResult({
      ok: false,
      error: { message: secret },
    }))).not.toContain(secret)
  })

  it.each([
    'in_progress',
    'succeeded',
    'failed',
    'cancelled',
    'expired',
  ] as const)('accepts the closed public status %s', (status) => {
    expect(parseGarminAuthStatusRpcResult({
      ok: true,
      value: { success: true, status },
    })).toEqual({ success: true, status })
  })

  it('rejects status payloads carrying extra fields or private data', () => {
    expect(parseGarminAuthStatusRpcResult({
      ok: true,
      value: {
        success: true,
        status: 'succeeded',
        ticket: 'ST-secret',
      },
    })).toEqual({ success: false, code: 'unavailable' })
  })

  it('accepts only an exact successful cancellation envelope', () => {
    expect(parseGarminAuthCancelRpcResult({
      ok: true,
      value: { success: true },
    })).toEqual({ success: true })
    expect(parseGarminAuthCancelRpcResult({
      ok: true,
      value: { success: true, ticket: 'ST-secret' },
    })).toEqual({ success: false, code: 'unavailable' })
  })
})

import http from 'node:http'
import { EmbeddedAuthFlowManager } from '../src/embedded-auth-flow'
import {
  EmbeddedAuthServer,
  GARMIN_EMBEDDED_AUTH_SERVER_REJECTED,
  type EmbeddedAuthServerAdapter,
} from '../src/embedded-auth-server'

const FLOW_ID = 'ab'.repeat(32)
const CSRF = 'c'.repeat(43)
const SSO_ORIGIN = 'https://sso.garmin.cn'
const SERVICE_URL = `${SSO_ORIGIN}/sso/embed`
const FRAME_URL = frameUrlFor('http://127.0.0.1:9999')

function frameUrlFor(bridgeOrigin: string): string {
  return `${SSO_ORIGIN}/sso/signin?id=gauth-widget&embedWidget=true&gauthHost=${encodeURIComponent(`${SSO_ORIGIN}/sso`)}&service=${encodeURIComponent(SERVICE_URL)}&source=${encodeURIComponent(bridgeOrigin)}&consumeServiceTicket=false`
}

interface RequestResult {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

type TestAdapter = jest.Mocked<EmbeddedAuthServerAdapter> & {
  setBridgeOrigin(origin: string): void
}

function createAdapter(): TestAdapter {
  let bridgeOrigin = 'http://127.0.0.1:9999'
  return {
    bridgeBootstrap: jest.fn((_flowId: string) => ({
      csrf: CSRF,
      frameUrl: frameUrlFor(bridgeOrigin),
      ssoOrigin: SSO_ORIGIN,
      serviceUrl: SERVICE_URL,
    })),
    bridgeStatus: jest.fn((_flowId: string, _csrf: string) => ({
      state: 'awaiting_garmin' as const,
    })),
    submitTicket: jest.fn(),
    confirm: jest.fn(),
    cancel: jest.fn(),
    setBridgeOrigin(origin: string) {
      bridgeOrigin = origin
    },
  }
}

function request(
  url: string,
  options: {
    method?: string
    headers?: http.OutgoingHttpHeaders
    body?: string
  } = {},
): Promise<RequestResult> {
  const target = new URL(url)
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: options.method ?? 'GET',
      headers: options.headers,
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(Buffer.from(chunk)))
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

function bridgeHeaders(origin: string): http.OutgoingHttpHeaders {
  return {
    Origin: origin,
    'Content-Type': 'application/json',
    'X-Garmin-Auth-CSRF': CSRF,
  }
}

describe('EmbeddedAuthServer', () => {
  const servers: EmbeddedAuthServer[] = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => server.close()))
  })

  it('binds an ephemeral IPv4 loopback origin and builds opaque bridge URLs', async () => {
    const server = new EmbeddedAuthServer(createAdapter())
    servers.push(server)

    const origin = await server.start()

    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(await server.start()).toBe(origin)
    expect(server.bridgeUrl(FLOW_ID)).toBe(
      `${origin}/garmin-auth/bridge/${FLOW_ID}`,
    )
    expect(() => server.bridgeUrl('not-a-256-bit-hex-id'))
      .toThrow(GARMIN_EMBEDDED_AUTH_SERVER_REJECTED)
  })

  it('accepts a class-based flow-manager adapter', async () => {
    class Adapter implements EmbeddedAuthServerAdapter {
      bridgeBootstrap(_flowId: string) {
        return {
          csrf: CSRF,
          frameUrl: FRAME_URL,
          ssoOrigin: SSO_ORIGIN,
          serviceUrl: SERVICE_URL,
        }
      }

      bridgeStatus(_flowId: string, _csrf: string) {
        return { state: 'awaiting_garmin' as const }
      }

      submitTicket(_flowId: string, _csrf: string, _ticket: string) {}
      confirm(_flowId: string, _csrf: string, _accepted: boolean) {}
      cancel(_flowId: string, _csrf: string) {}
    }

    const server = new EmbeddedAuthServer(new Adapter())
    servers.push(server)

    await expect(server.start()).resolves.toMatch(/^http:\/\/127\.0\.0\.1:/)
  })

  it('integrates directly with the real flow manager contract', async () => {
    const manager = new EmbeddedAuthFlowManager({ authenticate: jest.fn() })
    const server = new EmbeddedAuthServer(manager)
    servers.push(server)
    const origin = await server.start()
    const started = manager.start({
      region: 'cn',
      username: 'runner@example.com',
      sessionTokenFile: '/private/account/session.json',
      bridgeOrigin: origin,
    })

    expect(started.flowId).toMatch(/^[a-f0-9]{64}$/)
    const response = await request(server.bridgeUrl(started.flowId))

    expect(response.status).toBe(200)
    expect(response.body).toContain('https://sso.garmin.cn/sso/signin')
  })

  it('serves a no-store bridge that embeds only Garmin GAuth and never forwards secrets', async () => {
    const adapter = createAdapter()
    const server = new EmbeddedAuthServer(adapter)
    servers.push(server)
    const origin = await server.start()
    adapter.setBridgeOrigin(origin)

    const response = await request(server.bridgeUrl(FLOW_ID))

    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store, max-age=0')
    expect(response.headers['referrer-policy']).toBe('no-referrer')
    expect(response.headers['x-content-type-options']).toBe('nosniff')
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(response.headers['content-security-policy']).toContain("default-src 'none'")
    expect(response.headers['content-security-policy']).toContain(`frame-src ${SSO_ORIGIN}`)
    expect(response.headers['content-security-policy']).toContain("connect-src 'self'")
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(response.body).toContain('id="garmin-auth-frame"')
    expect(response.body).toContain('https://sso.garmin.cn/sso/signin')
    expect(response.body).toContain("event.origin !== ssoOrigin")
    expect(response.body).toContain("event.source !== frame.contentWindow")
    expect(response.body).toContain('textContent')
    expect(response.body).not.toContain('allow-top-navigation-by-user-activation')
    expect(response.body).not.toMatch(/parent\.postMessage|localStorage|sessionStorage|document\.cookie/)
    expect(response.body).not.toContain('ST-ticket-secret')
    expect(adapter.bridgeBootstrap).toHaveBeenCalledWith(FLOW_ID)
  })

  it.each([
    ['a mismatched source', (url: URL) => {
      url.searchParams.set('source', 'http://127.0.0.1:1')
    }],
    ['an extra parameter', (url: URL) => {
      url.searchParams.set('unexpected', 'value')
    }],
    ['a duplicate parameter', (url: URL) => {
      url.searchParams.append('service', SERVICE_URL)
    }],
  ])('rejects a GAuth frame URL with %s', async (_label, mutate) => {
    const adapter = createAdapter()
    const server = new EmbeddedAuthServer(adapter)
    servers.push(server)
    const origin = await server.start()
    const invalidFrameUrl = new URL(frameUrlFor(origin))
    mutate(invalidFrameUrl)
    adapter.bridgeBootstrap.mockReturnValue({
      csrf: CSRF,
      frameUrl: invalidFrameUrl.toString(),
      ssoOrigin: SSO_ORIGIN,
      serviceUrl: SERVICE_URL,
    })

    const response = await request(server.bridgeUrl(FLOW_ID))

    expect(response.status).toBe(400)
    expect(response.body).toBe('{"ok":false,"error":"request_rejected"}')
    expect(response.body).not.toContain('unexpected')
  })

  it('routes a validated one-shot ticket, safe status, confirmation, and cancellation', async () => {
    const adapter = createAdapter()
    adapter.bridgeStatus.mockReturnValue({
      state: 'waiting_confirmation',
      identity: { displayName: 'Runner <One>', userName: 'runner@example.com' },
    })
    const server = new EmbeddedAuthServer(adapter)
    servers.push(server)
    const origin = await server.start()
    adapter.setBridgeOrigin(origin)
    const bridgeUrl = server.bridgeUrl(FLOW_ID)
    const headers = bridgeHeaders(origin)

    const ticket = await request(`${bridgeUrl}/ticket`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        serviceTicket: 'ST-valid_ticket~1',
        serviceUrl: SERVICE_URL,
      }),
    })
    const status = await request(`${bridgeUrl}/status`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    const confirm = await request(`${bridgeUrl}/confirm`, {
      method: 'POST',
      headers,
      body: '{"accepted":true}',
    })
    const cancel = await request(`${bridgeUrl}/cancel`, {
      method: 'POST',
      headers,
      body: '{}',
    })

    expect(ticket.status).toBe(202)
    expect(JSON.parse(ticket.body)).toEqual({ ok: true })
    expect(adapter.submitTicket).toHaveBeenCalledWith(
      FLOW_ID,
      CSRF,
      'ST-valid_ticket~1',
    )
    expect(status.status).toBe(200)
    expect(JSON.parse(status.body)).toEqual({
      ok: true,
      status: {
        state: 'waiting_confirmation',
        identity: {
          displayName: 'Runner <One>',
          userName: 'runner@example.com',
        },
      },
    })
    expect(adapter.bridgeStatus).toHaveBeenCalledWith(FLOW_ID, CSRF)
    expect(confirm.status).toBe(200)
    expect(adapter.confirm).toHaveBeenCalledWith(FLOW_ID, CSRF, true)
    expect(cancel.status).toBe(200)
    expect(adapter.cancel).toHaveBeenCalledWith(FLOW_ID, CSRF)
  })

  it.each([
    ['wrong origin', (origin: string) => ({
      urlSuffix: '/status',
      headers: { ...bridgeHeaders(origin), Origin: 'http://127.0.0.1:1' },
      body: '{}',
    })],
    ['missing csrf', (origin: string) => ({
      urlSuffix: '/status',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: '{}',
    })],
    ['wrong content type', (origin: string) => ({
      urlSuffix: '/status',
      headers: { ...bridgeHeaders(origin), 'Content-Type': 'text/plain' },
      body: '{}',
    })],
    ['oversized body', (origin: string) => ({
      urlSuffix: '/status',
      headers: bridgeHeaders(origin),
      body: JSON.stringify({ padding: 'x'.repeat(4_200) }),
    })],
    ['invalid ticket service', (origin: string) => ({
      urlSuffix: '/ticket',
      headers: bridgeHeaders(origin),
      body: JSON.stringify({
        serviceTicket: 'ST-do-not-echo-me',
        serviceUrl: 'https://evil.example/sso/embed',
      }),
    })],
    ['extra ticket property', (origin: string) => ({
      urlSuffix: '/ticket',
      headers: bridgeHeaders(origin),
      body: JSON.stringify({
        serviceTicket: 'ST-do-not-echo-me',
        serviceUrl: SERVICE_URL,
        extra: true,
      }),
    })],
  ])('rejects %s with one fixed response', async (_label, buildRequest) => {
    const adapter = createAdapter()
    const server = new EmbeddedAuthServer(adapter)
    servers.push(server)
    const origin = await server.start()
    adapter.setBridgeOrigin(origin)
    const attempt = buildRequest(origin)

    const response = await request(
      `${server.bridgeUrl(FLOW_ID)}${attempt.urlSuffix}`,
      {
        method: 'POST',
        headers: attempt.headers,
        body: attempt.body,
      },
    )

    expect([400, 403, 413, 415]).toContain(response.status)
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(response.headers['cache-control']).toBe('no-store, max-age=0')
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
    expect(response.body).toBe('{"ok":false,"error":"request_rejected"}')
    expect(response.body).not.toMatch(/evil|echo|ticket/i)
    expect(adapter.bridgeStatus).not.toHaveBeenCalled()
    expect(adapter.submitTicket).not.toHaveBeenCalled()
  })

  it('collapses manager replay failures without echoing adapter details', async () => {
    const adapter = createAdapter()
    adapter.submitTicket.mockImplementation(() => {
      throw new Error('replayed ST-do-not-echo account@example.com')
    })
    const server = new EmbeddedAuthServer(adapter)
    servers.push(server)
    const origin = await server.start()
    adapter.setBridgeOrigin(origin)

    const response = await request(`${server.bridgeUrl(FLOW_ID)}/ticket`, {
      method: 'POST',
      headers: bridgeHeaders(origin),
      body: JSON.stringify({
        serviceTicket: 'ST-valid',
        serviceUrl: SERVICE_URL,
      }),
    })

    expect(response.status).toBe(400)
    expect(response.body).toBe('{"ok":false,"error":"request_rejected"}')
    expect(response.body).not.toMatch(/replay|echo|example|ST-/i)
    expect(adapter.submitTicket).toHaveBeenCalledTimes(1)
  })

  it('rejects forged Host, traversal, queries, and unsupported methods without adapter access', async () => {
    const adapter = createAdapter()
    const server = new EmbeddedAuthServer(adapter)
    servers.push(server)
    const origin = await server.start()
    const bridgeUrl = server.bridgeUrl(FLOW_ID)

    const forgedHost = await request(`${bridgeUrl}/status`, {
      method: 'POST',
      headers: {
        ...bridgeHeaders(origin),
        Host: 'localhost:9999',
      },
      body: '{}',
    })
    const traversal = await request(
      `${origin}/garmin-auth/bridge/${FLOW_ID}/%2e%2e/status`,
    )
    const query = await request(`${bridgeUrl}?ticket=ST-secret`)
    const method = await request(`${bridgeUrl}/ticket`, {
      method: 'PUT',
      headers: bridgeHeaders(origin),
      body: JSON.stringify({
        serviceTicket: 'ST-secret',
        serviceUrl: SERVICE_URL,
      }),
    })

    expect(forgedHost.status).toBe(403)
    expect(traversal.status).toBe(404)
    expect(query.status).toBe(404)
    expect(method.status).toBe(405)
    for (const response of [forgedHost, traversal, query, method]) {
      expect(response.body).toBe('{"ok":false,"error":"request_rejected"}')
      expect(response.body).not.toContain('ST-secret')
    }
    expect(adapter.bridgeBootstrap).not.toHaveBeenCalled()
    expect(adapter.submitTicket).not.toHaveBeenCalled()
  })

  it('stops accepting URLs after close', async () => {
    const server = new EmbeddedAuthServer(createAdapter())
    const origin = await server.start()
    expect(origin).toContain('127.0.0.1')

    await server.close()

    expect(() => server.bridgeUrl(FLOW_ID))
      .toThrow(GARMIN_EMBEDDED_AUTH_SERVER_REJECTED)
  })
})

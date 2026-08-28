import http from 'node:http'
import {
  createEmbeddedAuthController,
  type EmbeddedAuthRuntimeOptions,
} from '../src/embedded-auth-runtime'

interface RequestResult {
  status: number
  body: string
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
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
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

async function waitForBridgeState(
  bridgeUrl: string,
  csrf: string,
  expected: string,
): Promise<void> {
  const origin = new URL(bridgeUrl).origin
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await request(`${bridgeUrl}/status`, {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        'X-Garmin-Auth-CSRF': csrf,
      },
      body: '{}',
    })
    const state = JSON.parse(response.body).status?.state
    if (state === expected) return
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  throw new Error(`bridge did not reach ${expected}`)
}

describe('embedded authentication runtime', () => {
  it('builds the shared loopback controller and commits through replaceSession', async () => {
    const httpPort: EmbeddedAuthRuntimeOptions['http'] = {
      request: jest.fn()
        .mockResolvedValueOnce({
          status: 200,
          contentType: 'application/json',
          body: {
            access_token: 'di-access-secret',
            refresh_token: 'di-refresh-secret',
            expires_in: 3_600,
            refresh_token_expires_in: 86_400,
          },
        })
        .mockResolvedValueOnce({
          status: 200,
          contentType: 'application/json',
          body: {
            displayName: 'Runtime Runner',
            profileId: 123456789,
          },
        }),
    }
    const writeSession = jest.fn().mockResolvedValue(undefined)
    const replaceSession = jest.fn(async (commit: () => Promise<void>) => {
      expect(writeSession).not.toHaveBeenCalled()
      await commit()
    })
    const prepareDestination = jest.fn().mockResolvedValue(undefined)
    const controller = createEmbeddedAuthController({
      username: 'runner@example.test',
      region: 'cn',
      sessionTokenFile: '/private/account/session.json',
    }, {
      http: httpPort,
      writeSession,
      replaceSession,
      prepareDestination,
    })

    try {
      const begun = await controller.begin(undefined, 'cn')
      expect(prepareDestination).toHaveBeenCalledWith(
        '/private/account/session.json',
      )
      expect(begun).toEqual(expect.objectContaining({ success: true }))
      if (!begun.success) throw new Error('expected authentication flow')

      const bridge = await request(begun.bridgeUrl)
      const csrf = /"csrf":"([A-Za-z0-9_-]+)"/.exec(bridge.body)?.[1]
      expect(bridge.status).toBe(200)
      expect(csrf).toBeDefined()
      if (!csrf) throw new Error('expected bridge csrf')

      const origin = new URL(begun.bridgeUrl).origin
      const headers = {
        Origin: origin,
        'Content-Type': 'application/json',
        'X-Garmin-Auth-CSRF': csrf,
      }
      await expect(request(`${begun.bridgeUrl}/ticket`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          serviceTicket: 'ST-runtime-ticket',
          serviceUrl: 'https://sso.garmin.cn/sso/embed',
        }),
      })).resolves.toEqual(expect.objectContaining({ status: 202 }))

      await waitForBridgeState(begun.bridgeUrl, csrf, 'waiting_confirmation')
      await expect(request(`${begun.bridgeUrl}/confirm`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ accepted: true }),
      })).resolves.toEqual(expect.objectContaining({ status: 200 }))
      await waitForBridgeState(begun.bridgeUrl, csrf, 'succeeded')

      expect(replaceSession).toHaveBeenCalledTimes(1)
      expect(writeSession).toHaveBeenCalledWith(
        '/private/account/session.json',
        expect.objectContaining({ kind: 'di-oauth' }),
      )
      expect(httpPort.request).toHaveBeenCalledTimes(2)
    } finally {
      await controller.close()
    }
  })

  it('keeps the bridge alive while close drains an irrevocable session write', async () => {
    const httpPort: EmbeddedAuthRuntimeOptions['http'] = {
      request: jest.fn()
        .mockResolvedValueOnce({
          status: 200,
          contentType: 'application/json',
          body: {
            access_token: 'di-access-secret',
            refresh_token: 'di-refresh-secret',
            expires_in: 3_600,
            refresh_token_expires_in: 86_400,
          },
        })
        .mockResolvedValueOnce({
          status: 200,
          contentType: 'application/json',
          body: {
            displayName: 'Runtime Runner',
            profileId: 123456789,
          },
        }),
    }
    const saveGate = deferred()
    const writeSession = jest.fn(async () => {
      await saveGate.promise
    })
    const controller = createEmbeddedAuthController({
      username: 'runner@example.test',
      region: 'cn',
      sessionTokenFile: '/private/account/session.json',
    }, {
      http: httpPort,
      writeSession,
      prepareDestination: jest.fn().mockResolvedValue(undefined),
    })
    let closing: Promise<void> | undefined

    try {
      const begun = await controller.begin(undefined, 'cn')
      if (!begun.success) throw new Error('expected authentication flow')
      const bridge = await request(begun.bridgeUrl)
      const csrf = /"csrf":"([A-Za-z0-9_-]+)"/.exec(bridge.body)?.[1]
      if (!csrf) throw new Error('expected bridge csrf')
      const origin = new URL(begun.bridgeUrl).origin
      const headers = {
        Origin: origin,
        'Content-Type': 'application/json',
        'X-Garmin-Auth-CSRF': csrf,
      }

      await request(`${begun.bridgeUrl}/ticket`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          serviceTicket: 'ST-runtime-drain',
          serviceUrl: 'https://sso.garmin.cn/sso/embed',
        }),
      })
      await waitForBridgeState(begun.bridgeUrl, csrf, 'waiting_confirmation')
      await request(`${begun.bridgeUrl}/confirm`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ accepted: true }),
      })
      await waitForBridgeState(begun.bridgeUrl, csrf, 'saving')

      closing = controller.close()
      await new Promise<void>(resolve => setImmediate(resolve))

      expect(writeSession).toHaveBeenCalledTimes(1)
      await expect(request(`${begun.bridgeUrl}/status`, {
        method: 'POST',
        headers,
        body: '{}',
      })).resolves.toEqual(expect.objectContaining({ status: 200 }))

      saveGate.resolve()
      await expect(closing).resolves.toBeUndefined()
    } finally {
      saveGate.resolve()
      await (closing ?? controller.close())
    }
  })
})

import { UrlElicitationRequiredError } from '@modelcontextprotocol/sdk/types.js'
import type { GarminRegion } from '../src/config'
import {
  McpGarminAuthCoordinator,
  type McpAuthBroker,
  type McpAuthProtocol,
} from '../src/mcp-auth'
import {
  GarminAuthenticationRequiredError,
  PublicToolError,
} from '../src/utils/errors'

describe('MCP Garmin browser authentication coordinator', () => {
  it('starts one loopback flow and returns a URL elicitation without opening a browser', async () => {
    const fixture = coordinatorFixture()

    const error = await fixture.coordinator.requireAuthentication(
      new GarminAuthenticationRequiredError('missing'),
    ).catch(value => value)

    expect(error).toBeInstanceOf(UrlElicitationRequiredError)
    expect((error as UrlElicitationRequiredError).elicitations).toEqual([{
      mode: 'url',
      message: expect.stringContaining('Garmin'),
      url: fixture.url,
      elicitationId: 'auth-id-1',
    }])
    expect(fixture.begin).toHaveBeenCalledWith('cn', undefined)
    expect(fixture.openBrowser).not.toHaveBeenCalled()

    await fixture.coordinator.close()
  })

  it('shares one flow and elicitation ID across concurrent missing-auth queries', async () => {
    const fixture = coordinatorFixture()
    const missing = new GarminAuthenticationRequiredError('missing')

    const errors = await Promise.all([
      fixture.coordinator.requireAuthentication(missing).catch(value => value),
      fixture.coordinator.requireAuthentication(missing).catch(value => value),
      fixture.coordinator.requireAuthentication(missing).catch(value => value),
    ])

    expect(fixture.begin).toHaveBeenCalledTimes(1)
    expect(errors.every(error => error instanceof UrlElicitationRequiredError)).toBe(true)
    expect(errors.map(error => (
      error as UrlElicitationRequiredError
    ).elicitations[0]?.elicitationId)).toEqual([
      'auth-id-1',
      'auth-id-1',
      'auth-id-1',
    ])

    await fixture.coordinator.close()
  })

  it('notifies the client after the session commit and keeps a short browser grace period', async () => {
    const fixture = coordinatorFixture()
    await fixture.coordinator.requireAuthentication(
      new GarminAuthenticationRequiredError('expired'),
    ).catch(() => undefined)

    fixture.finish('succeeded')
    await flushPromises()

    expect(fixture.notify).toHaveBeenCalledTimes(1)
    expect(fixture.sleep).toHaveBeenCalledWith(2_000)
    expect(fixture.closeBroker).toHaveBeenCalledTimes(1)
  })

  it.each(['failed', 'cancelled', 'expired'] as const)(
    'notifies and closes when the local flow reaches %s',
    async (terminal) => {
      const fixture = coordinatorFixture()
      await fixture.coordinator.requireAuthentication(
        new GarminAuthenticationRequiredError('rejected'),
      ).catch(() => undefined)

      fixture.finish(terminal)
      await flushPromises()

      expect(fixture.notify).toHaveBeenCalledTimes(1)
      expect(fixture.sleep).not.toHaveBeenCalled()
      expect(fixture.closeBroker).toHaveBeenCalledTimes(1)
    },
  )

  it('does not start a loopback listener for clients without URL elicitation', async () => {
    const fixture = coordinatorFixture({ urlElicitation: false })

    const operation = fixture.coordinator.requireAuthentication(
      new GarminAuthenticationRequiredError('missing'),
    )

    await expect(operation).rejects.toBeInstanceOf(PublicToolError)
    await expect(operation).rejects.toThrow(
      'garmin-connect-auth serve --account default --region cn --open',
    )
    expect(fixture.begin).not.toHaveBeenCalled()
  })

  it('passes unrelated errors through unchanged', async () => {
    const fixture = coordinatorFixture()
    const original = new PublicToolError('Account region does not match')

    await expect(fixture.coordinator.requireAuthentication(original))
      .rejects.toBe(original)
    expect(fixture.begin).not.toHaveBeenCalled()
  })
})

function coordinatorFixture(options: { urlElicitation?: boolean } = {}) {
  type Terminal = Awaited<ReturnType<McpAuthBroker['wait']>>
  let finish!: (state: Terminal) => void
  const wait = jest.fn(() => new Promise<Terminal>((resolve) => {
    finish = resolve
  }))
  const begin = jest.fn().mockResolvedValue({
    url: 'http://127.0.0.1:54321/garmin-auth/bridge/' + 'a'.repeat(64),
    expiresAt: Date.now() + 60_000,
  })
  const closeBroker = jest.fn(async () => {
    finish?.('cancelled')
  })
  const openBrowser = jest.fn()
  const broker: McpAuthBroker = { begin, wait, close: closeBroker }
  const notify = jest.fn().mockResolvedValue(undefined)
  const protocol: McpAuthProtocol = {
    getClientCapabilities: jest.fn(() => options.urlElicitation === false
      ? { elicitation: { form: {} } }
      : { elicitation: { url: {} } }),
    createElicitationCompletionNotifier: jest.fn(() => notify),
  }
  const sleep = jest.fn().mockResolvedValue(undefined)
  const url = 'http://127.0.0.1:54321/garmin-auth/bridge/' + 'a'.repeat(64)
  const coordinator = new McpGarminAuthCoordinator({
    protocol,
    account: 'default',
    username: 'runner@example.test',
    region: 'cn' as GarminRegion,
    sessionTokenFile: '/private/default.session.json',
    createBroker: () => broker,
    createElicitationId: () => 'auth-id-1',
    sleep,
  })

  return {
    coordinator,
    begin,
    wait,
    finish: (state: Terminal) => finish(state),
    closeBroker,
    openBrowser,
    notify,
    sleep,
    url,
  }
}

async function flushPromises(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
  await new Promise<void>(resolve => setImmediate(resolve))
}

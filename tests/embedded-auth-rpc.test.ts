import type { Context } from '@deepseek-ai/cordis'
import {
  registerEmbeddedAuthRpc,
  resolveEmbeddedAuthConfig,
  type EmbeddedAuthRpcController,
} from '../src/embedded-auth-rpc'

function fixture() {
  const controller: jest.Mocked<EmbeddedAuthRpcController> = {
    begin: jest.fn().mockResolvedValue({
      success: true,
      flowId: 'a'.repeat(64),
      bridgeUrl: `http://127.0.0.1:43127/garmin-auth/bridge/${'a'.repeat(64)}`,
      expiresAt: 1_900_000_000_000,
    }),
    status: jest.fn().mockReturnValue({ success: true, status: 'in_progress' }),
    cancel: jest.fn().mockReturnValue({ success: true }),
    close: jest.fn().mockResolvedValue(undefined),
  }
  const disposeRpc = jest.fn().mockResolvedValue(undefined)
  const handle = jest.fn().mockReturnValue(disposeRpc)
  let disposeEffect: (() => Promise<void>) | undefined
  const child = {
    connection: { rpc: { handle } },
    effect: jest.fn((execute: () => () => Promise<void>) => {
      disposeEffect = execute()
      return jest.fn()
    }),
  }
  const ctx = {
    inject: jest.fn((_services: string[], callback: (nested: typeof child) => void) => {
      callback(child)
      return {}
    }),
  }
  return {
    controller,
    factory: jest.fn(() => controller),
    disposeRpc,
    handle,
    child,
    ctx,
    disposeEffect: () => disposeEffect,
  }
}

describe('DSH embedded Garmin authentication RPC', () => {
  it('uses one default account session path for the Host and Garmin client', () => {
    const config = resolveEmbeddedAuthConfig({
      username: 'runner@example.test',
      region: 'cn',
      sessionTokenFile: '',
    } as never, {
      GARMIN_ACCOUNT: 'personal',
      XDG_CONFIG_HOME: '/private/config',
    })

    expect(config.sessionTokenFile).toBe(
      '/private/config/dsh-plugin-garmin-connect/accounts/personal.session.json',
    )
  })

  it('fails configuration closed for an invalid account alias', () => {
    const config = resolveEmbeddedAuthConfig({
      username: 'runner@example.test',
      region: 'global',
      sessionTokenFile: '',
    } as never, {
      GARMIN_ACCOUNT: '../escape',
      XDG_CONFIG_HOME: '/private/config',
    })

    expect(config.sessionTokenFile).toBe('')
  })

  it('waits for Connection and registers a loopback-only channel', () => {
    const subject = fixture()

    registerEmbeddedAuthRpc(
      subject.ctx as unknown as Context,
      {} as never,
      subject.factory,
    )

    expect(subject.ctx.inject).toHaveBeenCalledWith(
      ['connection'],
      expect.any(Function),
    )
    expect(subject.handle).toHaveBeenCalledWith(
      '/garmin-auth',
      expect.any(Function),
      { authority: 'loopback' },
    )
    expect(subject.child.effect).toHaveBeenCalledWith(
      expect.any(Function),
      'garmin-connect: embedded auth rpc',
    )
  })

  it('dispatches only the closed account/begin/status/cancel endpoints', async () => {
    const subject = fixture()
    registerEmbeddedAuthRpc(
      subject.ctx as unknown as Context,
      {} as never,
      subject.factory,
    )
    const handler = subject.handle.mock.calls[0][1]
    const signal = new AbortController().signal

    await expect(handler('begin', { region: 'cn' }, signal)).resolves.toEqual({
      ok: true,
      value: expect.objectContaining({ success: true, flowId: 'a'.repeat(64) }),
    })
    await expect(handler('status', { flowId: 'a'.repeat(64) }, signal))
      .resolves.toEqual({
        ok: true,
        value: { success: true, status: 'in_progress' },
      })
    await expect(handler('cancel', { flowId: 'a'.repeat(64) }, signal))
      .resolves.toEqual({ ok: true, value: { success: true } })

    expect(subject.controller.begin).toHaveBeenCalledWith(signal, 'cn')
    expect(subject.controller.status).toHaveBeenCalledWith({ flowId: 'a'.repeat(64) })
    expect(subject.controller.cancel).toHaveBeenCalledWith({ flowId: 'a'.repeat(64) })
  })

  it('returns only a bounded authenticated account on the optional account endpoint', async () => {
    const subject = fixture()
    const getAuthenticatedAccount = jest.fn().mockResolvedValue({
      email: 'runner@example.test',
      region: 'cn',
    })
    registerEmbeddedAuthRpc(
      subject.ctx as unknown as Context,
      {} as never,
      {
        createController: subject.factory,
        getAuthenticatedAccount,
      },
    )
    const handler = subject.handle.mock.calls[0][1]
    const signal = new AbortController().signal

    await expect(handler('account', {}, signal)).resolves.toEqual({
      ok: true,
      value: {
        success: true,
        authenticated: true,
        email: 'runner@example.test',
        region: 'cn',
      },
    })
    expect(getAuthenticatedAccount).toHaveBeenCalledTimes(1)

    await expect(handler('account', { extra: true }, signal)).resolves.toEqual({
      ok: true,
      value: { success: false, code: 'unavailable' },
    })
    expect(getAuthenticatedAccount).toHaveBeenCalledTimes(1)
  })

  it('returns no email when the Host has no authenticated account', async () => {
    const subject = fixture()
    registerEmbeddedAuthRpc(
      subject.ctx as unknown as Context,
      {} as never,
      {
        createController: subject.factory,
        getAuthenticatedAccount: jest.fn().mockResolvedValue(undefined),
      },
    )
    const handler = subject.handle.mock.calls[0][1]

    await expect(handler(
      'account',
      {},
      new AbortController().signal,
    )).resolves.toEqual({
      ok: true,
      value: { success: true, authenticated: false },
    })
  })

  it('collapses unsafe account providers without exposing their values', async () => {
    const subject = fixture()
    const secret = 'ST-secret'
    registerEmbeddedAuthRpc(
      subject.ctx as unknown as Context,
      {} as never,
      {
        createController: subject.factory,
        getAuthenticatedAccount: jest.fn().mockResolvedValue({
          email: 'runner@example.test',
          region: 'global',
          token: secret,
        }),
      },
    )
    const handler = subject.handle.mock.calls[0][1]

    const response = await handler(
      'account',
      {},
      new AbortController().signal,
    )

    expect(response).toEqual({
      ok: true,
      value: { success: false, code: 'unavailable' },
    })
    expect(JSON.stringify(response)).not.toContain(secret)
  })

  it('rejects malformed begin and unknown endpoints without reflecting payloads', async () => {
    const subject = fixture()
    registerEmbeddedAuthRpc(
      subject.ctx as unknown as Context,
      {} as never,
      subject.factory,
    )
    const handler = subject.handle.mock.calls[0][1]
    const secret = 'ST-secret runner@example.test /private/session.json'

    const malformedPayloads = [
      { secret },
      {},
      { region: 'eu' },
      { region: 'cn', extra: true },
      ['cn'],
      Object.create({ region: 'cn' }),
    ]
    const malformed = await Promise.all(malformedPayloads.map(payload => (
      handler('begin', payload, new AbortController().signal)
    )))
    const unknown = await handler(secret, { secret }, new AbortController().signal)

    expect(malformed).toEqual(malformedPayloads.map(() => ({
      ok: true,
      value: { success: false, code: 'unavailable' },
    })))
    expect(unknown).toEqual(malformed[0])
    expect(JSON.stringify([malformed, unknown])).not.toContain(secret)
    expect(subject.controller.begin).not.toHaveBeenCalled()
  })

  it('collapses controller failures and request cancellation to a fixed result', async () => {
    const subject = fixture()
    subject.controller.status.mockImplementation(() => {
      throw new Error('ticket=ST-secret account=runner@example.test')
    })
    registerEmbeddedAuthRpc(
      subject.ctx as unknown as Context,
      {} as never,
      subject.factory,
    )
    const handler = subject.handle.mock.calls[0][1]
    const aborted = new AbortController()
    aborted.abort()

    await expect(handler('status', {}, new AbortController().signal)).resolves.toEqual({
      ok: true,
      value: { success: false, code: 'unavailable' },
    })
    await expect(handler('begin', { region: 'cn' }, aborted.signal)).resolves.toEqual({
      ok: true,
      value: { success: false, code: 'unavailable' },
    })
  })

  it('cancels a flow that finishes after its begin request was aborted', async () => {
    const subject = fixture()
    type BeginResult = Awaited<ReturnType<EmbeddedAuthRpcController['begin']>>
    let resolveBegin!: (value: BeginResult) => void
    const pendingBegin = new Promise<BeginResult>((resolve) => {
      resolveBegin = resolve
    })
    subject.controller.begin.mockReturnValue(pendingBegin)
    registerEmbeddedAuthRpc(
      subject.ctx as unknown as Context,
      {} as never,
      subject.factory,
    )
    const handler = subject.handle.mock.calls[0][1]
    const request = new AbortController()
    const result = handler('begin', { region: 'cn' }, request.signal)
    request.abort()
    resolveBegin({
      success: true,
      flowId: 'a'.repeat(64),
      bridgeUrl: `http://127.0.0.1:43127/garmin-auth/bridge/${'a'.repeat(64)}`,
      expiresAt: 1_900_000_000_000,
    })

    await expect(result).resolves.toEqual({
      ok: true,
      value: { success: false, code: 'unavailable' },
    })
    expect(subject.controller.cancel).toHaveBeenCalledWith({
      flowId: 'a'.repeat(64),
    })
  })

  it('unregisters the RPC before closing its private bridge on unload', async () => {
    const subject = fixture()
    registerEmbeddedAuthRpc(
      subject.ctx as unknown as Context,
      {} as never,
      subject.factory,
    )

    await subject.disposeEffect()?.()

    expect(subject.disposeRpc).toHaveBeenCalledTimes(1)
    expect(subject.controller.close).toHaveBeenCalledTimes(1)
    expect(subject.disposeRpc.mock.invocationCallOrder[0])
      .toBeLessThan(subject.controller.close.mock.invocationCallOrder[0])
  })
})

import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import {
  LocalAuthBroker,
  openLoopbackAuthInSystemBrowser,
  type LocalAuthBrokerController,
} from '../src/local-auth-broker'

const FLOW_ID = 'a'.repeat(64)
const BRIDGE_URL = `http://127.0.0.1:43127/garmin-auth/bridge/${FLOW_ID}`

function controllerFixture(
  states: Array<'in_progress' | 'succeeded' | 'failed' | 'cancelled' | 'expired'> = [
    'in_progress',
    'succeeded',
  ],
): jest.Mocked<LocalAuthBrokerController> {
  return {
    begin: jest.fn().mockResolvedValue({
      success: true,
      flowId: FLOW_ID,
      bridgeUrl: BRIDGE_URL,
      expiresAt: 1_900_000_000_000,
    }),
    status: jest.fn().mockImplementation(() => ({
      success: true,
      status: states.shift() ?? 'succeeded',
    })),
    cancel: jest.fn().mockReturnValue({ success: true }),
    close: jest.fn().mockResolvedValue(undefined),
  }
}

describe('local Garmin authentication broker', () => {
  it('opens the system browser, waits for success, keeps a display grace, and closes', async () => {
    const controller = controllerFixture()
    const openBrowser = jest.fn().mockResolvedValue(undefined)
    const sleep = jest.fn().mockResolvedValue(undefined)
    const broker = new LocalAuthBroker({
      controller,
      openBrowser,
      sleep,
      pollIntervalMs: 250,
      successGraceMs: 1_500,
    })

    await expect(broker.authenticateInSystemBrowser('cn')).resolves.toEqual({
      success: true,
      region: 'cn',
    })

    expect(controller.begin).toHaveBeenCalledWith(undefined, 'cn')
    expect(openBrowser).toHaveBeenCalledWith(BRIDGE_URL)
    expect(controller.status).toHaveBeenCalledWith({ flowId: FLOW_ID })
    expect(sleep.mock.calls).toEqual([
      [250, undefined],
      [1_500, undefined],
    ])
    expect(controller.close).toHaveBeenCalledTimes(1)
    expect(controller.cancel).not.toHaveBeenCalled()
  })

  it.each([
    ['failed', 'Garmin browser authentication failed'],
    ['cancelled', 'Garmin browser authentication was cancelled'],
    ['expired', 'Garmin browser authentication timed out'],
  ] as const)('collapses %s to a fixed public error and closes', async (state, message) => {
    const controller = controllerFixture([state])
    const broker = new LocalAuthBroker({
      controller,
      openBrowser: jest.fn().mockResolvedValue(undefined),
      sleep: jest.fn().mockResolvedValue(undefined),
    })

    await expect(broker.authenticateInSystemBrowser('global')).rejects.toThrow(message)
    expect(controller.close).toHaveBeenCalledTimes(1)
  })

  it('cancels and closes when the browser cannot be opened without exposing the URL', async () => {
    const controller = controllerFixture()
    const marker = `${BRIDGE_URL}?token=ST-secret`
    const broker = new LocalAuthBroker({
      controller,
      openBrowser: jest.fn().mockRejectedValue(new Error(marker)),
      sleep: jest.fn().mockResolvedValue(undefined),
    })

    const operation = broker.authenticateInSystemBrowser('cn')
    await expect(operation).rejects.toThrow('The system browser could not be opened')
    await expect(operation).rejects.not.toThrow(marker)
    expect(controller.cancel).toHaveBeenCalledWith({ flowId: FLOW_ID })
    expect(controller.close).toHaveBeenCalledTimes(1)
  })

  it('cancels an active flow when the caller aborts', async () => {
    const controller = controllerFixture(['in_progress'])
    const abort = new AbortController()
    const sleep = jest.fn().mockImplementation(async () => {
      abort.abort()
    })
    const broker = new LocalAuthBroker({
      controller,
      openBrowser: jest.fn().mockResolvedValue(undefined),
      sleep,
    })

    await expect(broker.authenticateInSystemBrowser('cn', abort.signal))
      .rejects.toThrow('Garmin browser authentication was cancelled')
    expect(controller.cancel).toHaveBeenCalledWith({ flowId: FLOW_ID })
    expect(controller.close).toHaveBeenCalledTimes(1)
  })

  it('can start without opening a browser so MCP URL elicitation can own navigation', async () => {
    const controller = controllerFixture(['succeeded'])
    const openBrowser = jest.fn()
    const broker = new LocalAuthBroker({
      controller,
      openBrowser,
      sleep: jest.fn().mockResolvedValue(undefined),
    })

    await expect(broker.begin('global')).resolves.toEqual({
      url: BRIDGE_URL,
      expiresAt: 1_900_000_000_000,
    })
    await expect(broker.wait()).resolves.toBe('succeeded')

    expect(openBrowser).not.toHaveBeenCalled()
    await broker.close()
    expect(controller.close).toHaveBeenCalledTimes(1)
  })

  it('rejects unsafe controller URLs before passing them to a browser', async () => {
    const controller = controllerFixture()
    controller.begin.mockResolvedValue({
      success: true,
      flowId: FLOW_ID,
      bridgeUrl: `https://attacker.example/garmin-auth/bridge/${FLOW_ID}`,
      expiresAt: 1_900_000_000_000,
    })
    const openBrowser = jest.fn()
    const broker = new LocalAuthBroker({ controller, openBrowser })

    await expect(broker.authenticateInSystemBrowser('cn')).rejects.toThrow(
      'Garmin browser authentication is unavailable',
    )
    expect(openBrowser).not.toHaveBeenCalled()
    expect(controller.close).toHaveBeenCalledTimes(1)
  })
})

describe('system browser opener', () => {
  function spawnFixture() {
    const child = new EventEmitter() as ChildProcess
    child.unref = jest.fn()
    const spawn = jest.fn(() => {
      queueMicrotask(() => child.emit('spawn'))
      return child
    })
    return { child, spawn }
  }

  it.each([
    ['darwin', '/usr/bin/open', [BRIDGE_URL]],
    ['linux', 'xdg-open', [BRIDGE_URL]],
    ['win32', 'rundll32.exe', ['url.dll,FileProtocolHandler', BRIDGE_URL]],
  ])('uses a shell-free %s launcher', async (platform, command, args) => {
    const { child, spawn } = spawnFixture()

    await expect(openLoopbackAuthInSystemBrowser(BRIDGE_URL, {
      platform,
      spawn: spawn as never,
    })).resolves.toBeUndefined()

    expect(spawn).toHaveBeenCalledWith(command, args, {
      detached: true,
      shell: false,
      stdio: 'ignore',
    })
    expect(child.unref).toHaveBeenCalledTimes(1)
  })

  it('rejects non-loopback and malformed bridge URLs before spawning', async () => {
    const { spawn } = spawnFixture()

    for (const url of [
      `https://attacker.example/garmin-auth/bridge/${FLOW_ID}`,
      `http://127.0.0.1:43127/other/${FLOW_ID}`,
      `http://127.0.0.1:43127/garmin-auth/bridge/${FLOW_ID}?secret=1`,
    ]) {
      await expect(openLoopbackAuthInSystemBrowser(url, {
        platform: 'darwin',
        spawn: spawn as never,
      })).rejects.toThrow('The system browser could not be opened')
    }
    expect(spawn).not.toHaveBeenCalled()
  })
})

import { EventEmitter } from 'node:events'
import {
  installMcpShutdownHooks,
  type McpShutdownSignal,
} from '../src/mcp-shutdown'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function lifecycleFixture(close: () => Promise<void>, closeTimeoutMs = 100) {
  const input = new EventEmitter() as NodeJS.ReadStream
  input.pause = jest.fn().mockReturnValue(input)
  const signals = new EventEmitter() as NodeJS.Process
  const exit = jest.fn()
  const target = { close: jest.fn(close) }
  const hooks = installMcpShutdownHooks(target, {
    input,
    signals,
    exit,
    closeTimeoutMs,
  })
  return { input, signals, exit, target, hooks }
}

describe('MCP stdio shutdown hooks', () => {
  it.each(['end', 'close'] as const)(
    'drains the server once before exiting on stdin %s',
    async (event) => {
      const gate = deferred()
      const fixture = lifecycleFixture(() => gate.promise)

      fixture.input.emit(event)
      fixture.input.emit(event === 'end' ? 'close' : 'end')
      await Promise.resolve()

      expect(fixture.target.close).toHaveBeenCalledTimes(1)
      expect(fixture.input.pause).toHaveBeenCalledTimes(1)
      expect(fixture.exit).not.toHaveBeenCalled()

      gate.resolve()
      await fixture.hooks.shutdown()
      expect(fixture.exit).toHaveBeenCalledWith(0)
    },
  )

  it.each([
    ['SIGHUP', 129],
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)(
    'preserves the conventional exit code after draining %s',
    async (signal: McpShutdownSignal, exitCode: number) => {
      const fixture = lifecycleFixture(async () => undefined)

      fixture.signals.emit(signal)
      await fixture.hooks.shutdown(exitCode)

      expect(fixture.target.close).toHaveBeenCalledTimes(1)
      expect(fixture.exit).toHaveBeenCalledWith(exitCode)
    },
  )

  it('uses an outer deadline when server cleanup never settles', async () => {
    jest.useFakeTimers()
    const fixture = lifecycleFixture(
      () => new Promise<void>(() => undefined),
      100,
    )

    try {
      fixture.signals.emit('SIGTERM')
      await jest.advanceTimersByTimeAsync(100)

      expect(fixture.target.close).toHaveBeenCalledTimes(1)
      expect(fixture.exit).toHaveBeenCalledWith(143)
    } finally {
      fixture.hooks.dispose()
      jest.useRealTimers()
    }
  })

  it('keeps signals intercepted while an EOF-triggered drain is pending', async () => {
    const gate = deferred()
    const fixture = lifecycleFixture(() => gate.promise)

    fixture.input.emit('end')
    await Promise.resolve()
    fixture.signals.emit('SIGTERM')

    expect(fixture.target.close).toHaveBeenCalledTimes(1)
    expect(fixture.exit).not.toHaveBeenCalled()

    gate.resolve()
    await fixture.hooks.shutdown()
    expect(fixture.exit).toHaveBeenCalledWith(143)
  })

  it('can remove hooks before they are needed', () => {
    const fixture = lifecycleFixture(async () => undefined)

    fixture.hooks.dispose()
    fixture.input.emit('end')
    fixture.signals.emit('SIGINT')

    expect(fixture.target.close).not.toHaveBeenCalled()
    expect(fixture.exit).not.toHaveBeenCalled()
  })
})

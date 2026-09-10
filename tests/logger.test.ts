import { createStderrLogger } from '../src/logger'

describe('standalone logger', () => {
  it('writes all levels only to stderr and redacts bearer credentials', () => {
    const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true)
    const stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true)
    try {
      const logger = createStderrLogger()
      for (const level of ['debug', 'info', 'warn', 'error'] as const) {
        logger[level]('Bearer token-value')
      }
      expect(stderr).toHaveBeenCalledTimes(4)
      expect(stderr.mock.calls.flat().join(' ')).not.toContain('token-value')
      expect(stdout).not.toHaveBeenCalled()
    } finally {
      stderr.mockRestore()
      stdout.mockRestore()
    }
  })
})

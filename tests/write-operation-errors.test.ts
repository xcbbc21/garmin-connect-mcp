import {
  GarminWriteError,
  GarminWriteTransportError,
  WRITE_ERROR_CODES,
  classifyWriteFailure,
  isGarminWriteError,
  isWriteTransportError,
  notAppliedWriteError,
  uncertainWriteError,
} from '../src/write-operations/errors'
import { PublicToolError } from '../src/utils/errors'

describe('write error contract', () => {
  it('keeps the transport error recognisable as a public tool error', () => {
    const error = new GarminWriteTransportError(
      'unknown',
      WRITE_ERROR_CODES.WRITE_OUTCOME_UNKNOWN,
      'outcome is unknown',
    )
    expect(error).toBeInstanceOf(PublicToolError)
    expect(isWriteTransportError(error)).toBe(true)
    expect(error.outcome).toBe('unknown')
  })

  it('classifies a typed transport failure by its declared outcome', () => {
    expect(classifyWriteFailure(new GarminWriteTransportError(
      'unknown', WRITE_ERROR_CODES.WRITE_OUTCOME_UNKNOWN, 'x',
    ))).toEqual({ outcome: 'unknown', code: WRITE_ERROR_CODES.WRITE_OUTCOME_UNKNOWN })
  })

  it('classifies a typed write error by its declared outcome', () => {
    expect(classifyWriteFailure(notAppliedWriteError(WRITE_ERROR_CODES.WRITE_NOT_APPLIED, 'x')))
      .toEqual({ outcome: 'not_applied', code: WRITE_ERROR_CODES.WRITE_NOT_APPLIED })
    expect(isGarminWriteError(uncertainWriteError('x'))).toBe(true)
  })

  it('falls back to unknown for anything unrecognised', () => {
    // An unclassified failure may still have reached Garmin, so it is never
    // downgraded to a definite non-application.
    for (const error of [new Error('boom'), 'boom', undefined, null, { code: 'X' }]) {
      expect(classifyWriteFailure(error)).toEqual({
        outcome: 'unknown',
        code: WRITE_ERROR_CODES.WRITE_OUTCOME_UNKNOWN,
      })
    }
  })

  it('builds an unknown error whose message forbids blind retry', () => {
    const error = uncertainWriteError('calendar scheduling timed out')
    expect(error.outcome).toBe('unknown')
    expect(error.message).toContain('outcome is unknown')
    expect(error.code).toBe(WRITE_ERROR_CODES.WRITE_OUTCOME_UNKNOWN)
  })

  it('preserves a GarminWriteError code and outcome', () => {
    const error = new GarminWriteError(WRITE_ERROR_CODES.STATE_CORRUPT, 'not_applied', 'bad journal')
    expect(classifyWriteFailure(error)).toEqual({
      outcome: 'not_applied',
      code: WRITE_ERROR_CODES.STATE_CORRUPT,
    })
    expect(error.name).toBe('GarminWriteError')
  })
})

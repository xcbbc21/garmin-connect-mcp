import {
  accountKey,
  assertIdempotencyKey,
  canonicalJson,
  createBusinessKey,
  idempotencyKeyHash,
  requestHash,
  scheduleBusinessKey,
  unscheduleBusinessKey,
  workoutDefinitionFingerprint,
} from '../src/write-operations/identity'
import { GarminWriteError } from '../src/write-operations/errors'

describe('canonicalJson', () => {
  it('sorts object keys and preserves array order deterministically', () => {
    expect(canonicalJson({ b: 1, a: [2, 1] })).toBe(canonicalJson({ a: [2, 1], b: 1 }))
    expect(canonicalJson({ a: [2, 1] })).not.toBe(canonicalJson({ a: [1, 2] }))
  })

  it('drops undefined object values like JSON.stringify', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }))
  })

  it('rejects non-finite numbers instead of coercing them', () => {
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(RangeError)
  })

  it('rejects circular structures', () => {
    const value: Record<string, unknown> = {}
    value.self = value
    expect(() => canonicalJson(value)).toThrow(RangeError)
  })

  it('produces a stable request hash', () => {
    expect(requestHash({ workoutId: '42', date: '2026-09-15' }))
      .toBe(requestHash({ date: '2026-09-15', workoutId: '42' }))
  })
})

describe('accountKey', () => {
  it('shares one scope across case, whitespace and unicode normalization', () => {
    expect(accountKey(' Runner@Example.test ', 'cn'))
      .toBe(accountKey('runner@example.test', 'cn'))
    expect(accountKey('ru\u006Ener@example.test', 'cn'))
      .toBe(accountKey('runner@example.test', 'cn'))
  })

  it('isolates regions and distinct usernames', () => {
    expect(accountKey('runner@example.test', 'cn'))
      .not.toBe(accountKey('runner@example.test', 'global'))
    expect(accountKey('a@example.test', 'cn'))
      .not.toBe(accountKey('b@example.test', 'cn'))
  })
})

describe('business keys', () => {
  it('separates the same workout on different dates', () => {
    expect(scheduleBusinessKey('account-a', '42', '2026-09-15'))
      .not.toBe(scheduleBusinessKey('account-a', '42', '2026-09-16'))
  })

  it('separates the same date for different workouts and accounts', () => {
    expect(scheduleBusinessKey('account-a', '42', '2026-09-15'))
      .not.toBe(scheduleBusinessKey('account-a', '43', '2026-09-15'))
    expect(scheduleBusinessKey('account-a', '42', '2026-09-15'))
      .not.toBe(scheduleBusinessKey('account-b', '42', '2026-09-15'))
  })

  it('encodes workout ids so the separator cannot be forged', () => {
    expect(scheduleBusinessKey('a', '1:2', '2026-09-15'))
      .not.toBe(scheduleBusinessKey('a', '1', '2:2026-09-15'))
  })

  it('scopes unschedule and create keys by account', () => {
    expect(unscheduleBusinessKey('account-a', '99')).not.toBe(unscheduleBusinessKey('account-b', '99'))
    expect(createBusinessKey('account-a', 'fp')).not.toBe(createBusinessKey('account-b', 'fp'))
  })
})

describe('idempotency keys', () => {
  it('accepts the documented character set and length', () => {
    expect(assertIdempotencyKey('run-2026.09.15:week1_A')).toBe('run-2026.09.15:week1_A')
    expect(assertIdempotencyKey(undefined)).toBeUndefined()
  })

  it('rejects empty, over-long and out-of-charset values before any network access', () => {
    for (const invalid of ['', 'a'.repeat(129), 'has space', 'slash/', 'emoji🙂']) {
      expect(() => assertIdempotencyKey(invalid)).toThrow(GarminWriteError)
    }
  })

  it('hashes with account scope and never returns the raw key', () => {
    const hash = idempotencyKeyHash('account-a', 'week-1')
    expect(hash).not.toContain('week-1')
    expect(hash).not.toBe(idempotencyKeyHash('account-b', 'week-1'))
  })
})

describe('workoutDefinitionFingerprint', () => {
  const definition = {
    name: 'Tempo 5x1k',
    sport: 'running',
    steps: [{ type: 'warmup' }, { type: 'interval' }],
  }

  it('ignores confirmation control fields', () => {
    expect(workoutDefinitionFingerprint({ ...definition, confirmed: true, confirmationId: 'x' }))
      .toBe(workoutDefinitionFingerprint({ ...definition, idempotencyKey: 'y' }))
  })

  it('keeps step order significant', () => {
    expect(workoutDefinitionFingerprint(definition)).not.toBe(workoutDefinitionFingerprint({
      ...definition,
      steps: [{ type: 'interval' }, { type: 'warmup' }],
    }))
  })

  it('changes when a non-name field changes', () => {
    expect(workoutDefinitionFingerprint(definition)).not.toBe(workoutDefinitionFingerprint({
      ...definition,
      steps: [{ type: 'warmup' }, { type: 'cooldown' }],
    }))
  })

  it('fills the real sport default rather than hashing an empty value', () => {
    expect(workoutDefinitionFingerprint({ ...definition, sport: undefined }))
      .toBe(workoutDefinitionFingerprint({ ...definition, sport: 'running' }))
  })
})

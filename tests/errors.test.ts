import {
  GarminAuthenticationRequiredError,
  PublicToolError,
  publicErrorMessage,
  safeUpstreamLogLine,
} from '../src/utils/errors'
import {
  isGarminAuthenticationRequiredReason,
} from '../src/auth-requirement'

describe('error disclosure boundaries', () => {
  it.each([
    ['missing', 'is required'],
    ['expired', 'has expired'],
    ['rejected', 'was rejected'],
  ] as const)('keeps the %s authentication reason machine-readable', (reason, phrase) => {
    const error = new GarminAuthenticationRequiredError(reason)

    expect(error).toBeInstanceOf(PublicToolError)
    expect(error.name).toBe('GarminAuthenticationRequiredError')
    expect(error.reason).toBe(reason)
    expect(error.message).toContain(`Garmin authentication ${phrase}`)
    expect(error.message).toContain(
      'garmin-connect-auth serve --account <alias> --open',
    )
  })

  it('keeps a locally detected browser challenge kind available to the caller', () => {
    const error = new GarminAuthenticationRequiredError(
      'challenge',
      undefined,
      'mfa',
    )

    expect(error.challengeKind).toBe('mfa')
    expect(error.message).toContain('requires browser verification')
  })

  it.each([
    ['missing', true],
    ['expired', true],
    ['rejected', true],
    ['challenge', true],
    ['verification', false],
    ['private upstream detail', false],
    [undefined, false],
  ])('validates the bounded auth reason domain for %p', (value, expected) => {
    expect(isGarminAuthenticationRequiredReason(value)).toBe(expected)
  })

  it('does not trust arbitrary upstream messages with a plausible prefix', () => {
    expect(publicErrorMessage(
      new Error('Garmin request failed with session_token=SENSITIVE for runner@example.test'),
      'Garmin request failed',
    )).toBe('Garmin request failed')
  })

  it('keeps exact locally generated timeout messages actionable', () => {
    expect(publicErrorMessage(
      new PublicToolError('Garmin request timed out after 15000ms'),
      'Garmin request failed',
    )).toBe('Garmin request timed out after 15000ms')
  })

  it('does not trust a forged validation-error prefix from upstream', () => {
    expect(publicErrorMessage(
      new Error('Invalid workout definition: Authorization: Bearer TOPSECRET'),
      'Failed to create workout',
    )).toBe('Failed to create workout')
  })

  it('sanitizes text and omits structured values from upstream console logs', () => {
    const line = safeUpstreamLogLine([
      new Error('runner@example.test Authorization: Bearer SECRET'),
      { config: { headers: { Authorization: 'Bearer SECRET' } } },
    ], ['runner@example.test', 'SECRET'])

    expect(line).not.toContain('runner@example.test')
    expect(line).not.toContain('SECRET')
    expect(line).toContain('[structured value omitted]')
  })

  it('redacts standalone bearer credentials even without a configured secret match', () => {
    const line = safeUpstreamLogLine([
      new Error('refresh failed with Bearer OAUTHSECRET'),
    ])

    expect(line).not.toContain('OAUTHSECRET')
    expect(line).toContain('Bearer [REDACTED]')
  })

  it('redacts OAuth signing secrets from upstream text logs', () => {
    const line = safeUpstreamLogLine([
      'oauth_token_secret=OAUTH1SECRET oauth_signature=SIGNATURESECRET ' +
      'client_secret=CLIENTSECRET consumer-secret=CONSUMERSECRET',
    ])

    expect(line).not.toContain('OAUTH1SECRET')
    expect(line).not.toContain('SIGNATURESECRET')
    expect(line).not.toContain('CLIENTSECRET')
    expect(line).not.toContain('CONSUMERSECRET')
  })
})

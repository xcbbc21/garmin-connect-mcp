import { nextAutomaticGarminAuthentication } from '../src/client/auto-auth'

const requirement = {
  authenticationRequired: true as const,
  reason: 'challenge' as const,
  region: 'cn' as const,
  revision: 4,
}

describe('DSH automatic Garmin authentication', () => {
  it('starts one local browser flow for a new requirement revision', () => {
    expect(nextAutomaticGarminAuthentication(requirement, {
      active: false,
      isLoopback: true,
      lastHandledRevision: undefined,
    })).toEqual({ region: 'cn', revision: 4 })
  })

  it.each([
    ['the same revision was already handled', { active: false, isLoopback: true, lastHandledRevision: 4 }],
    ['another authentication UI is active', { active: true, isLoopback: true, lastHandledRevision: undefined }],
    ['the DSH page is not local', { active: false, isLoopback: false, lastHandledRevision: undefined }],
  ])('does not start when %s', (_label, state) => {
    expect(nextAutomaticGarminAuthentication(requirement, state)).toBeUndefined()
  })

  it('allows a newer requirement revision after an earlier flow was dismissed', () => {
    expect(nextAutomaticGarminAuthentication({
      ...requirement,
      reason: 'expired',
      revision: 5,
    }, {
      active: false,
      isLoopback: true,
      lastHandledRevision: 4,
    })).toEqual({ region: 'cn', revision: 5 })
  })
})

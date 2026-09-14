import { getLegacyCapability } from '../src/legacy-capability-catalog'

describe('legacy capability catalog', () => {
  it('classifies read capabilities without treating source evidence as live evidence', () => {
    expect(getLegacyCapability('get-body-battery')).toMatchObject({
      access: 'read',
      verification: 'source-only',
    })
  })

  it('marks legacy schedule writes as do-not-copy', () => {
    expect(getLegacyCapability('schedule-workout')).toMatchObject({
      access: 'write',
      migration: 'do-not-copy',
    })
  })
})

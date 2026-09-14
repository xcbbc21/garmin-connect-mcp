import { resolveConfig } from '../src/config'

const baseEnv = { GARMIN_USERNAME: 'runner@example.test' }

describe('China-only Garmin configuration', () => {
  it('uses China without reading a user-selected region', () => {
    expect(resolveConfig({}, baseEnv).region).toBe('cn')
  })

  it('rejects the removed global region override from the environment', () => {
    expect(() => resolveConfig({}, { ...baseEnv, GARMIN_REGION: 'global' }))
      .toThrow('GARMIN_REGION is no longer supported')
  })

  it('rejects a removed region option from callers', () => {
    const removedRegionInput = { region: 'global' } as never
    expect(() => resolveConfig(removedRegionInput, baseEnv))
      .toThrow('region selection is no longer supported')
  })
})

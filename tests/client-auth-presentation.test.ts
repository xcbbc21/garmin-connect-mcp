import { regionLoginSubtitle } from '../src/client/presentation'

describe('Garmin login button presentation', () => {
  const account = {
    email: 'runner@example.test',
    region: 'cn' as const,
  }

  it('shows the authenticated email only on its matching region button', () => {
    expect(regionLoginSubtitle('cn', 'garmin.cn', account)).toBe(
      '已登录：「runner@example.test」',
    )
    expect(regionLoginSubtitle('global', 'garmin.com', account)).toBe('garmin.com')
  })

  it('keeps the regional domain when no authenticated account is available', () => {
    expect(regionLoginSubtitle('cn', 'garmin.cn')).toBe('garmin.cn')
    expect(regionLoginSubtitle('global', 'garmin.com')).toBe('garmin.com')
  })
})

import { detectGarminBrowserChallenge } from '../src/garmin-auth-challenge'

describe('Garmin browser challenge detection', () => {
  it.each([
    [
      'an MFA method variable',
      '<script>const mfaMethod = "totp"</script>',
      'mfa',
    ],
    [
      'an MFA code input',
      '<input autocomplete="one-time-code" name="mfa-code">',
      'mfa',
    ],
    [
      'an MFA verification form',
      '<form action="/sso/verifyMFA/loginEnterMfaCode"></form>',
      'mfa',
    ],
    [
      'an active reCAPTCHA widget',
      '<div class="g-recaptcha" data-sitekey="public-key"></div>',
      'verification',
    ],
    [
      'an active Turnstile widget',
      '<div class="cf-turnstile" data-sitekey="public-key"></div>',
      'verification',
    ],
    [
      'a Cloudflare managed challenge platform script',
      '<script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"></script>',
      'verification',
    ],
    [
      'a Cloudflare managed challenge marker',
      '<script>window._cf_chl_opt = { cRay: "public" }</script>',
      'verification',
    ],
  ] as const)('recognizes %s', (_label, html, expected) => {
    expect(detectGarminBrowserChallenge(html)).toBe(expected)
  })

  it.each([
    ['a generic sign-in page', '<form action="/sso/signin"><input name="password"></form>'],
    ['an MFA-looking title', '<title>MFA service unavailable</title>'],
    ['an unused CAPTCHA variable', '<script>const captchaToken = ""</script>'],
    ['a generic Cloudflare page', '<title>Cloudflare</title><p>Protected by Cloudflare</p>'],
    ['an empty MFA method', '<script>const mfaMethod = ""</script>'],
    ['a non-string response', { html: '<input name="mfa-code">' }],
  ])('does not infer a challenge from %s', (_label, html) => {
    expect(detectGarminBrowserChallenge(html)).toBeUndefined()
  })

  it('prefers an issued ticket over stale challenge markers', () => {
    expect(detectGarminBrowserChallenge([
      '<input name="mfa-code">',
      '<a href="?ticket=ST-ISSUED-TICKET">continue</a>',
    ].join(''))).toBeUndefined()
  })
})

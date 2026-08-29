const ISSUED_TICKET_PATTERN = /\bticket=(ST-[^"'\s<&]+)/i
const MFA_METHOD_PATTERN =
  /(?:var|let|const)\s+mfaMethod\s*=\s*["']\s*([^"'\s][^"']*)["']\s*;?/i
const MFA_CODE_INPUT_PATTERN =
  /<input\b[^>]*\bname\s*=\s*["']mfa-code["'][^>]*>/i
const MFA_FORM_ACTION_PATTERN =
  /<form\b[^>]*\baction\s*=\s*["'][^"']*verifyMFA[^"']*["'][^>]*>/i
const ACTIVE_BROWSER_VERIFICATION_PATTERNS = [
  /\bclass\s*=\s*["'][^"']*\bg-recaptcha\b[^"']*["']/i,
  /(?:google\.com|gstatic\.com)\/recaptcha\/(?:api|enterprise)\.js/i,
  /\bclass\s*=\s*["'][^"']*\bh-captcha\b[^"']*["']/i,
  /(?:^|\.)hcaptcha\.com\/1\/api\.js/i,
  /\bclass\s*=\s*["'][^"']*\bcf-turnstile\b[^"']*["']/i,
  /challenges\.cloudflare\.com\/turnstile\//i,
] as const

export type GarminBrowserChallenge = 'mfa' | 'verification'

/**
 * Recognize only positive browser-challenge evidence from Garmin's sign-in
 * response. A ticket always wins because successful pages can retain stale
 * MFA markup that must not turn a completed login into another auth request.
 */
export function detectGarminBrowserChallenge(
  html: unknown,
): GarminBrowserChallenge | undefined {
  if (typeof html !== 'string' || ISSUED_TICKET_PATTERN.test(html)) {
    return undefined
  }

  const mfaMethod = MFA_METHOD_PATTERN.exec(html)?.[1]?.trim()
  if (
    mfaMethod
    || MFA_CODE_INPUT_PATTERN.test(html)
    || MFA_FORM_ACTION_PATTERN.test(html)
  ) {
    return 'mfa'
  }

  return ACTIVE_BROWSER_VERIFICATION_PATTERNS.some(pattern => pattern.test(html))
    ? 'verification'
    : undefined
}

const SERVICE_TICKET_PATTERN = /^ST-[A-Za-z0-9._~-]+$/
export const MAX_GARMIN_SERVICE_TICKET_BYTES = 2 * 1024

/** Accept only Garmin's bounded ASCII service-ticket shape. */
export function isUsableGarminServiceTicket(
  value: unknown,
): value is string {
  return typeof value === 'string'
    && value.length <= MAX_GARMIN_SERVICE_TICKET_BYTES
    && SERVICE_TICKET_PATTERN.test(value)
}

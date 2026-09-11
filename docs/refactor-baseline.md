# Universal MCP refactor baseline

Source revision: `52b67cd`. Baseline verified locally on 2026-09-10:
38 suites / 831 tests passed after a clean `npm ci`.

The fixture `tests/fixtures/mcp-tools-baseline.json` was captured through an
MCP SDK client connected to the unmodified server. It recorded all 14 tools of
that revision — their descriptions, input schemas and annotations. It is a
regression contract, not a generated description of the refactored
implementation.

The fixture has since been extended to 18 entries. The 14 baseline tools are
still asserted field by field against the captured values; the four additions
(`get_garmin_calendar`, `get_garmin_write_operation`,
`reconcile_garmin_write_operation`, `resume_garmin_write_operation`) were
appended after reviewing the diff, and the two `idempotencyKey` fields added to
`create_and_schedule_garmin_workout` and `unschedule_garmin_workout` are the
only changes inside the original 14. Regenerate with
`npx tsx tests/scripts/gen-baseline.ts`; the diff must be reviewed before it is
accepted.

Preserve the `garmin-connect-mcp` and `garmin-connect-auth` executables,
`lib/mcp.js`, current GARMIN_* environment interpretation, account aliases,
session-file locations and session formats. Importing the new programmatic
entrypoint must not load dotenv, start a server, or log.

The removed surface is the former host-specific plugin API and browser UI.
Existing authentication, FIT, workout creation and Calendar behavior remain
covered separately. Baseline test counts are not a target after removing
adapter-only tests.

# Universal MCP refactor baseline

Source revision: `52b67cd`. Baseline verified locally on 2026-09-10:
38 suites / 831 tests passed after a clean `npm ci`.

The fixture `tests/fixtures/mcp-tools-baseline.json` was captured through an
MCP SDK client connected to the unmodified server. It records all 14 tools,
their descriptions, input schemas and annotations. It is a regression contract,
not a generated description of the refactored implementation.

Preserve the `garmin-connect-mcp` and `garmin-connect-auth` executables,
`lib/mcp.js`, current GARMIN_* environment interpretation, account aliases,
session-file locations and session formats. Importing the new programmatic
entrypoint must not load dotenv, start a server, or log.

The removed surface is the former host-specific plugin API and browser UI.
Existing authentication, FIT, workout creation and Calendar behavior remain
covered separately. Baseline test counts are not a target after removing
adapter-only tests.

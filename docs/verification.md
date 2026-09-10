# Standalone MCP 0.2.0 verification

Verification started 2026-09-10; final clean-install rerun 2026-09-11.
Local environment: macOS arm64, Node v25.2.1, npm 11.19.0.
This report covers the standalone refactor against baseline commit `52b67cd`.

## Recorded results

| Check | Result |
| --- | --- |
| Pre-refactor clean install and tests | 38 suites / 831 tests passed |
| Refactored full tests with coverage | 36 suites / 789 tests passed |
| Statements / branches / functions / lines | 86.86% / 79.24% / 87.09% / 89.85% |
| Existing coverage thresholds | Preserved: 75% / 70% / 65% / 78%, all passed |
| TypeScript build | Passed, after cleaning the generated lib directory |
| Non-mutating ESLint | Passed |
| MCP compatibility | All 14 tool definitions, descriptions, input schemas and annotations match the captured fixture |
| Actual executable over stdio | Initialization, discovery, no-network preview, missing-session fallback and shutdown passed |
| Simulated Calendar operation over stdio | Preview, confirmed write, replay rejection and child shutdown passed |
| Package-root import | No dotenv loading, logs or service startup |
| Packed runtime in an empty consumer directory | Installed with development dependencies omitted; dependency tree, public API import, auth help, 14-tool discovery, preview and process shutdown passed |
| Package content audit | Passed: only runtime files, selected docs, license/provenance and optional skill; no removed host UI or adapters |
| Clean source installation | Git archive of `4564f26` installed into a new temporary directory; npm ci, lint, full coverage, pack audit and runtime-only installation all passed |
| Independent core review | No critical or important findings; separate no-network verification of 6 suites / 51 tests passed |

Adapter-only tests were removed, and standalone/configuration/logging/Calendar
regressions were added. A smaller total is not a reduction in the retained
functionality contract.

## Audit and validation coverage

- Current runtime source, package manifest, lockfile, README files, environment
  example and optional skill have no DeepSeek/DSH/Cordis/Schemastery dependency
  or installation path.
- The former plugin entrypoint, duplicate tool registry, host RPC, React client,
  client bundle build, plugin patch, private weekly-training script, old site
  configuration, CNAME and brand images were removed.
- Shared browser login, session persistence/rotation, account isolation,
  platform file-permission checks and authentication shutdown were retained.
- Public protocol is unchanged. Calendar tests cover invalid dates/timezones,
  local midnight boundaries, invalid/unavailable IDs, repeated templates,
  duplicate batch entries, multiweek scheduling, confirmation binding/expiry/
  replay, partial failure and uncertain writes. Rest days are omitted; internal
  workout rest steps remain valid.
- Direct React/esbuild dependencies are removed. esbuild remains a development
  transitive dependency of tsx; it is not a frontend bundle or runtime dependency.
- Build cleanup removes only this project's generated lib directory and refuses
  a symlinked output directory.
- Historical reports, changelog and provenance retain upstream references
  intentionally; they are not current setup instructions.
- Native Windows CI exposed test-loader URL formatting and invalid inherited-ACL
  temporary fixtures; both were corrected without relaxing the private-directory
  policy. It also confirmed the first PowerShell invocation was silently killed
  at 60 seconds, while subsequent real ACL checks succeeded. The bounded native
  subprocess allowance is now 120 seconds, with sanitized failure metadata in
  the native smoke test.

## Evidence boundaries

No personal Garmin credentials were used for this refactor. No live workout,
Calendar schedule/cancellation or watch synchronization was performed.
The existing schedule/delete transport uses unofficial Garmin endpoints;
mocked tests do not establish their current service-side acceptance.

Desktop client configuration examples are not claims of end-to-end client
validation. CI is configured for Linux Node 20/22 and native macOS/Windows
checks; a local macOS run alone does not establish remote CI results.

Live read-only checks are available explicitly through `npm run test:integration`
using the same public client and session configuration. They are excluded from CI.

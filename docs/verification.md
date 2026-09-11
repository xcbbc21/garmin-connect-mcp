# Standalone MCP 0.2.0 verification

Verification started 2026-09-10; final clean-install rerun 2026-09-11.
Local environment: macOS arm64, Node v25.2.1, npm 11.19.0.
This report covers the standalone refactor against baseline commit `52b67cd`.

## Calendar write-safety increment (2026-09-11)

Verified against baseline `67f5ec9` on macOS arm64, Node v22.22.2, npm 10.9.7.

| Check | Result |
| --- | --- |
| Full suite | 41 suites / 847 tests passed |
| Coverage with all gates | Passed. All files 87.03% statements / 78.81% branches / 87.16% functions / 89.83% lines (gates 75/70/65/78). `src/write-operations` 88.22 / 71.25 / 87.27 / 89.44 |
| TypeScript | `npx tsc --noEmit` clean |
| Lint | `eslint src tests scripts --max-warnings 0` clean, 0 warnings |
| Package content audit | Passed: 179 files, 270,729 B packed; no `src`, `tests`, `node_modules`, session or journal content |
| Runtime-only distribution install | Passed: `runtimeOnlyInstall: true`, 14 tools |
| Journal durability | Faults injected at every write point (open, write, sync, rename); the previous journal stayed readable and no temporary file was left behind |
| Cross-process locking | Two real Node subprocesses contended for one lock; critical sections never overlapped, a stale lock was not preempted and a non-owner could not release it |
| Deduplication | A new preview, a different idempotency key, a full restart and two concurrent confirmations each sent exactly one POST |
| Pre-dispatch durability | A failed `in_flight` persistence sent nothing and left the step `prepared` |
| Supersession | A widened second preview demoted the first to `not_attempted`; confirming it dispatched nothing |
| stdio child process | Preview, confirmed write, replay rejection and post-write dedup passed through the built server |

**Not verified.** No real Garmin account was contacted; no live schedule, cancellation or
watch sync was performed. Linux and Windows were not exercised, so atomic-rename semantics,
private ACLs and subprocess lock release on those platforms remain unverified. The packaged
build (`npm run build`) could not run in this environment because its `clean` step is refused
by a bulk-delete guard; `npx tsc` was used instead, so CI remains the authority for the
packaged artifact. `npm run test:integration` was not run.

**Deliberately not implemented.** Calendar range query, reconcile/resume and the four planned
inspection/recovery tools. Because no verified calendar range endpoint exists, absence can
never be proven, so the coordinator never clears a business key from an empty read and an
`unknown` write blocks its workout/date permanently. Details and evidence boundaries:
[docs/calendar-api-verification.md](calendar-api-verification.md) and
[docs/calendar-write-delivery.md](calendar-write-delivery.md).

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
| Remote clean-install CI | All four jobs passed on runtime commit `754e624`: Linux Node 20/22, macOS and Windows, including packed runtime installation |

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
validation. [Remote CI run 34543981619](https://github.com/xcbbc21/garmin-connect-mcp/actions/runs/34543981619)
passed all four jobs, including native macOS/Windows permission checks and
isolated packed-runtime installs. Linux runs the full coverage suite; platform
jobs run the relevant native permissions and process/protocol tests.

Live read-only checks are available explicitly through `npm run test:integration`
using the same public client and session configuration. They are excluded from CI.

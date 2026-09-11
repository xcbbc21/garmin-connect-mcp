# Calendar write safety: delivery and acceptance

Date: 2026-09-11
Baseline: `67f5ec9` (package `0.2.0`)
Resulting commits: `08ac0f3`, `6268be7` on `main`. **Not pushed** — no push authorisation was
given for this increment.

## 1. Scope delivered

| Plan task | Status |
|---|---|
| Task 0 — baseline and interface evidence | Done — `docs/calendar-api-verification.md` |
| Task 2 — identity, persistent journal, cross-process lock | Done |
| Task 3 — typed write outcomes, no replay | Done for the calendar/write paths |
| Task 4 — single-day schedule coordinator with cross-request dedup | Done |
| Task 6 — batch / create / unschedule coverage | **Partial** — batch scheduling is coordinated; create, create-and-schedule and unschedule are not |
| Task 1 — calendar range query | **Not delivered** — no verified endpoint exists (see §5) |
| Task 5 — reconcile and resume | **Not delivered** — depends on Task 1 |
| Task 7 — MCP contract | **Partial** — `idempotencyKey` and corrected descriptions shipped; the 4 new tools did not |
| Task 8 — documentation | Done for the new behaviour and the recovery procedure |
| Task 9 — full acceptance | Done for local platforms; see §3 for what could not be executed |

Tool count is unchanged at 14 (the 4 new inspection/recovery tools are not implemented).

## 2. Changed files

`08ac0f3` — safety substrate (17 files): new `src/write-operations/{types,errors,identity,store,lock}.ts`;
`src/config.ts` and `src/account-session.ts`; tests for each; `jest.config.js` isolation;
`.env.example`.

`6268be7` — integration (12 files): new `src/write-operations/coordinator.ts`;
`src/client.ts`, `src/tool-service.ts`, `src/mcp.ts`; the two new docs;
`tests/write-coordinator.test.ts` and three migrated suites; the reviewed
`tests/fixtures/mcp-tools-baseline.json`.

`docs/superpowers/` is the user's own plan directory and is left untracked and untouched.

## 3. Verification results

Commands run from the repository root. `NODE_OPTIONS=""` is used for jest because this
sandbox injects a `--require` shim that the browser-auth canary correctly rejects as a
weakened HTTP policy; the suite passes without it.

| Command | Result |
|---|---|
| `npx tsc --noEmit` | Clean |
| `npm run lint` (`eslint src tests scripts --max-warnings 0`) | Clean, 0 warnings |
| `npx jest --runInBand` | **41 suites, 847 tests, all passing** |
| `npx jest --coverage --runInBand` | All thresholds met. All files 87.03% stmts / 78.81% branch / 87.16% func / 89.83% lines (gates 75/70/65/78). `src/write-operations` 88.22 / 71.25 / 87.27 / 89.44 |
| `npm run build` | **Blocked in this sandbox** — `scripts/clean.mjs` is refused by the environment's bulk-delete guard (140 files > threshold). `npx tsc` was used instead and compiles cleanly into `lib/`. Not a code failure. |
| `npm run pack:smoke` (audit) | Passed — 179 files, 270,729 B packed, no `tests`/`src`/`node_modules`/session/journal content |
| `npm run test:distribution` | Passed — `runtimeOnlyInstall:true`, 14 tools |
| `npm run test:integration` | **Not run** — requires real account access, which was not authorised |

Platforms: macOS (this machine) executed everything above. Linux and Windows were **not**
exercised, so atomic-rename semantics, private ACLs and subprocess lock release on those
platforms remain unverified.

## 4. Interface evidence

Full table in `docs/calendar-api-verification.md`. Summary:

| Capability | Source-verified | Live-verified |
|---|---|---|
| `POST /workout-service/schedule/{workoutId}` (global, cn) | Yes — `src/client.ts` | No |
| `DELETE /workout-service/schedule/{workoutScheduleId}` | Yes — `src/client.ts` | No |
| SDK exposes `scheduleWorkout` | Disproven — absent from `garmin-connect@1.6.2` dist despite its README | n/a |
| Calendar range query | Absent from the SDK and from this repository | n/a |

No endpoint, field or region is claimed to work from assumption alone.

## 5. Reproducible demonstrations

Each of the three required scenarios is a named regression test.

```bash
# 1. A new preview for the same workout/date is blocked and re-sends nothing.
npx jest --runInBand tests/write-coordinator.test.ts \
  -t "a brand-new preview cannot bypass an existing unknown write"

# 2. After a restart, the new process still refuses to re-send the write.
npx jest --runInBand tests/write-coordinator.test.ts \
  -t "a restarted process cannot bypass an existing unknown write"

# 3. Two callers confirming the same workout/date send exactly one POST.
npx jest --runInBand tests/write-coordinator.test.ts \
  -t "concurrent confirmations cannot double-write the same workout and date"

# Supporting: a different idempotency key is also blocked, and in_flight is
# persisted before dispatch (a failed persistence sends nothing).
npx jest --runInBand tests/write-coordinator.test.ts
```

Each test asserts the Garmin write count stays at 1 across the attempt, which is the
property that actually matters.

## 6. Acceptance matrix coverage

| Category | Covered |
|---|---|
| Dates (leap, invalid, DST boundary, timezone boundaries) | Existing suite, unchanged |
| Calendar query (missing page, cursor loop, region capability) | **Not covered** — feature absent |
| IDs (empty/over-long, wrong type, activity id) | Existing suite |
| Preview (unconfirmed, expired, replayed, changed params, changed account) | Existing + migrated regression tests |
| Dedup (new preview, new key, no key, single vs batch) | New coordinator suite |
| Account (case, unicode, alias, region, identity switch) | New identity suite |
| State (fault at each write point, before/after) | New store suite (open/write/sync/rename) |
| Concurrency (two processes, held lock, non-owner release, wait timeout) | New lock suite, real subprocesses |
| Crash (mid-write, restart) | Partial — restart and pre-dispatch failure covered; process-kill mid-dispatch not covered |
| Timeout (response lost, late result) | Covered for classification and single dispatch; late-result log update not implemented |
| Reconcile | **Not covered** — feature absent |
| Create (created then schedule failed, unknown id, same template across tools) | Existing behaviour only; not journal-backed |
| Unschedule | Existing behaviour only |
| Batch (partial unknown, auth loss, storage failure, interruption) | Partial — per-step states and counts covered; auth-loss interruption not covered |
| Auth (missing/expired, no auto-replay after login) | Existing suite |
| MCP (real stdio subprocess, restart, result loss) | stdio dedup covered; restart over stdio not covered |
| Packaging (runtime-only install, no private content) | Distribution + audit scripts |

## 7. Remaining limitations

1. **No server-side exactly-once.** Deduplication is client-side and only covers writers that
   share this journal. Another device, the Garmin web UI, or a second machine with a different
   state root can still create a duplicate.
2. **No verified calendar query, so absence can never be proven.** The coordinator therefore
   never concludes "not found" and never clears a business key from an empty read.
3. **An `unknown` write blocks its workout/date permanently.** Deliberate: recoverability is
   not traded for duplicate-write risk. There is currently no automatic recovery tool.
4. **Create and unschedule are not journal-backed.** A create that times out after the workout
   exists still cannot be matched to a template, and unschedule cannot verify absence.
5. **Leaked locks are not auto-cleared** and require the documented offline procedure.
6. **Cross-platform behaviour is unverified** on Linux and Windows.
7. **`npm run build` cannot run in this sandbox** because its `clean` step is blocked; `tsc`
   was used directly. CI should be the authority for the packaged build.
8. Known-stale items that were deliberately left as-is: `src/di-session.ts` auth-epoch replay
   rules, FIT export, and the running-advice knowledge base were not touched.

## 8. Follow-up work

- Implement `docs/calendar-api-verification.md` §4 once a calendar range endpoint is verified
  for both regions, then reconcile/resume plus the 4 inspection tools.
- Extend journal coverage to create, create-and-schedule and unschedule.
- Add late-result handling (operationId + stepId + attempt bound) and bounded shutdown.
- Add Linux/Windows CI for atomic rename, private ACLs and lock release.

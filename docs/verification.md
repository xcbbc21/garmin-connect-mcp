# Standalone MCP 0.2.0 verification

Verification started 2026-09-10; final clean-install rerun 2026-09-11; the calendar
write-safety continuation round was re-measured on 2026-09-12.
Local environment: macOS arm64, Node v25.2.1, npm 11.19.0.
This report covers the standalone refactor against baseline commit `52b67cd`.

## Calendar write-safety increment, first round (2026-09-11)

This subsection is the report of the **first** round only. It was verified against baseline
`67f5ec9` on macOS arm64, Node v22.22.2, npm 10.9.7, and its numbers are retained as history;
they are not the current result. The continuation round below supersedes every row whose
status changed.

| Check | Result (at `67f5ec9`) |
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

Two claims that this first round made about the environment and the scope turned out to be
wrong, and are corrected here rather than left standing:

- **`npm run build` was reported as unrunnable** because its `clean` step was refused by a
  bulk-delete guard. That was an artifact of the shell used at the time, not of the project.
  `npm run build`, `npm run pack:smoke` and `npm run test:distribution` all complete
  successfully in the continuation round (see below), so the packaged artifact no longer
  depends on CI alone.
- **"Deliberately not implemented" was wrong.** Calendar range query, reconcile and resume were
  not an accepted scope exclusion; they were unfinished work. The continuation round
  implemented them.

## Calendar write-safety and recovery, continuation round (2026-09-12)

Verified at commit `3a82e4f`, baselines for comparison `e091d1b` (round start) and `ff128b6`
(the commit at which the product defect below was fixed). Local environment: macOS arm64
(darwin), Node v25.2.1, npm 11.19.0. The macOS rows were run from a clean `npm ci` install on
this machine, in this order, with no pre-script bypassed; the Linux rows were measured on the
same commit inside a container (see the platform section).

`3a82e4f` is the final commit of the round. No file under `src/` has changed since `ff128b6`:
the commits in between add documentation, `scripts/demo-write-recovery.ts` and one test file,
none of which `tsconfig` compiles (`include: ["src"]`, so `scripts/` and `tests/` are outside the
build). The full command set was nevertheless re-measured at the final commit on both platforms.
Every number below comes from that re-run; none of them is carried over from an earlier commit,
and the suite and test counts moved by the five cases the new guard test adds.

The packaged-artifact rows are reported **per measured tree**: the macOS rows were measured on the
release tree at `3a82e4f`, and the Linux rows on a clean `git archive 3a82e4f` export carrying
neither `node_modules` nor `.git`, so `npm ci` there is a genuine clean install. Both trees audit
to the same 204 files, because the `package.json` entry that adds `docs/calendar-write-delivery.md`
to `files` and that document itself are both present in the export. Source-level results (`lint`,
`test`, `build`) are identical across all three hosts because no source file differs; coverage
differs only in platform-conditional branches, and that difference is reported rather than
averaged away. The audited properties of the release tree are that every required document is
present, the file count is 204, and no forbidden content is included. Exact packed byte totals are
deliberately **not** recorded: `package.json` ships in every tarball whether or not `files` names
it, so any edit to a script or to this document moves the totals, and a number quoted here would
be stale the moment it was written. The file count and the audit verdict are the stable claims.

The suite count is the same on both hosts but the pass/skip split is not, because one test is
macOS-only: `refuses a journal carrying a granting macOS ACL` runs only where `chmod +a` exists.

| Check | Command | Result |
| --- | --- | --- |
| Clean install | `npm ci` | exit 0 |
| Lint | `npm run lint` | exit 0, 0 warnings |
| Full suite (macOS host) | `npm test -- --runInBand` | exit 0, 58 suites / 1143 tests, **1143 passed, 0 skipped** |
| Full suite (Linux container, Node 20 and Node 22) | `npm test -- --runInBand` | exit 0 on both, 58 suites / 1143 tests, **1142 passed, 1 skipped** — the macOS-ACL test |
| Coverage with all gates | `npm run test:coverage` | exit 0 on all three hosts. macOS All files 87.29% statements / 77.59% branches / 87.44% functions / 89.92% lines; Linux All files 87.15 / 77.45 / 87.20 / 89.75. Gates 75/70/65/78. `src/write-operations` 85.32 / 72.73 / 87.30 / 87.71 on macOS and 85.32 / 72.62 / 87.30 / 87.71 on Linux; `src/calendar` 96.69 / 93.42 / 97.50 / 98.06 on both |
| Packaged build | `npm run build` (`clean` + `tsc`) | exit 0 |
| Package content audit (release tree) | `npm run pack:smoke` | exit 0. 204 files, `"audit": "passed"`; no `src`, `tests`, `node_modules`, session or journal content |
| Package content audit (clean `git archive 3a82e4f`) | `npm run pack:smoke` | exit 0. 204 files, `"audit": "passed"` |
| Runtime-only distribution install | `npm run test:distribution` | exit 0 on every host and tree. `{"distribution":"passed","version":"0.2.0","tools":18,"runtimeOnlyInstall":true}` |
| Three required demos, end to end | `npm run demo:recovery` (`build` + `tsx scripts/demo-write-recovery.ts`) | exit 0 on all three hosts, printing `DEMO 1 OK`, `DEMO 2 OK`, `DEMO 3 OK`, `ALL THREE DEMOS OK`. Real MCP children against the out-of-process fake Garmin peer; each demo has its own peer. See `docs/calendar-write-delivery.md` §7b |
| macOS write-state platform battery | `npx jest --runInBand` on the cross-platform write-state set, two batches | exit 0, 12 suites / 189 tests (6 suites / 55 tests, then 6 suites / 134 tests) |
| Linux write-state platform battery, Node 20 | `arm64v8/ubuntu:22.04` container, official linux-arm64 Node tarballs, full command set | exit 0, all eight commands. See the platform section below |
| Linux write-state platform battery, Node 22 | same container and channel | exit 0, all eight commands. See the platform section below |
| Windows write-state platform battery | — | **not run** — no Windows host is available here; see limitations |
| Live account integration | `npm run test:integration` | **not run** — no authorized real credentials were available; see limitations |

`demo:recovery` is a source-tree command: `scripts/` is deliberately not in `package.json` `files`,
so it runs from a repository checkout, like `test`, `lint` and `pack:smoke`. It was run repeatedly
at the round's final commits — including once as the last step of each platform battery recorded
above, in the Linux container on both Node versions — and printed the same three `OK` lines and
`ALL THREE DEMOS OK` every time. It also asserts its own negative evidence: each demo reads the
fake peer's POST and applied counters and fails if any step it was not allowed to re-send was
re-sent.

Tool surface after this round: **18 tools** (14 read/preview tools plus
`get_garmin_calendar`, `get_garmin_write_operation`, `reconcile_garmin_write_operation`,
`resume_garmin_write_operation`). The 14 baseline tool names, required parameters and success
fields are unchanged.

What the continuation round added, each backed by committed tests:

- **Create, create-and-schedule and unschedule now go through the coordinator.** All five
  write verbs are journaled; a repeated request and a restart can no longer create a duplicate
  template or a duplicate schedule. The previous four direct `client.addWorkout` /
  `client.scheduleWorkout` / `client.unscheduleWorkout` call sites in `src/tool-service.ts`
  are gone.
- **Journal migration v1 → v2 runs automatically under the lock.** Plaintext idempotency keys
  are removed from live records and replaced by a salted hash; unindexed keys are added to the
  index; duplicate bindings produced by the old defect are quarantined for manual review rather
  than deleted; a missing or unsupported `schemaVersion`, an account mismatch, an index entry
  pointing at a missing operation or an invalid step all raise `STATE_CORRUPT` and no write is
  issued.
- **Calendar range query with an explicit capability boundary.** `get_garmin_calendar` is
  read-only; a region without a verifiable read endpoint fails closed with
  `CALENDAR_QUERY_UNSUPPORTED` instead of returning an empty snapshot, so absence is never
  inferred from an unavailable read.
- **Reconcile records evidence and never rewrites status.** `reconcile_garmin_write_operation`
  only appends `evidence` / `observedAt`; `status` stays `unknown` until a real response
  receipt exists. `wroteToGarmin` is false for every reconcile.
- **Resume is bounded to steps proven never to have applied.** `resume_garmin_write_operation`
  re-reads Garmin under a read budget (3 reads / 20 s) and refuses any step whose outcome is
  unknown (`WRITE_OUTCOME_UNKNOWN`); a timeout is never re-sent.
- **Confirmation handles are `<operationId>:<previewRevision>`**, persisted with their
  deadline, so an unexpired handle survives a restart while a re-preview invalidates the old
  one with `CONFIRMATION_STALE`.
- **Lock contention is decided by the refused exclusive create itself.** A failed `mkdir` is
  treated as contention evidence whether or not a follow-up existence check still sees the
  holder, closing a window in which a holder releasing between two observations was reported
  as `STATE_UNAVAILABLE` ("Write lock could not be created: EEXIST"). Non-`EEXIST` failures
  still fail closed.
- **All five write tools accept `idempotencyKey` at the real MCP parameter layer.** Having the
  parameter on the service signature is not the same as a client being able to send it: the
  input schemas of `create_and_schedule_garmin_workout` (`src/mcp.ts:455`) and
  `unschedule_garmin_workout` (`src/mcp.ts:472`) did not expose it, so `idempotencyKey` was
  unreachable for any MCP caller. Both schemas now carry it, `tests/mcp.test.ts` calls each of
  the five tools through the MCP layer and asserts the key reaches the service, and one case
  asserts an invalid key is rejected before the service is called. The committed tool-schema
  fixture was regenerated from the reviewed diff rather than by relaxing an expected count.
- **The journal commit is now proven by reading the committed bytes back, not by inode identity.**
  This closes a real defect that the round shipped with and that macOS could not see. The
  previous `save()` treated a landed file as committed when its `(dev, ino)` pair matched the
  staged file. POSIX permits an implementation to reuse the inode number of a file that was just
  unlinked, so on Linux the check accepted a file the store never wrote. Reproduced in the same
  container image this report uses, on overlayfs: a staged file reported `ino=120222`, and after
  unlink plus a fresh write the landed file reported `ino=120222` again — identical `(dev, ino)`,
  different content. `assertLandedFile` now takes the payload, keeps `(dev, ino)` and the size as
  cheap pre-signals (the size is re-read from the write handle after `write` + `sync`, since the
  pre-write `stat` was stale), and then opens the landed file read-only and compares the bytes
  through the same bounded `readExactly` reader, so the read is size-limited before it starts.
  The error text names which check failed: a different inode, a different size, or different
  bytes. The regression test
  `refuses a replacement that reuses the inode and matches the size` deliberately masks the
  inode signal by injecting an `lstat` that reports the staged `dev`/`ino` and tampering with
  same-length bytes inside the `rename` hook, so the assertion pins the byte check on every
  platform instead of only on the one that recycles inodes. Two mutation proofs were run and
  reverted: reverting to identity-only made the old test pass on macOS while the new one failed,
  which is the false green; removing identity and size and leaving bytes alone still passed all
  51 tests in the suite, so the byte check alone carries the guarantee and the identity pair and
  size are defence in depth. `STATE_CORRUPT` and `not_applied` are unchanged.
- **The write-dispatch scan is pinned as a test, not left as a one-off grep.** C10 required every
  write call in `src/` to be enumerated and justified. A manual grep in a report has no hold on
  the next commit, so the enumeration is committed as `tests/write-path-inventory.test.ts`, which
  fails if an unreviewed dispatch point appears. It asserts that every transport-verb call
  (`addWorkout`, `scheduleWorkout`, `unscheduleWorkout`) and every coordinator writer-verb call
  (`addWorkout`, `schedule`, `unschedule`) is made on a receiver that has been reviewed; that
  inside `src/tool-service.ts` the receiver is one of `writeCoordinator`, `resumeWriter`,
  `createWorkout`, `createAndScheduleWorkout`, `unscheduleWorkout`; that `src/mcp.ts` never
  touches `.client`; and that the remaining `src` files contain no write dispatch at all. The
  inventory is pinned by name and receiver, not by count or line number, so a new write path has
  to be reviewed rather than merely make a number move. The recorded inventory: `src/mcp.ts` has
  two facade calls (`:412` `service.scheduleWorkout`, `:474` `service.unscheduleWorkout`) and zero
  `.client` references; `src/tool-service.ts` has eight `this.client.<verb>` sites, each inside a
  reviewed window (`:654`, `:1024`, `:1370`, `:1372`, `:1495`, `:1731`, `:1738`, `:1742`); and
  `src/write-operations/coordinator.ts` has four (`:1479`, `:2226`, `:2262`, `:2284`). A mutation
  proof was run and reverted: injecting an extra `this.client.scheduleWorkout(...)` into the
  `batchScheduleWorkouts` handler made the guard fail on exactly that new site, and restoring the
  file returned it byte-for-byte to the committed version with the guard green again.

**Not verified — stated as gaps, not as scope exclusions.**

- No real Garmin account was contacted and no live schedule, cancellation or watch sync was
  performed. `npm run test:integration` was not run.
- **Read-side live evidence is zero.** The calendar read adapter is exercised only against the
  mocked adapter and the simulated Garmin service in the test fixtures. No single live
  response from the real endpoint has been captured, so the adapter's field mapping and
  pagination assumptions remain unconfirmed against the service. A runnable read-only probe now
  exists (`runCalendarReadProbe`) and is what would close this; it has **not** been run, because
  no live Garmin authorisation was given. Its contract is covered by tests against a fake
  service, which is a statement about the probe's own logic and not about Garmin.
- **Windows was not exercised in this round.** This machine has no Windows execution
  capability. The Windows job in `.github/workflows/ci.yml` now includes the write journal,
  account lock, migration, private-state and stdio recovery suites, but the job has not been
  run for this commit, so native DACL enforcement, atomic rename semantics and subprocess lock
  release on NTFS remain unverified here. This is a missing external evidence source, not a
  scope exclusion.
- **Linux is verified in a container, and the channel is not the official Node image.** Both
  Node 20 and Node 22 pass the full command set on a real Linux/aarch64 kernel, libc and
  filesystem, but Node is delivered as the official `linux-arm64` tarball mounted read-only
  onto an `arm64v8/ubuntu:22.04` image rather than as the official `node:20` / `node:22` images.
  The results are therefore not interchangeable with a run on those images or on the CI runner
  image. The exact results and this caveat are restated in the platform section below.
- Deleting the state directory still removes the only record preventing duplicate scheduling;
  a journal with no archive refuses writes past 32 MiB.
- The same inode-identity weakness that was fixed in the journal store still exists in
  `assertSameFileSystemEntry` (`src/private-path.ts`), which is shared with the session-token
  path. It is recorded as a residual limitation in `CHANGELOG.md` rather than changed here: the
  properties it guards are re-asserted from the opened handle's `fstat` immediately afterwards,
  and an attacker able to write into the private state directory could already produce a
  schema-valid journal. This is a reasoned residual risk, not a verified absence of one.

## Platform results, continuation round

The cross-platform write-state set is the suites whose behaviour depends on the host filesystem,
process model or permission semantics: `session-store`, `session-store-write`, `stdio`, `scripts`,
`index`, `darwin-private-acl`, `stdio-protocol`, `write-stdio-recovery`, `write-operation-lock`,
`write-state-security`, `write-operation-store` and `write-operation-migration`.

**macOS arm64 (darwin), Node v25.2.1.** The full suite runs on the host at the
probe-repair commit: 59 suites / 1205 tests, all passing, with no platform skip — the
darwin-only ACL case runs rather than skips. Host coverage there is All files
87.73% / 78.13% / 88.08% / 90.33% and `src/write-operations`
86.52% / 74.39% / 87.93% / 88.79%. The 12-suite cross-platform set was additionally
run in two batches at `3a82e4f`; both exited 0: 6 suites / 55 tests, then
6 suites / 134 tests — 12 suites / 189 tests in total. The second batch is one test
larger than the pre-fix count because the inode-reuse regression test was added.

**Linux aarch64, container `arm64v8/ubuntu:22.04`, kernel `6.12.76-linuxkit`, Ubuntu 22.04.5 LTS.**
Exported with `git archive 90ae9a8` into a tree carrying neither `node_modules` nor `.git`, so
`npm ci` is a genuine clean install. Node 20 and Node 22 were run serially, to remove CPU
contention as a source of lock-test flakiness. `npm run build` is an explicit step in this battery
rather than an implicit `pretest` hook, so the standard-build row below is the result of the
command named in it and not of a pre-script that happened to compile the tree.

| Command | Node v20.19.5 / npm 10.8.2 | Node v22.22.2 / npm 10.9.7 |
| --- | --- | --- |
| `npm ci` | exit 0 | exit 0 |
| `npm run build` (`clean` + `tsc`) | exit 0 | exit 0 |
| `npm run lint` | exit 0, 0 warnings | exit 0, 0 warnings |
| `npm test -- --runInBand` | exit 0, 59 suites / 1205 tests, 1204 passed, 1 skipped (macOS-ACL test) | exit 0, same figures |
| `npm run test:coverage` | exit 0. All files 87.59% statements / 78.01% branches / 87.84% functions / 90.16% lines | exit 0, same figures |
| `npm run pack:smoke` | exit 0, 204 files, `"audit": "passed"` | exit 0, same figures |
| `npm run test:distribution` | exit 0, `{"distribution":"passed","version":"0.2.0","tools":18,"runtimeOnlyInstall":true}` | exit 0, same figures |
| `npm run demo:recovery` | exit 0, `DEMO 1 OK` / `DEMO 2 OK` / `DEMO 3 OK` / `ALL THREE DEMOS OK` | exit 0, same figures |

The container coverage figures are lower than the macOS host figures (87.59 / 78.01 / 87.84 / 90.16
against 87.73 / 78.13 / 88.08 / 90.33) because platform-conditional branches differ per host.
Every set clears every configured gate, and nothing here is an average across hosts.

These Linux rows are the only ones in this section measured at `90ae9a8` rather than `3a82e4f`;
no file under `src/` differs between those commits, which is why the two sets agree apart from the
platform-conditional rows. Against the previous battery at `6bc16d6`, the whole coverage delta is
one row: `src/index.ts` functions moved 0% → 16.66%, because the probe's tests reach
`CalendarCapabilityError` / `CALENDAR_WARNING_CODES` through the package entry point and so
exercise a re-export wrapper there. Every other row of the coverage table is identical, so this is
a reported change in one counter and not a general drift in the figures.

The battery above was exported from `90ae9a8`. The delivered commit is later than that export by
documentation and one test comment, and by nothing under `src/` — `git diff --stat 90ae9a8..HEAD
-- src/` is one of the mechanical checks recorded with the round. The host rows were re-measured at
the delivered commit afterwards and reproduce the same figures, so the numbers here describe the
delivered tree rather than only its export.

**What this battery found.** Before the fix, the Linux Node 20 run aborted at
`tests/write-state-security.test.ts:613`, `refuses to treat a different inode as the file it
committed`. That was a genuine product defect on Linux, not a test artifact, and it is described
in the continuation-round list above. After the fix, both Node versions complete the whole
command set with exit 0, including the three demos. The macOS host never failed this case, which
is exactly why the defect shipped.

The one skip in the container row is not a platform gap: `tests/write-state-security.test.ts:282`
is guarded to darwin because it exercises a real POSIX ACL through `/bin/chmod +a`, which Linux
does not provide. The macOS host runs it, so the ACL path is exercised on exactly one platform and
skipped on the other rather than mocked on either.

**Channel caveat.** Node in the container is the official `linux-arm64` tarball, mounted
read-only and prepended to `PATH`, on an `arm64v8/ubuntu:22.04` base image. This exercises real
POSIX semantics on a real Linux kernel, but it is neither the official `node:20` / `node:22`
image nor the CI runner image, and it must not be read as equivalent to either.

**Windows.** Not run. No Windows host or runner was available for this commit, so DACL
enforcement, atomic rename behaviour on NTFS and subprocess lock release remain unverified here.

Details, per-tool behaviour and evidence boundaries:
[docs/calendar-write-recovery.md](calendar-write-recovery.md),
[docs/calendar-api-verification.md](calendar-api-verification.md) and
[docs/calendar-write-delivery.md](calendar-write-delivery.md).

## Recorded results

This table is the standalone-refactor round (baseline `52b67cd`, 14 tools). It is a historical
record; the current tool count is 18 and the current results are in the continuation round
above.

| Check | Result |
| --- | --- |
| Pre-refactor clean install and tests | 38 suites / 831 tests passed |
| Refactored full tests with coverage | 36 suites / 789 tests passed |
| Statements / branches / functions / lines | 86.86% / 79.24% / 87.09% / 89.85% |
| Existing coverage thresholds | Preserved: 75% / 70% / 65% / 78%, all passed |
| TypeScript build | Passed, after cleaning the generated lib directory |
| Non-mutating ESLint | Passed |
| MCP compatibility | All 14 tool definitions of that baseline — names, descriptions, input schemas and annotations — match the captured fixture (that fixture now carries 18 entries) |
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

That CI run predates the continuation round. The workflow has since been extended
so the macOS and Windows jobs also run the write journal, account lock, migration,
private-state and stdio recovery suites, and so the Linux jobs also run
`npm run demo:recovery`. Both extensions have been exercised locally on macOS and,
for the Linux job, as the exact command sequence it runs — but the workflow itself
has **not** been run on any runner for any commit of this round. No push was
performed either, so no commit of the round has a CI result at all.

The last commit of the round that touched `src/` is `3a82e4f`; every commit after it
changes only `scripts/`, `tests/`, `docs/`, `README.md` or `.github/workflows/ci.yml`.
That is checked mechanically rather than asserted: `git diff --stat 3a82e4f..HEAD -- src/`
prints nothing. So the calendar read probe added in this round is a `scripts/`-side
artefact and cannot have altered the behaviour the platform section records. The Linux,
macOS and Windows platform claims in this report rest on the local and container
evidence described in the platform section above, not on CI.

Live read-only checks are available explicitly through `npm run test:integration`
using the same public client and session configuration. They are excluded from CI.
That script's default checks never touch the calendar, so authorising it alone
closes no calendar question; the calendar read is exercised only when
`GARMIN_CALENDAR_PROBE_RANGE=YYYY-MM-DD..YYYY-MM-DD` names one range, and its
fields are printed only with `GARMIN_INTEGRATION_VERBOSE=true`. With the range
unset the probe reports `skipped`, which is not a pass. The probe's outcome is
`passed`, `failed`, `refused` or `skipped`: a resolved call that carries a
read-failure warning code is `failed`, not `passed`, because the adapter resolves
on a transport failure; `refused` means the region is not queryable and nothing
was sent. `failed` and `refused` exit non-zero. The minimum
authorisation this project would need, and the `§6` question each reported field
answers, are stated in
[calendar API verification, §7](calendar-api-verification.md#7-the-minimum-read-only-authorisation-that-would-close-6).

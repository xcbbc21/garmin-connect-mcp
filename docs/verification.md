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

`3a82e4f` is the last commit of that round that touched `src/`. The round did not stop there:
later commits added tests, the calendar read probe under `scripts/` and documentation, and the
whole command set was re-measured at the round's actual final commit — see **Final-commit
re-measurement** below, which supersedes the suite, test and coverage figures in this section.
The table here is kept as the record of what was measured at `3a82e4f`, not as the current state.

At `3a82e4f`, no file under `src/` had changed since `ff128b6`: the commits in between added
documentation, `scripts/demo-write-recovery.ts` and one test file, none of which `tsconfig`
compiles (`include: ["src"]`, so `scripts/` and `tests/` are outside the build). Every number in
this section comes from a run made at `3a82e4f` rather than carried over from `ff128b6`, and it
moved by the five cases the new guard test added at that point.

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
| Linux write-state platform battery, Node 20 | `arm64v8/ubuntu:22.04` container, official linux-arm64 Node tarballs, full command set | exit 0, all eight commands. See the platform section below, which also carries the delivered commit's re-run on the official `node:20` / `node:22` images |
| Linux write-state platform battery, Node 22 | same container and channel | exit 0, all eight commands. See the platform section below |
| Windows write-state platform battery | — | **not run** — no Windows host is available here; see limitations |
| Live account integration | `npm run test:integration` | **not run** — no authorized real credentials were available; see limitations |

### Per-item status, C0–C10

Status is per item, not per round: an item is `done` only where this repository holds the code and a
test that would fail without it. Measurements live in the tables above and below; commands and
per-host results in **Platform results**, **Final-commit re-measurement** and **Recorded results**.

| Item | Status | Where it is answered |
| --- | --- | --- |
| C0 environment and reproduction baseline | done | Baseline state is recorded in this file. The clean-install question is settled on the official `node:20` / `node:22` images below: `npm ci` completed and the following `tsc` build succeeded on both, **and the platform-specific binary was inspected by name rather than inferred** — `node_modules/@esbuild/linux-arm64` is present at version `0.28.2` in both clean trees, and `node_modules/.bin/esbuild --version` prints `0.28.2` when executed inside the `linux/arm64` container (`node -p "process.platform + ' ' + process.arch"` reports `linux arm64`). The worker handshake item is `0da851b`: every unexpected exit prints captured, redacted stderr, and `error` / `close` / signal / watchdog / parent-timeout are all handled; contention tests no longer guess with a 250 ms sleep. The blocked `clean` command was solved through the approved deletion mechanism rather than by editing `scripts/clean.mjs` or by relabelling a bare `tsc` as a full build. Baseline test runs were saved before the changes. |
| C1 history hiding | done | `src/write-operations/types.ts:272` `collectBusinessHistory` reduces **all** records sharing a business key to one verdict; `first-match` and `last-match` are both provably rejected by mutation (`docs/calendar-write-delivery.md`). Preview and execute share it: the seven call sites at `coordinator.ts:767`, `:1158`, `:1405`, `:1668`, `:1682`, `:1933`, `:2156` sit inside `previewSingleStep`, `previewSchedule`, `executeSchedule` (`:1344`), `previewCreateAndSchedule` (`:1644`, twice), `executeCreateAndSchedule` (`:1880`) and `recheckBusinessKey`, so no path keeps a private priority order. Tests: `tests/write-history-regression.test.ts` 8/8. |
| C2 batch receipt completeness | done | `tests/write-batch-accounting.test.ts:116` (unknown A + new B: `total` 2, ordered results, `success=false`, counts), `:270` (five-item mixed batch), `:229` (parent operation retains the full original batch), `:159` / `:184` (all-blocked, all-skipped), `:206` (replay returns the durable receipt). |
| C3 immutability, revisions, v1 migration | done | `src/write-operations/migration.ts`; `tests/write-operation-migration.test.ts` — `:520` reads back the real file (no plaintext key, `schemaVersion` 2, unknown occupancy retained), `:553` injects `EIO` into `open` / `write` / `sync` / `rename` and the v1 file stays usable, `:162` preserves every identifier and batch position. Confirmation lifecycle `tests/write-confirmation-lifecycle.test.ts:76`, `:151`, `:202`, `:217`, `:257`. |
| C4 state hardening and the local receipt tool | done | `tests/write-state-security.test.ts` — `:144` widened mode, `:157` foreign owner, `:185` hard link, `:195` widened account dir, `:206` group-writable ancestor, `:218` / `:230` wrong entry type, `:241` / `:254` / `:268` symlinks, `:282` a **real** `chmod +a` ACL on darwin, `:513` over-cap refusal without deletion, `:583` / `:594` fsync classification, `:692` abandoned `in_flight` → honest `unknown` only under the lock, `:757` a plain read never mutates state. Lock budget and no-TTL rules: `tests/write-operation-lock.test.ts:227`, `:349`, `:365`, `:443`. Tool: `get_garmin_write_operation` in `tests/mcp.test.ts` and `tests/write-operation-query.test.ts`. |
| C5 all five write paths coordinated | done | `tests/write-path-inventory.test.ts:159` fails if any write verb is dispatched outside `mcp.ts` / `tool-service.ts` / `coordinator.ts`; `tests/write-create-recovery.test.ts:104`, `:133`, `:179`, `:221`; `tests/write-unschedule-recovery.test.ts:161`; `tests/write-batch-stop.test.ts:164`, `:238`, `:296`; `tests/write-paths.test.ts` for the runtime routing. |
| C6 evidence-backed calendar range read | done behind a capability gate | `src/calendar/{types,adapter}.ts`; `docs/calendar-api-verification.md` carries the interface evidence (§4.1 first-party implementations actually read, §6 contracts still uncertain, §7 the minimum read-only authorisation). An unevidenced region returns a capability error rather than an unverified read. Tests: `tests/calendar-query.test.ts:268` (capability gating — the one verified global read `:269`, the unverified surfaces declared unsupported `:285`, the `cn` region blocked without claiming a hostname swap works `:301`, and no empty-snapshot fallback `:327`), `tests/client.test.ts:1556` (refuses without sending). **No live observation exists in either region** — see limitations. |
| C7 fresh preflight, reconcile, approved resume | done | `src/write-operations/reconcile.ts`; `tests/write-preflight.test.ts:72`, `:82`, `:105`, `:125`, `:146`, `:176`, `:200`, `:228`, `:287`, `:305`; `tests/write-recovery.test.ts:399` (the reconciler receives a reader with no write method), `:415` (no observation kind changes a status or a POST), `:562` (nothing re-armed when everything is unresolved). |
| C8 MCP contract and real-process recovery | done | 18 tools in `tests/mcp.test.ts:14`, `idempotencyKey` through the real parameter layer `:332` / `:389`, range read `:836`, reconcile `:890`, resume `:942`; out-of-process peer `tests/fixtures/fake-garmin-server.cjs` driven by `tests/write-stdio-recovery.test.ts:250`, `:339`, `:413`, `:470`, `:564`, `:609`, `:661`. |
| C9 documentation and migration guide | done | `docs/calendar-write-recovery.md` (lifecycle, migration, offline procedure, batch results, limitations), `docs/manual.zh-CN.md:693` (the five-run walkthrough), `CHANGELOG.md`, README pair, `docs/migration.md`. Package contents are audited by `scripts/audit-package.mjs`. |
| C10 clean install, platforms, final review | **partially done** — Linux and macOS measured, Windows not executed; CI not run | Thresholds unchanged at 75 / 70 / 65 / 78 (All files 87.73 / 78.15 / 88.08 / 90.33; `src/write-operations` 86.52 / 74.39 / 87.93 / 88.79). The write-dispatch scan is pinned as `tests/write-path-inventory.test.ts:159` rather than left as a one-off grep. Independent review was performed on the diffs and tests, not on reports. The three Windows requirements the plan names are all **specified as tests that the `windows-latest` job already invokes**: real DACL (`tests/windows-private-acl.test.ts:437`), atomic rename and durability (`tests/write-operation-store.test.ts`), lock-worker spawn and exit (`tests/write-operation-lock.test.ts`), alongside `tests/write-state-security.test.ts` and `tests/write-stdio-recovery.test.ts` (`.github/workflows/ci.yml:52`, `:59`). What is missing is therefore execution evidence, not test coverage: no Windows host exists on this machine, and no CI run has happened for this round. |

### Acceptance matrix: plan §7, all sixteen rows

Every anchor below was re-read in this tree; test titles and line numbers are the ones in the
delivered tree. "Verified" means a test exists that fails when the property is removed — for the
rows changed this round that was checked by mutation, and the mutations and their hit counts are
recorded in `docs/calendar-write-delivery.md`.

| # | Scenario (plan §7 wording) | Verdict | Evidence re-read in this tree | Retained caveat |
| --- | --- | --- | --- | --- |
| 1 | 单日 A → 扩批 A+B → A 再请求 | satisfied | `tests/write-history-regression.test.ts:215` end-to-end: A accepted, batch A+B, re-preview of A is a second-call-free skip; the `not_attempted` variant `:145`, the `unknown` variant `:248` | — |
| 2 | 旧失败在前，新 unknown 在后 | satisfied | `tests/write-history-regression.test.ts:194` old `failed` in front of a new `unknown` → `blocked` / `unknown`, writer never called. Reversed insertion order is now pinned for `unknown` too, at `:313` (added in `db66d01`), next to the `succeeded` / `not_attempted` reversal at `:291` | the reversal half only covered `succeeded` / `not_attempted` until `db66d01`; that gap is what `:313` closes |
| 3 | unknown A + 新 B | satisfied | `tests/write-batch-accounting.test.ts:116` — `total=2`, results ordered A then B, `success=false`, `unknownCount=1` | — |
| 4 | prepared 同 key 确认过期 | satisfied | `tests/write-confirmation-lifecycle.test.ts:151` expired revision refused with `CONFIRMATION_STALE` and no dispatch, then a re-preview restores it; the old handle is disabled by `:76` | — |
| 5 | 不同 key / 剩余子集复用 | satisfied | `tests/write-confirmation-lifecycle.test.ts:217` asserts against the on-disk document that the first key's request, steps and binding are unchanged; `:257` a new batch key neither rewrites nor adopts the existing steps | — |
| 6 | v1 私密 key、unknown 迁移 | satisfied | `tests/write-operation-migration.test.ts:520` reads the real file back: no plaintext key, `schemaVersion` 2, unknown occupancy retained; `:553` injects failure into each of `open` / `write` / `sync` / `rename` and the v1 file remains usable | — |
| 7 | JSON 内部损坏/账号错配/非法状态 | satisfied | `tests/write-coordinator.test.ts:398` `it.each` over three corruptions (`schemaVersion: 3`, a foreign `accountKey`, an unknown step status); refusal is asserted at the **tool path** with `STATE_CORRUPT`, and the writer is still called once | — |
| 8 | 路径、owner、ACL、跨进程/同进程等待 | satisfied on POSIX and macOS; **not executed on Windows** | Path and ownership: `tests/write-state-security.test.ts:144`, `:157`, `:185`, `:195`, `:206`, `:218`, `:230`, `:241`, `:254`, `:268`. Real macOS ACL: `:282`. Cross-process exclusion: `tests/write-operation-lock.test.ts:191`; bounded wait `:227`; no TTL preemption `:349`; non-owner cannot release `:365`; same-process wait `:443` | the Windows half of this scenario is **specified but never executed**. Correcting an earlier, too-generous caveat in this file: it does *not* rest on adapter-contract coverage alone. `tests/windows-private-acl.test.ts:437`–`:494` is a real-host integration test — guarded by `process.platform !== 'win32'`, driving the shipping `execFile` adapter against the real PowerShell DACL script with a 240 s budget — and the `windows-latest` CI job runs that whole file (`.github/workflows/ci.yml:40-41`, `:52`). So the tests exist and are wired; no Windows host was available and CI has not run for this round, which is why no real DACL, atomic-rename or lock-worker result exists. `tests/windows-acl-adapter.test.ts` (`jest.mock('node:child_process')`, executed on macOS) is contract-level only and is not a substitute. The foreign-owner case is staged by injecting `lstat` because this host cannot create a file owned by another user (`write-state-security.test.ts:157`) |
| 9 | 创建并排期重启恢复 | satisfied | `tests/write-create-recovery.test.ts:104` a fresh service over the same state directory never re-dispatches `addWorkout`; `:179` the combined tool does not re-create the template; `tests/write-recovery.test.ts:633` a lost create response becomes `manualReviewRequired` and is never re-created | "restart" here is a new service instance over the same state directory with mocks; the process-level version is rows 14–15 |
| 10 | 取消超时 | satisfied | `tests/write-unschedule-recovery.test.ts:161` dispatched-and-lost `unschedule` stays `unknown`, retry is blocked, `unschedule` called once; `tests/write-recovery.test.ts:657` and `:692` refuse to call a schedule-id-only absence proof "already removed"; `:415` no observation kind changes a status | half of the "read-only" claim is a source-text assertion (`tests/write-recovery.test.ts:399` scans the reconcile module for dispatch calls) rather than a behavioural one, and a per-id absence proof is refused outright, so there is no "checked, then removed" path to exercise |
| 11 | 批次认证失效/取消/授权到期 | satisfied | `tests/write-batch-stop.test.ts:296` authority lost mid-batch → `unknown` + `manualReviewRequired`, the rest `not_attempted`, counts 1 / 1 / 1, writer called exactly twice; `:164` local cancel; `:238` expiry mid-batch | the stop conditions are driven by injected store / lock / clock (`ScriptedStore`, `ControllableLock`); the credential failure is a thrown mock, not an observed 401 |
| 12 | 初次/确认时预检不完整 | satisfied | `tests/write-preflight.test.ts:146` no verified read → `blocked`, no write; `:176` an incomplete read blocks while a positive sighting is still accepted; `:305` a read failure at confirm time is `not_attempted` | the calendar is a fake adapter and "incomplete" is synthesised, not observed on a real response |
| 13 | GET 空后迟到出现 | satisfied under both readings | preview-empty-then-present: `tests/write-preflight.test.ts:200` and `:287` (no POST, twice over); late sighting after an uncertain step: `tests/write-recovery.test.ts:241` and `:793` | the scenario wording admits two readings — both are covered, and neither uses a real delayed arrival; the test adds the entry |
| 14 | 两个真实 MCP 进程 | satisfied | `tests/write-stdio-recovery.test.ts:413` two real stdio children race one target → exactly one POST, the loser gets `CONFIRMATION_STALE`; `:339` POSTs accumulate in one peer across two independent processes | the counter lives in `tests/fixtures/fake-garmin-server.cjs`: a real out-of-process peer, but not Garmin |
| 15 | 进程强杀四个时点 | satisfied | `tests/write-stdio-recovery.test.ts:470` before first dispatch (and the target stays blocked after restart), `:564` after dispatch before the response, `:609` provider answered before the receipt landed, `:661` mid-batch; the death is a real `SIGKILL` | the peer is still the fake; the four points are the implementation's own `FAKE_GARMIN_EXIT_*` hooks rather than a list named by the plan; and the offline lock removal the recovery needs is performed by the test, not by the product |
| 16 | 全量与产物 | **partial** | 18 tools: `tests/mcp.test.ts:14` asserts `listTools()` equals `tests/fixtures/mcp-tools-baseline.json` (18 entries), `tests/stdio-protocol.test.ts:208` and `:308` pin the literal `toHaveLength(18)` over the wire protocol so drift is caught without the fixture, and `scripts/verify-distribution.mjs:64` reports `tools: 18`. No private files: the forbidden-content rule at `scripts/audit-package.mjs:34` now carries negative and positive controls — 16 known-private shapes that must be rejected, 9 shipped shapes that must be accepted — and every passing run prints `privateFileControl: "passed"` beside `"audit": "passed"`; mutation-proved in `1875572` (regex replaced by `/^$/` makes `npm run pack:smoke` exit 1, "Private-file detector lost its teeth: node_modules/zod/index.js") | the verdict stays partial for exactly one reason: "三平台证据明确" is unmet — macOS is measured on the host, Linux is a container, and the Windows job has never run. Two sub-clauses also lack a *jest* product: the tool-count equality is asserted against an in-repository fixture, and "the standard commands really pass" is runner evidence by nature, not a unit test. The private-file clause being a package script rather than a jest test follows this repository's own convention for packaging checks (`scripts/clean.mjs`, `scripts/verify-distribution.mjs`); what changed in `1875572` is that it is no longer a pass-path-only assertion |

### Final-commit re-measurement

The round's last commit that touches `src/`, `tests/` or `scripts/` is `1875572`; every commit after
it is documentation-only. The figures below were therefore measured on a tree whose compiled and
tested content is `1875572`'s, and they still describe the delivered code because later commits
cannot change it: `git diff --stat 1875572..HEAD -- src tests scripts package.json jest.config.js
tsconfig.json` prints nothing, which is what makes that statement checkable rather than asserted.
(Naming a "delivered commit" sha in prose would go stale as soon as another documentation commit
lands, so this file pins the tree instead.) They were measured on
this machine (macOS arm64, Node v25.2.1, npm 11.19.0) after every source and test change of the
round had landed. Nothing here is carried over from `3a82e4f`.

| Check | Command | Result at the delivered commit |
| --- | --- | --- |
| Type check | `npx tsc --noEmit` | exit 0 |
| Lint | `npx eslint src tests scripts --max-warnings 0` | exit 0, 0 warnings |
| Full suite | `npm test -- --runInBand` | exit 0, 59 suites / 1215 tests, **1215 passed, 0 skipped** |
| Coverage with all gates | `npm run test:coverage` | exit 0. All files 87.73% statements / 78.15% branches / 88.08% functions / 90.33% lines; `src/write-operations` 86.52 / 74.39 / 87.93 / 88.79; `src/calendar` 96.69 / 93.42 / 97.50 / 98.06; `windows-private-acl.ts` 100 / 100 / 100 / 100. Gates 75/70/65/78 |
| Packaged build | `npm run build` (`clean` + `tsc`) | exit 0 |
| Package content audit | `npm run pack:smoke` | exit 0, 204 files, `"privateFileControl": "passed"`, `"audit": "passed"` |
| Runtime-only distribution install | `npm run test:distribution` | exit 0, `{"distribution":"passed","version":"0.2.0","tools":18,"runtimeOnlyInstall":true}` |
| Three required demos, end to end | `npm run demo:recovery` | exit 0, `DEMO 1 OK` / `DEMO 2 OK` / `DEMO 3 OK` / `ALL THREE DEMOS OK` |

The suite grew from the 1205 tests the platform section records at the probe-repair commit to
1215. Exactly ten `it` cases were added after `90ae9a8`, and `90ae9a8`, `67ec561` and `458e8d2` add
none of them relative to each other, so the count is the same whichever of those three the earlier
figure was taken at: three shapes in the `it.each` trio that refuses the next write at the tool
path for a corrupted journal, the reversed-order history case, and six new cross-process lock
cases (that suite went from 14 to 20 tests). Coverage is unchanged to every recorded decimal
because no file under `src/` has changed since `3a82e4f` and no added case reaches a source line
that was not already covered — a reported absence of movement, not a re-quoted figure. That claim
is mechanical: `git diff --stat 3a82e4f..HEAD -- src/` prints nothing.

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
- **An untrustworthy journal stops the write before dispatch, proven through the tool path and
  not only at the store.** The store-level cases assert that `read()` refuses; the property that
  actually protects the calendar is that the *tool* call refuses and sends nothing. Three shapes
  are covered end to end in `tests/write-coordinator.test.ts`: an unsupported `schemaVersion`, an
  `accountKey` that is not this account, and a step `status` outside the enum. Each case performs
  one real successful write first (so the journal holds a step worth corrupting and the writer
  call count has a baseline), corrupts the journal **on disk at the path the service itself
  derived** — no injected store, no mock — then calls `scheduleWorkout` for a *different* target
  and asserts a `STATE_CORRUPT` rejection, an unchanged writer call count, and that the journal
  was not silently repaired out from under the refusal. All three shapes were mutation-proved and
  reverted: silently returning an empty document for an unknown version failed the schema case
  only, tolerating an account mismatch failed the account case only, and dropping the status enum
  failed the status case only — one mutation each, no cross-contamination — after which `src/`
  returned byte-identical (`migration.ts` sha256 `7f1fc274…`).
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
- **The cross-process lock tests synchronise on a handshake, and a worker that dies is reported
  rather than mistaken for a finished run.** The plan asks the lock-contention tests to wait for a
  `ready` handshake instead of guessing from a fixed delay, and to surface any unexpected worker
  exit with the captured, redacted stderr. `tests/fixtures/write-lock-worker.ts` now reports
  `ready` after argument parsing and before the lock is contended, `start` from inside the
  critical section, then `end` or `busy`, plus `error`, `signal` and `timeout` for abnormal
  endings; the parent's `waitForEvent` polls that log while watching the child, so a child that
  exits early, exits non-zero or never reports fails the test instead of hanging until the suite
  timeout. `start` is the stronger of the two conditions because it can only be written while the
  lock is held, and one case asserts the per-`pid` order `ready` before `start`, so the handshake
  cannot quietly degrade into an event that always fires. The previous
  `await new Promise(resolve => setTimeout(resolve, 250))` in the `OPERATION_BUSY` case is gone.
  Diagnostics are redacted through the production `redactSensitiveText`
  (`src/utils/errors.ts:73`) rather than a second, weaker implementation, and are written to both
  `events.jsonl` and fd 2 with `writeSync`, because a process that is about to die cannot be
  relied on to flush a buffered stream. The worker echoes its own argv into that diagnostic, which
  is what makes the redaction falsifiable: the test supplies a `Bearer` token as the account and
  asserts the literal appears in neither stderr nor the event log. Error, close, signal and
  timeout are funnelled into a single rejection, and the worker carries a watchdog
  (`GARMIN_LOCK_WORKER_WATCHDOG_MS`) plus `SIGINT`/`SIGTERM`/`SIGHUP` and
  uncaught-exception/unhandled-rejection handlers. Seven cases were added; the suite is 20 tests
  and passes. Three mutation proofs were run and reverted: moving `ready` after `start` fails two
  cases, dropping the redaction fails exactly the redaction case, and letting the handshake read
  an early non-zero exit as success fails exactly the handshake case. Both files returned
  byte-identical afterwards — `tests/fixtures/write-lock-worker.ts` sha256 `fb1ace52…`,
  `tests/write-operation-lock.test.ts` `eec6ef21…`.
- **The journal history verdict is pinned for both insertion orders, not only the one that
  happens to be scanned first.** The journal is consulted by reducing *all* records that share a
  business key instead of taking the first hit, because object iteration order is insertion order
  and is not a statement about which record is newest. The suite already covered a permissive
  record in front of a newer `unknown` / `succeeded` / `in_flight`, and had one reversed case, but
  that reversed case used `succeeded` / `not_attempted` only — so the reversed combination with an
  `unknown` step, which is the ordering a *last*-match scan gets wrong, had no case of its own.
  It does now, in `tests/write-history-regression.test.ts`, and the two orderings together pin the
  verdict in both directions. Three mutation proofs against `collectBusinessHistory`
  (`src/write-operations/types.ts`), each reverted: first-match over iteration order fails the
  five permissive-first cases and passes both reversed ones; last-match fails the two reversed
  ones; and a "satisfied is sticky but blocking is clearable" reduction — a later permissive
  record treated as superseding the earlier uncertainty — fails **only** the new case,
  1 failed / 7 passed. That last result is what shows the gap was previously unguarded rather than
  merely restated. `src/write-operations/types.ts` returned byte-identical (`d11d8aa6…`).
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
- **Linux is verified in a container, not on the CI runner.** Both Node 20 and Node 22 pass the
  full command set on a real Linux/aarch64 kernel, libc and filesystem, and the delivered commit
  was re-run on the **official `node:20` and `node:22` images** (see the platform section below),
  so the earlier objection about a hand-mounted tarball no longer applies to it. What still
  differs from CI is the runner: an arm64 Docker Desktop container on macOS rather than a
  GitHub-hosted `ubuntu-latest` x64 VM. The results are therefore not interchangeable with a CI
  job, and no CI job has run for this round.
- **CI has no result for this round.** No commit of this round has been pushed — `git rev-list
  --count origin/main..HEAD` returns 30 (`origin/main` is still `a527c7e`) — so the Linux, macOS and
  Windows jobs all lack a run. Nothing in this file should be read as a green pipeline.
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
86.52% / 74.39% / 87.93% / 88.79%. The same host was re-measured at the delivered commit
after the round's six additional lock cases, the reversed-order history case and the
tool-path corruption trio landed: **59 suites / 1215 tests, 1215 passed, 0 skipped**, with
the coverage figures above reproducing to every recorded decimal (see **Final-commit
re-measurement**). The 12-suite cross-platform set was additionally
run in two batches at `3a82e4f`; both exited 0: 6 suites / 55 tests, then
6 suites / 134 tests — 12 suites / 189 tests in total. The second batch is one test
larger than the pre-fix count because the inode-reuse regression test was added.

### Linux, probe-repair commit `90ae9a8`

**Channel: mounted Node tarball on `arm64v8/ubuntu:22.04`, kernel `6.12.76-linuxkit`, Ubuntu 22.04.5 LTS.**
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

The rows in the table directly above are the ones measured at `90ae9a8` rather than at `3a82e4f` or
`73e16a2`; no file under `src/` differs between `90ae9a8` and `3a82e4f`, which is why those two sets
agree apart from the platform-conditional rows. Against the previous battery at `6bc16d6`, the whole
coverage delta is one row: `src/index.ts` functions moved 0% → 16.66%, because the probe's tests
reach `CalendarCapabilityError` / `CALENDAR_WARNING_CODES` through the package entry point and so
exercise a re-export wrapper there. Every other row of the coverage table is identical, so this is a
reported change in one counter and not a general drift in the figures.

The battery above was exported from `90ae9a8`. The delivered code tree is later than that export only
by the test cases listed earlier and one test comment, and by nothing under `src/` —
`git diff --stat 90ae9a8..HEAD -- src/` is one of the mechanical checks recorded with the round.

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

### Linux, official `node:20` / `node:22` images on the delivered tree (`73e16a2`)

This run replaces the tarball channel described above with the **official `node:20` / `node:22`
images pulled from Docker Hub** (`node@sha256:8f693eaa7e0a…` and `node@sha256:8a34c4ab3ea2…`,
`linux/arm64`, Debian GNU/Linux 12 "bookworm"), which is a materially closer analogue of the
`ubuntu-latest` + `actions/setup-node` runner the CI matrix uses. The tree came from
`git archive 73e16a2` — no `node_modules`, no `.git` — so `npm ci` is again a genuine clean
install, and the two Node versions ran serially. The step list mirrors `.github/workflows/ci.yml`
and adds an explicit `npm run build`.

| Command | Node v20.20.2 / npm 10.8.2 | Node v22.23.2 / npm 10.9.8 |
| --- | --- | --- |
| `npm ci` | exit 0 | exit 0 |
| `npm run build` (`clean` + `tsc`) | exit 0 | exit 0 |
| `npm run lint` | exit 0, 0 warnings | exit 0, 0 warnings |
| `npm test -- --runInBand` | exit 0, 59 suites / 1215 tests, 1214 passed, 1 skipped (macOS-ACL test) | exit 0, same figures |
| `npm run test:coverage` | exit 0. All files 87.59% / 78.01% / 87.84% / 90.16%; `src/write-operations` 86.52% / 74.28% / 87.93% / 88.79% | exit 0, same figures |
| `npm run pack:smoke` | exit 0, 204 files, `"audit": "passed"` | exit 0, same figures |
| `npm run test:distribution` | exit 0, `{"distribution":"passed","version":"0.2.0","tools":18,"runtimeOnlyInstall":true}` | exit 0, same figures |
| `npm run demo:recovery` | exit 0, `DEMO 1 OK` / `DEMO 2 OK` / `DEMO 3 OK` / `ALL THREE DEMOS OK` | exit 0, same figures |

Both Node versions produce **identical** figures, including the 1215-test count, so the delivered
commit's Linux result does not depend on the Node minor in the matrix. Against the `90ae9a8`
battery the coverage percentages are unchanged to two decimals on every row; the test count is 10
higher, which is exactly the 3 corrupted-journal tool-path cases, the reversed-order history case
and the 6 lock cases added after that export. `src/write-operations` branches are 74.28 here
against 74.39 on the macOS host — one platform-conditional branch, and every counter still clears
every configured gate (75 / 70 / 65 / 78).

Logs: `/tmp/c27-linux-node20.log`, `/tmp/c27-linux-node22.log`; driver `/tmp/c27-linux.sh`
(`COMMIT=73e16a2`).

**Channel caveat, corrected.** The earlier caveat — that the container was neither the official
`node:20` / `node:22` image nor the CI runner image — applies to the `90ae9a8` battery, not to
this one. This run **is** on the official Node images, which removes that objection for the
delivered commit. What still differs from CI is the runner: an arm64 Docker Desktop container on
macOS, not a GitHub-hosted `ubuntu-latest` x64 VM, with no `actions/setup-node` cache restore and
no checkout action. Those rows are still not evidence of a green CI run; CI has not run for any
commit in this round (see the end of this section).

**CI.** Not run for this round. No commit of this round has been pushed (`git rev-list --count
origin/main..HEAD` = 30, against `origin/main` = `a527c7e`), so no GitHub Actions run exists for any
of them: the Linux Node 20/22 build-and-test jobs,
both `platform-runtime` jobs (macOS and Windows) and their packed-runtime install step all have no
result. The Linux rows above are local container runs on this machine, not CI jobs, and must not be
read as a green pipeline. Pushing to trigger CI is a separate decision that has not been taken.

**Windows.** Not run. No Windows host or runner was available for this commit, and the Windows CI
job has no result either, so real DACL enforcement, atomic rename behaviour on NTFS and subprocess
lock-worker spawn and exit remain unverified on Windows. It matters that this is stated precisely,
because two different kinds of coverage exist here and only one of them is Windows evidence:

- `tests/windows-acl-adapter.test.ts` is **adapter-contract** coverage. It drives the ACL adapter
  with `jest.mock('node:child_process')`, so it asserts which commands and validation the adapter
  builds and how it reacts to their outputs. It executes no real PowerShell/.NET call, no real
  DACL, and no Windows filesystem operation, and it runs on macOS. It is not DACL verification.
- `tests/write-operation-lock.test.ts`, `tests/write-state-security.test.ts` and the stdio suites
  spawn **real** child processes against the **real** filesystem, but they have only ever run on
  macOS and Linux.

`windows-private-acl.ts:332` also has one permanently uncovered branch: the default value of
`windowsCommandOptions`'s `allowMissing` parameter has no call path that takes the default, so it
cannot be reached by any current test. That is recorded in the commit message for the round rather
than papered over with a call added only to cover it.

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

# Release Test Report

[简体中文](./TEST_REPORT.zh-CN.md)

This page is the static verification snapshot for the current `Unreleased`
changes on top of the `0.1.5` package manifest. It records what was tested,
what was deliberately excluded, and which gaps still require manual
verification.

> **Verification scope:** the automated checks below were rerun on the local
> source tree. The new system-browser and MCP authentication paths are covered
> offline, but real-account China and International MFA remain preview features
> until their complete browser-to-refresh chains are manually verified.

## Snapshot

| Item | Result |
| --- | --- |
| Test date | 2026-08-28 |
| Package manifest | `0.1.5` + `Unreleased` changes |
| Release readiness | **Automated gates passed** — real-account MFA E2E remains preview-only |
| Local automated snapshot | **Passed** — 36 suites, 736 tests |
| TypeScript build | **Passed** |
| npm package smoke test | **Passed** — 163 files; 281.6 kB packed; 1.1 MB unpacked |
| Real Garmin integration | **Not rerun** — prior 2026-08-21 `global` read-only baseline was 8/8 |
| Two-step verification | **Preview** — offline runtime/broker/MCP coverage passed; real CN/global E2E pending |

## Automated verification

The automated checks can be reproduced with Node.js 20 or newer:

```bash
npm ci
npm run test:coverage
npm run build
npm run pack:smoke
```

### Test and coverage results

| Metric | Result |
| --- | ---: |
| Test suites | 36 passed |
| Tests | 736 passed |
| Statements | 85.56% |
| Branches | 79.32% |
| Functions | 87.04% |
| Lines | 88.45% |

`npm run build` completed successfully. `npm run pack:smoke` also completed
successfully and inspected a tarball containing 163 files, including the new
local-auth and MCP-auth runtime modules, changelog, and both test-report pages,
with a packed size of 281.6 kB and an unpacked size of 1.1 MB.

The suite also covers an absolute, bounded, shell-free Windows PowerShell/.NET
ACL boundary, a static encoded exact-DACL program, current-SID ownership,
full-chain reparse-point and untrusted-root rejection, per-component fail-closed
directory verification/creation, and the requirement to secure the empty temporary file before
writing credential bytes. A `windows-latest` CI job now runs that suite against
the real Windows ACL API; that remote job was not executed as part of this local
snapshot.

POSIX coverage includes effective-UID ownership and owner write/execute checks,
unsafe ancestor rejection, safe-link canonicalization, one-component-at-a-time
`0700` preflight creation, no-follow temporary-file creation, and parent/file
revalidation immediately before atomic replacement. Reads canonicalize a safe
parent alias and verify the complete ancestor chain plus private final parent
before and after binding the opened file descriptor. On macOS, the local suite
also exercised real inherited and file-level extended ACL grants; granting
entries are rejected even when mode bits are `0700`/`0600`, while deny-only
system ACLs remain valid. A `macos-latest` CI job repeats these Darwin checks.

Authentication coverage also includes shared destination preflight before any
Web/CLI/MCP bridge starts, content-fingerprinted hot loading of a session written
by another local process, pinned-SDK MFA/ticket failure conversion, abortable
terminal prompts, non-zero system-browser launcher exits, bounded MCP completion
notifications, and commit-point draining so an in-progress atomic save is never
misreported as cancelled. It also covers Web disposal during an irrevocable
write, non-stacking broker/controller drain deadlines, rejected inline-token
replacement only by an account-bound session, and MCP stdin/signal shutdown
that keeps termination handlers active until bounded credential cleanup ends.
CLI browser, canary, and `serve` shutdown also gives the first signal a bounded
graceful window and treats a second signal as an immediate force-exit request.

## Real Garmin read-only integration

Real Garmin integration was not rerun for this snapshot. The table below is the
historical read-only `0.1.5` baseline from 2026-08-21, which used a privately
configured `.env` and the Garmin `global` region:

```bash
GARMIN_INTEGRATION_VERBOSE=false npm run test:integration
```

The following 8 checks passed:

| Check | Result |
| --- | --- |
| Authentication / password login | Passed |
| Activities | Passed |
| Sleep | Passed |
| Steps | Passed |
| Heart rate | Passed |
| Weight / body composition | Passed |
| Workout library | Passed |
| User profile | Passed |

That earlier run was strictly read-only. It did not create, update, schedule, or delete
workouts or other Garmin data. Verbose output was explicitly disabled, so the
run printed only status/count information rather than account identifiers,
activity details, or health values.

## China-region browser MFA / DI partial verification

With the account owner's explicit consent, a visible Chrome session completed
the Garmin-hosted China-region login and produced one short-lived service
ticket on 2026-08-21. A guarded diagnostic separately exchanged a one-time
ticket at the China-region DI endpoint and successfully probed the China-region
profile API. Only fixed stage names were reported; no email, password, MFA code,
cookie, ticket, token, profile data, or response body was printed.

This remains partial real-account evidence, not a passing end-to-end result for
the new flow. The current implementation now has automated coverage for the
shared loopback runtime, ticket exchange, explicit profile confirmation,
owner-only session commit, shell-free system-browser launcher, terminal
cleanup, typed missing/expired/rejected credential states, MCP URL elicitation,
completion notification, concurrent-flow sharing, and same-process session
replacement. Those tests use controlled fixtures and mocked Garmin DI HTTP;
they do not replace a real CN and global MFA run.

## FIT export verification

No real FIT file was downloaded during this verification run. This avoids
writing personal activity files to the host without explicit user consent.

Automated tests cover the FIT destination rules, ZIP handling, CRC validation,
and safe extraction behavior. New exports use the following layout:

```text
<GARMIN_FIT_DOWNLOAD_DIR>/
  GARMIN_FIT_<cn|global>_<normalized-email>/
    <activityId>.fit
```

Existing `GARMIN_FIT_<email>` directories are **not** migrated automatically.
Old files remain in their original directory; only new downloads use the
region-qualified `GARMIN_FIT_<cn|global>_<normalized-email>` directory.

Because a real export was not performed, this report does not claim end-to-end
validation of Garmin archive download, creation of a local `.fit` file, or
import of that file into a device or third-party application.

## Known verification gaps

The following scenarios were not validated end to end with real accounts or
clients:

- Running `garmin-connect-auth serve` end to end with real China-region and
  International-region MFA accounts, then consuming and refreshing each saved
  session through dsh and MCP.
- Exercising MCP URL elicitation and completion/retry in Codex, Claude Code,
  and other concrete clients; capability fallback is covered only offline.
- Running the new Windows ACL smoke test on a real `windows-latest` runner; the
  workflow is present, but this local macOS snapshot cannot execute it.
- WorkBuddy MCP client smoke testing.
- ZCode MCP client smoke testing.
- A real FIT download and subsequent file import.

These are documented limitations of this snapshot, not passing test results.

## Privacy and publication notes

- The private `.env` used for integration testing is not part of this report
  and must not be committed or published.
- No password, session token, MFA code, account identifier, local destination
  path, activity detail, or health value is included here.
- No Garmin data write operation or real browser authentication was performed
  for this 2026-08-28 snapshot. Session persistence was exercised only with
  synthetic credentials in isolated temporary/test locations.
- The package manifest remains `0.1.5`; the new authentication work is recorded
  under `Unreleased` and has not been published by this verification run.

Future release candidates should rerun the automated commands above. Real MFA,
FIT, and client smoke tests should be added only with the account owner's
explicit consent and with the same privacy safeguards.

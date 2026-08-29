# Release Test Report

[简体中文](./TEST_REPORT.zh-CN.md)

This page is the static verification snapshot for the current `Unreleased`
changes on top of the `0.1.5` package manifest. It records what was tested,
what was deliberately excluded, and which gaps still require manual
verification.

> **Verification scope:** the automated checks below were rerun on the local
> source tree. The new system-browser and MCP authentication paths are covered
> offline. A real China-region MFA browser-to-session-and-read chain also passed
> locally on 2026-08-29. International-region MFA, real refresh-token rotation,
> and concrete MCP-client URL elicitation remain preview gaps.

## Snapshot

| Item | Result |
| --- | --- |
| Test date | 2026-08-29 |
| Package manifest | `0.1.5` + `Unreleased` changes |
| Release readiness | **Automated gates passed** — browser MFA remains experimental while International/refresh/client gaps remain |
| Local automated snapshot | **Passed** — 38 suites, 802 tests |
| TypeScript build | **Passed** |
| npm package smoke test | **Passed** — 169 files; 288.7 kB packed; 1.2 MB unpacked |
| Real Garmin integration | **Not rerun** — prior 2026-08-21 `global` read-only baseline was 8/8 |
| Two-step verification | **Preview** — real CN browser/session/profile/activity-read chain passed; International and real refresh pending |

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
| Test suites | 38 passed |
| Tests | 802 passed |
| Statements | 85.79% |
| Branches | 79.61% |
| Functions | 87.36% |
| Lines | 88.61% |

`npm run build` completed successfully. `npm run pack:smoke` also completed
successfully and inspected a tarball containing 169 files, including the new
local-auth and MCP-auth runtime modules, changelog, and both test-report pages,
with a packed size of 288.7 kB and an unpacked size of 1.2 MB.

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
by another local process, positive MFA/CAPTCHA page classification without
misclassifying ambiguous SDK no-ticket/password/network failures, abortable
terminal prompts, non-zero system-browser launcher exits, bounded MCP completion
notifications, and commit-point draining so an in-progress atomic save is never
misreported as cancelled. It also covers Web disposal during an irrevocable
write, non-stacking broker/controller drain deadlines, rejected inline-token
replacement only by an account-bound session, and MCP stdin/signal shutdown
that keeps termination handlers active until bounded credential cleanup ends.
CLI browser, canary, and `serve` shutdown also gives the first signal a bounded
graceful window and treats a second signal as an immediate force-exit request.
The local dsh client also covers one-shot automatic opening per coarse Host
requirement revision, while terminal login covers blank-password and explicit
browser-challenge handoff to the shared system-browser broker.
The browser flow now has an exact 10-minute lifetime. Tests preserve a ticket's
validated service through bridge message, server submission, flow management,
and DI form encoding; only the region's fixed embed service or the current exact
`http://127.0.0.1:<port>` bridge origin is accepted. Wrong regions, other hosts
or ports, paths, queries, fragments, credentials, malformed variants, and
service fallback/retry are rejected before a DI request.

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

## China-region browser MFA / DI verification

With the account owner's explicit consent, a visible browser completed the
Garmin-hosted China-region password and MFA challenge on 2026-08-29. Garmin
bound the one-time service ticket to that flow's exact ephemeral loopback
origin. The shared local runtime preserved the ticket/service pair, completed
the China-region DI exchange, displayed a sanitized profile for confirmation,
and atomically persisted an account- and region-bound owner-only DI v2 session.

The saved file was verified as a regular, non-symlink file owned by the current
user with mode `0600`, one link, schema version 2, CN region binding, unexpired
access and refresh credentials, and successful acceptance by the private
session reader. A fresh read-only Garmin client then consumed that file,
verified the account identity, passed the profile probe, and read recent
activities. Same-process hot loading without restart is covered by automated
tests, not claimed as part of this real-account run.

Only fixed stage/result names were reported. No email, password, MFA code,
cookie, ticket, token, profile payload, activity details, response body, or
local session path is included here. This proves the real China-region
browser-to-session-and-read chain, but not International-region MFA, actual
refresh-token rotation, or a concrete MCP client's URL-elicitation UI.

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

- Running the browser flow with a real International-region MFA account.
- Exercising actual access/refresh-token rotation on a browser-created session;
  refresh behavior is covered by automated fixtures but was not forced against
  the real account.
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
- No Garmin data write operation was performed. The authorized real China-region
  browser authentication wrote one private local session and was followed only
  by profile and recent-activity reads; no private value or destination is
  recorded in this report.
- The package manifest remains `0.1.5`; the new authentication work is recorded
  under `Unreleased` and has not been published by this verification run.

Future release candidates should rerun the automated commands above.
International MFA, real refresh rotation, FIT, and client smoke tests should be
added only with the account owner's explicit consent and the same privacy
safeguards.

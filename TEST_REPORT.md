# Release Test Report

> Historical upstream 0.1.6 snapshot. Not a verification report for 0.2.0.
> Current refactor results: [docs/verification.md](docs/verification.md).

[简体中文](./TEST_REPORT.zh-CN.md)

This page is the static verification snapshot for the `0.1.6` release. It
records what was tested,
what was deliberately excluded, and which gaps still require manual
verification.

> **Verification scope:** the automated checks below were rerun on the local
> source tree. The new system-browser and MCP authentication paths are covered
> offline. A real China-region MFA browser-to-session-and-read chain also passed
> locally on 2026-08-29. A real International-region system-browser MFA, DI
> exchange, profile confirmation, and private session write also passed. Real
> refresh-token rotation and first-class MCP-client authentication UX remain
> compatibility-test gaps. Codex CLI
> `0.147.0` reached the URL-elicitation response in real stdio tool diagnostics;
> it did not present that URL as a first-class authentication prompt.

## Snapshot

| Item | Result |
| --- | --- |
| Test date | 2026-08-29 |
| Package manifest | `0.1.6` |
| Release readiness | **Automated gates passed** — browser MFA is supported for China and International accounts; refresh/client compatibility coverage continues |
| Local automated snapshot | **Passed** — 38 suites, 824 tests |
| TypeScript build | **Passed** |
| npm package smoke test | **Passed** — 179 files; 299.5 kB packed; 1.2 MB unpacked |
| Remote CI | Publication-gated — Linux Node 20/22, Windows ACL, and macOS ACL jobs must all pass for this commit |
| Real Garmin integration | **Not rerun** — prior 2026-08-21 `global` read-only baseline was 8/8 |
| Two-step verification | **Supported** — real CN browser/session/profile/activity-read chain and real International system-browser MFA/DI/session persistence passed |

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
| Tests | 824 passed |
| Statements | 85.91% |
| Branches | 79.53% |
| Functions | 87.42% |
| Lines | 88.83% |

`npm run build` completed successfully. `npm run pack:smoke` also completed
successfully and inspected a tarball containing 179 files, including the new
local-auth and MCP-auth runtime modules, changelog, and both test-report pages,
with a packed size of 299.5 kB and an unpacked size of 1.2 MB.

The suite also covers an absolute, bounded, shell-free Windows PowerShell/.NET
ACL boundary, a static encoded exact-DACL program, current-SID ownership,
full-chain reparse-point and untrusted-root rejection, per-component fail-closed
directory verification/creation, and the requirement to secure the empty temporary file before
writing credential bytes. A `windows-latest` CI job runs that suite against
the real Windows ACL API, and publication is gated on that job passing for
the release commit.

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
misclassifying ambiguous SDK no-ticket/password/network failures, narrowly
scoped Cloudflare managed-challenge detection, abortable terminal prompts,
abortable SSO requests, credential-submission dwell time, and custom MFA
prompts, non-zero system-browser launcher exits, bounded MCP completion
notifications, and commit-point draining so an in-progress atomic save is never
misreported as cancelled. It also covers Web disposal during an irrevocable
write, non-stacking broker/controller drain deadlines, rejected inline-token
replacement only by an account-bound session, and MCP stdin/signal shutdown
that keeps termination handlers active until bounded credential cleanup ends.
CLI browser, normal `login`, canary, and `serve` shutdown also gives the first signal a bounded
graceful window and treats a second signal as an immediate force-exit request.
The local dsh client also covers one-shot automatic opening per coarse Host
requirement revision and serialized account polling that does not starve slow
RPCs, while terminal login covers blank-password and explicit browser-challenge
handoff to the shared system-browser broker.
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
browser-to-session-and-read chain, but not actual refresh-token rotation or a
concrete MCP client's URL-elicitation UI.

## International-region browser MFA / DI verification

With the account owner's explicit consent, the installed `0.1.6-rc.1` CLI opened
Garmin's International-region authentication in the system browser on
2026-08-29. The account completed Garmin-hosted password and MFA verification;
the local runtime then completed the global DI exchange, confirmed the profile,
and persisted the account- and region-bound session.

The saved artifact was checked without printing its contents: it is a regular,
non-symlink file owned by the current user with mode `0600`, passes the private
session reader, carries the `global` region binding, and matches the configured
normalized account identifier. No email, password, MFA code, ticket, token,
profile payload, or private path is recorded here. Together with shared-runtime
automated coverage, this validates supported browser MFA in both Garmin regions.

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

- Exercising actual access/refresh-token rotation on a browser-created session;
  refresh behavior is covered by automated fixtures but was not forced against
  the real account.
- Completing MCP browser authentication and completion/retry in a concrete
  client. Codex CLI `0.147.0` completed stdio initialization and received the
  `-32042` URL-elicitation response, but exposed its URL only in raw tool
  diagnostics rather than a first-class prompt; Claude Code and ZCode remain
  untested.
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
  by profile and recent-activity reads. The authorized International-region run
  wrote a separate private session. No private value or destination is recorded
  in this report.
- The package manifest is `0.1.6`; this snapshot verifies the final release.

Future releases should rerun the automated commands above. Real
refresh rotation, FIT, and client smoke tests should be added only with the
account owner's explicit consent and the same privacy safeguards.

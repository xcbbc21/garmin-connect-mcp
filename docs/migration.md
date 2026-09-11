# Migration to standalone MCP 0.2.0

## Existing MCP users

The server name `garmin-connect-mcp`, entry file `lib/mcp.js`, authentication command `garmin-connect-auth`, 14 tools and their complete input schemas remain compatible with baseline `52b67cd`.

Update this checkout and run `npm ci`, then restart the client. Use the same GARMIN_* configuration, alias and session destination. Session formats and default paths have not changed in this refactor; no copying, deletion or re-login is required solely because of this upgrade. Pending confirmations are process-local and expire on restart.

## Calendar write safety changes (0.2.0 -> current)

No tool was renamed, no required parameter changed, and no success field was removed. The
changes below tighten scheduling safety and add auditability.

**Behaviour changes**

- A repeated `schedule_garmin_workout` / `batch_schedule_garmin_workouts` request for a
  workout and date that already exists is now **skipped** instead of being sent again. The
  response reports `action: "skip_existing"` and `requiresConfirmation: false`, and no
  `confirmationId` is issued.
- A request whose workout/date has an unresolved earlier write is now **blocked**. This is
  not bypassable by a new preview, a different `idempotencyKey`, a restart, or a concurrent
  caller. The blocked response carries the original `operationId`.
- A timeout now returns a structured receipt (`status: "unknown"`, `operationId`,
  `nextAction: "reconcile_garmin_write_operation"`, `manualReviewRequired: true`) instead of
  a bare failure. Treating it as "please retry" is no longer correct.
- Failed batch entries are classified rather than uniformly marked failed.

**New optional inputs and fields**

- `idempotencyKey` (optional, `A-Z a-z 0-9 . _ : -`, 1–128 chars) on
  `schedule_garmin_workout` and `batch_schedule_garmin_workouts`. Invalid values are rejected
  before Garmin is contacted. It is a request label, not a permission token.
- New result fields: `status`, `action`, `operationId`, `evidence`, `desiredStateSatisfied`,
  `canResume`, `manualReviewRequired`, `errorCode`, `nextAction`; batch adds `skippedCount`,
  `unknownCount`, `notAttemptedCount`, `definiteFailureCount`.

**Compatibility note on `failureCount`**

`failureCount` is retained but its meaning is now documented as `total − successCount`, i.e.
"not confirmed complete". It is **not** a definite failure count. New callers must branch on
per-entry `status` / `definiteFailureCount`, and must never retry based on `failureCount`.

**New local state and its privacy boundary**

- New `GARMIN_STATE_DIR` (absolute, local, private). Default
  `<platform config root>/garmin-connect-mcp/state`. Relative values are rejected.
- The directory is keyed by `sha256(region + "\0" + normalized username)`, so every login
  alias for the same account and region shares one record while session files stay isolated.
  No refresh token is copied or shared by this mechanism.
- It stores normalized request parameters, Garmin IDs, statuses and redacted error codes.
  It does not store cookies, tokens, passwords or raw responses.
- Back it up before migrating machines. **Deleting it removes the only record that prevents
  duplicate scheduling.** See [write safety and recovery](calendar-write-recovery.md).

**Not yet migrated**

`create_garmin_workout`, `create_and_schedule_garmin_workout` and `unschedule_garmin_workout`
keep their previous preview/confirmation behaviour and do not accept `idempotencyKey`.

## Former plugin users

The DeepSeek Harness/Cordis plugin entrypoint, `apply/inject` API, `./client` export, host RPC, React login panel and plugin installation commands have been removed. There is no separate compatibility package.

Register the standard MCP executable in your chosen client and use independent browser authentication. See [client setup](client-setup.md). If an earlier installation used a different session directory, explicitly configure its exact existing session path for one process; do not silently copy it to multiple clients.

## Programmatic users

```ts
import { GarminClient, GarminToolService, createMcpServer, resolveConfig } from 'garmin-connect-mcp'

// This is a package API example for consumers using the local built package.
// It is not an instruction to install the unrelated registry package.
const config = resolveConfig()
const client = new GarminClient(config, { allowUnconfigured: true })
const service = new GarminToolService(client, {
  activityDetail: config.activityDetail,
  fitDownloadDir: config.fitDownloadDir,
  accountUsername: config.username,
  accountRegion: config.region,
})
const server = createMcpServer(service)
// Connect a transport explicitly. Importing the package starts nothing.
```

Inject `options.logger` to use a custom `debug/info/warn/error(message: string)` logger. The default writes to stderr; the client redacts configured credentials before logging. `resolveConfig(input, env)` replaces the old schema callable; invalid explicit values are rejected while MCP environment fallback semantics are retained. Importing configuration does not load dotenv.

CLI users should build before invoking authentication scripts. The old `build:host`, `build:client` and client-type build scripts have been replaced by one clean `build`.

## Distribution and attribution

This fork uses GitHub source installation and `private: true`. The npm name belongs to another project; old unscoped npm commands and badges have been removed. No npm publication is performed.

The WorkBuddy-specific skill and setup reference have been replaced by client-neutral optional guidance. Existing installed copies are not automatically updated; use your client's skill management to replace only that skill.

The private weekly-workout script has been removed; examples use MCP and its shared confirmation rules. Old test reports and research notes are historical records, not current acceptance evidence. LICENSE and provenance remain intact; Git history is not rewritten.

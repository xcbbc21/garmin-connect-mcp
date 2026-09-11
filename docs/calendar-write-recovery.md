# Calendar write safety and recovery

Status: **safety infrastructure complete with simulated verification.**
Live calendar query and automatic recovery remain capability-limited — see
`docs/calendar-api-verification.md` and "Remaining limitations" below.

## What this protects against

Garmin's Calendar scheduling endpoint is non-idempotent and this project has no server-side
deduplication. Before this change a timeout produced a generic failure and the only safe
advice was "check Garmin Calendar before retrying", which a caller could not act on safely.
Now every schedule write is recorded locally before it is sent, and the local record is what
prevents a second write.

Four specific bypass attempts are blocked and covered by tests in
`tests/write-coordinator.test.ts`:

| Attempt | Result |
|---|---|
| Request a **new preview** for the same workout and date | Blocked; no new confirmation is issued (`action: "blocked"`) |
| Reuse a **different idempotency key** | Blocked; the business key is independent of the idempotency key |
| **Restart** the process / client | Blocked; the journal is on disk and is re-read by the new process |
| **Concurrent** callers | Serialized by an account-scoped file lock; exactly one POST is sent |

## The three identifiers

| Identifier | Lifetime | Purpose |
|---|---|---|
| `confirmationId` | One-time, 10 minutes, in memory only | Binds a user approval to one exact preview. Never persisted, never survives a restart, never replayable. |
| `operationId` | Permanent (until the journal is archived) | The server-generated receipt for a write. This is what you query or inspect after an uncertain outcome. |
| `idempotencyKey` | Caller-supplied, optional | A stable label for one request. Same key + same request returns the durable receipt instead of writing again. Same key + different request is rejected with `IDEMPOTENCY_CONFLICT`. A different key never bypasses a pending or unknown write. |

`confirmationId` is an approval token and `idempotencyKey` is a request label. They are never
interchangeable.

## Where state lives

`GARMIN_STATE_DIR` (absolute, local, private). Default:
`<platform config root>/garmin-connect-mcp/state`. Layout:

```
state/<accountKey>/operations.json     0600, POSIX dirs 0700
state/<accountKey>/write.lock/         atomic exclusive lock directory + owner.json
```

`accountKey = sha256(region + "\0" + username.trim().normalize("NFKC").toLowerCase())`.
Two login aliases (e.g. `default` and `claude-personal`) for the same account and region
share one journal. Session files and refresh tokens are still isolated per alias — sharing
the journal never shares credentials.

## Write lifecycle

```
preview     read journal under lock → compute write / skip_existing / blocked per step
            → persist the candidate set → issue one confirmation
confirm     under the same lock: re-check the business key, persist in_flight,
            send exactly ONE request, persist the typed result
```

- **`in_flight` is written to disk before the request is sent.** If that persistence fails,
  nothing is sent (`STATE_UNAVAILABLE`).
- A step is dispatched only while its status is `prepared`. A superseded preview therefore
  cannot add a write.
- **There is no automatic retry on any write path.** A timeout, a connection reset and an
  unverified HTTP error are all classified `unknown`.
- A timeout returns a structured receipt with `status: "unknown"` and an `operationId`,
  not a bare error.

Step statuses: `prepared`, `in_flight`, `succeeded`, `skipped`, `failed`, `unknown`,
`not_attempted`.

| Status | Meaning | Blocks the workout/date? |
|---|---|---|
| `prepared` | Previewed, never sent | No — a new preview may supersede it |
| `in_flight` | Sent, no result yet | **Yes** |
| `unknown` | Sent, outcome indeterminate | **Yes, permanently** |
| `succeeded` | Confirmed by a Garmin receipt | No — a new request is skipped as already present |
| `skipped` | Target already satisfied; nothing sent | No |
| `failed` | Proven not applied | No — a new preview may retry |
| `not_attempted` | Never sent (blocked or interrupted) | No |

## Recovering from an uncertain write

There is currently **no automatic reconcile tool**. An `unknown` receipt is a deliberate
dead end: without a verified calendar query, no evidence exists that could safely clear it.

1. Do **not** retry the same workout and date. The guard will block it anyway.
2. In the Garmin Connect app or web calendar, check whether the workout now appears on that
   date.
3. If it appears, the desired state is satisfied — do nothing. The entry stays `unknown`
   on purpose, because this request cannot be proven to have caused it.
4. If it does not appear after the request is long finished, the conservative options are:
   schedule the same workout on a **different** date (allowed), or schedule a **different**
   workout on the same date (allowed).
5. If you need the same workout on that exact date, archive the journal with the offline
   procedure below, understanding that doing so removes the only record preventing a
   duplicate.

## Offline procedure (stale lock or journal reset)

A lock is never cleared automatically and never expires on a timer: a paused holder may
still be about to write. Use this only when you are certain no process is running.

1. Stop every MCP client that uses this account (Codex, Claude Desktop, …).
2. Confirm the owning process is gone. `state/<accountKey>/write.lock/owner.json` records
   `ownerToken`, `pid` and `startedAt`.
3. **Back up** the whole `state/<accountKey>/` directory.
4. Move only the exact lock directory (`write.lock/`) to an isolated backup location.
5. Restart and re-run a preview. **Do not delete the state root** — that discards the
   records that prevent duplicate writes.

## Backing up

Back up `state/<accountKey>/operations.json` before upgrading, reinstalling or migrating
machines. Copying it to a new machine carries the write history with it; that is usually
what you want when you are the only writer.

## Batch results

`batch_schedule_garmin_workouts` reports per entry: `status`, `evidence`,
`desiredStateSatisfied`, `errorCode`, `nextAction`.

- `successCount` counts `succeeded` + `skipped` (target satisfied).
- `unknownCount`, `notAttemptedCount`, `skippedCount`, `definiteFailureCount` are new.
- `success` is true only when every entry is `succeeded` or `skipped`.
- **Legacy `failureCount` is `total − successCount`.** It is a "not confirmed complete"
  count, **not** a definite failure count. New callers must branch on per-entry `status`
  and `definiteFailureCount`, and must never retry based on `failureCount`.

## Remaining limitations

- No server-side exactly-once. The guard is entirely client-side and covers only writers
  that share this journal. Another device, the Garmin web UI, or a second machine with a
  different state root can still create a duplicate.
- An `unknown` step blocks its workout/date permanently. That is intentional: recoverability
  is not traded for duplicate-write risk.
- No verified calendar range query, so absence can never be proven. See
  `docs/calendar-api-verification.md` §4.
- `create_garmin_workout`, `create_and_schedule_garmin_workout` and
  `unschedule_garmin_workout` do **not** yet use the journal. They keep their previous
  preview/confirmation behaviour and do not accept `idempotencyKey`.
- No automatic cleanup, export or rotation. The journal is capped at 32 MiB, after which
  new writes are refused while reads keep working.
- `write.lock` has no automatic takeover. A leak blocks new writes until the offline
  procedure above.

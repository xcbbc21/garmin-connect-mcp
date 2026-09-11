# Calendar write safety and recovery

Status: **safety infrastructure complete with simulated verification; inspection and recovery
are shipped.** Every write tool is journal-backed, `get_garmin_write_operation`,
`reconcile_garmin_write_operation` and `resume_garmin_write_operation` are reachable over MCP,
and `get_garmin_calendar` performs a real read.

The one thing that is **not** verified is the Garmin side of that read: no request in this
project has ever been sent to a real Garmin account, in either region. See
`docs/calendar-api-verification.md` §4 and §6, and "Remaining limitations" below.

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

## Scope: what this does and does not claim

This is a **client-side guard over one shared local state directory**. It is not a service
contract, and it does not make Garmin idempotent.

| Claim | True? |
|---|---|
| A write recorded in this journal is never sent twice **by the processes that share this state directory** | Yes |
| The same workout and date is never written twice **anywhere** | **No.** Another machine, another state root, the Garmin web UI or the Garmin mobile app can still create a second entry |
| "Garmin already has this entry" is proven before a skip | **No.** A skip is based on a calendar read whose response shape has not been live-verified; it is the best available evidence, not a server guarantee |
| Deleting `GARMIN_STATE_DIR` is a safe way out of a blocked write | **No.** It discards the only record that prevents a duplicate. See "Offline procedure" |
| Somebody else's device can be prevented from writing the same entry | **No.** There is no server-side exactly-once |

## The three identifiers

| Identifier | Lifetime | Purpose |
|---|---|---|
| `confirmationId` | `<operationId>:<previewRevision>`, valid for 10 minutes | Binds a user approval to one exact preview. The preview revision and its deadline are **persisted with the operation**, so an unexpired handle still resolves after a restart; re-previewing bumps the revision and invalidates every earlier handle, in this process or any other. A resume mints its handle the same way. |
| `operationId` | Permanent (until the journal is archived) | The server-generated receipt for a write. This is what you query, reconcile or resume after an uncertain outcome. |
| `idempotencyKey` | Caller-supplied, optional | A stable label for one request. Same key + same request returns the durable receipt instead of writing again. Same key + different request is rejected with `IDEMPOTENCY_CONFLICT`. A different key never bypasses a pending or unknown write. |

`confirmationId` is an approval token and `idempotencyKey` is a request label. They are never
interchangeable.

**A confirmation is bound to the request, not to the caller's intent.** Re-sending the same
request with the same handle after the operation has already been dispatched does not write
again: the coordinator re-checks the business key under the lock and returns the recorded
receipt.

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

The journal stores normalized request parameters, Garmin IDs, statuses and redacted error
codes. It does not store cookies, tokens, passwords or raw responses.

## Journal versions and automatic migration

The journal records `schemaVersion`; the current version is **2**.

- A **v2** journal is parsed and validated as-is.
- A **v1** journal is upgraded automatically, **under the account lock**, the first time a
  process needs it. Nothing touches the disk until the validation has succeeded, so a failed
  upgrade leaves the previous journal byte-for-byte intact.
- During the upgrade the plaintext `idempotencyKey` recorded on old requests is
  **removed** and replaced by its salted hash. Any key that was recorded but never indexed is
  added to the index, so replaying it later finds the existing operation instead of minting a
  duplicate.
- An operation the old code had **re-bound to a second key** cannot be resolved safely. It is
  kept, marked for manual review, and its steps are held as blocked — migration never deletes
  an unknown write to make a problem go away.
- A journal with **no `schemaVersion`**, an **unsupported version**, a **different account**,
  an idempotency index pointing at a **missing operation**, or any missing/duplicated/invalid
  step fails closed with `STATE_CORRUPT`. Nothing is dispatched. The journal is left untouched
  for you to inspect or restore from backup.

There is no "reset the journal to fix it" path in the product, on purpose: the journal is the
only thing standing between you and a duplicate write.

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
- All five write tools — `create_garmin_workout`, `schedule_garmin_workout`,
  `batch_schedule_garmin_workouts`, `create_and_schedule_garmin_workout` and
  `unschedule_garmin_workout` — dispatch through this coordinator. There is no uncovered
  write path, including the create phase of `create_and_schedule_garmin_workout`, which is
  why a repeated confirmed request cannot create a second template.

Step statuses: `prepared`, `in_flight`, `succeeded`, `skipped`, `failed`, `unknown`,
`not_attempted`.

| Status | Meaning | Blocks the workout/date? |
|---|---|---|
| `prepared` | Previewed, never sent | No — a new preview may supersede it |
| `in_flight` | Sent, no result yet | **Yes** |
| `unknown` | Sent, outcome indeterminate | **Yes, until a reliable receipt resolves it** |
| `succeeded` | Confirmed by a Garmin receipt (evidence `response`) | No — a new request is skipped as already present |
| `skipped` | Target already satisfied; nothing sent | No |
| `failed` | Proven not applied | No — a new preview may retry |
| `not_attempted` | Never sent (blocked or interrupted) | No |

## Durability: how a commit is proven

A journal write is atomic (temp file, `fsync`, `rename`, directory `fsync`), but atomicity alone
does not prove that the file now sitting at the committed name is the one that was written. The
store therefore reads it back:

1. The payload is staged to a temporary file, written and `sync`ed.
2. The landed file is `stat`ed **from the write handle** after the sync, so the recorded size is
   the real size rather than a pre-write value.
3. The landed file is opened read-only and its bytes are compared with the payload, through a
   size-bounded reader, and a mismatch is reported with the specific reason: a different inode, a
   different size, or different bytes.

`(dev, ino)` and the size are kept as cheap pre-signals, but they are **not sufficient on their
own**. POSIX allows an implementation to reuse the inode number of a file that was just
unlinked, and Linux does: a `rm` followed by a same-length write produces the same `(dev, ino)`.
A store that trusted the identity pair accepted a file it had never written. This is why the
guarantee rests on reading the bytes back, and why the regression test deliberately masks the
inode signal so the assertion holds on every platform rather than only on the one that recycles
inodes.

A mismatch is `STATE_CORRUPT` and nothing is sent.

## Recovering from an uncertain write

Three tools, in this order:

1. **`get_garmin_write_operation`** — read-only. Query one operation by `operationId`, or a
   page of operations by `limit`/`cursor`. This changes nothing.
2. **`reconcile_garmin_write_operation`** — re-reads Garmin and records what it observed.
   **It sends no POST, no DELETE and no schedule request of any kind**, and it **never changes a
   step status**: it only records `evidence` and `observedAt` next to the status that is
   already there. Its result carries `wroteToGarmin: false`, the observations it took, the
   steps it refuses to re-arm (`refusals`), the steps a resume could safely arm (`candidates`)
   and the `nextAction`.
3. **`resume_garmin_write_operation`** — arms **only** the steps that were proven never to
   have applied. It always previews first and needs its own confirmation. There is no payload
   parameter: dates, workout ids and definitions come from the journal, so a resume can never
   redirect a write to a different day or a different template.

What the evidence actually means:

| Evidence | What it proves | Does it clear `unknown`? |
|---|---|---|
| `response` — Garmin answered the POST | The write happened | Yes, the step is `succeeded` |
| `observed_present` — a complete calendar read shows the target | The target is on the calendar **now** | **No.** It is recorded and the step reports `desiredStateSatisfied: true`, but this request still cannot be proven to have caused it, so the status stays `unknown` and keeps blocking. On a resume result the same step reports `desiredStateSatisfied: false`, because the *write* is still unproven |
| Nothing found on a **complete** read | The range really was read and showed nothing | It is the one negative result the reconciler is allowed to act on: a step that was never dispatched stays available |
| Nothing found on an **incomplete** or unreadable read | Nothing | **No.** The step is reported as `blocked` / undetermined, and no write is armed |
| No calendar read at all | Nothing | No |

The only way a step becomes `succeeded` is a Garmin response for that attempt. A calendar
observation is never promoted into one.

This asymmetry is deliberate. Positive evidence is usable even from a partial read; a negative
conclusion is only ever drawn from a complete one. A read can never produce
`provesWriteDidNotHappen: true`, and an empty range is never laundered into "the POST never
happened".

If a reconcile cannot decide, that is the answer: **do not retry the same workout and date.**

1. Do **not** retry the same workout and date. The guard blocks it anyway.
2. Call `reconcile_garmin_write_operation` with the `operationId` and read the observations.
3. If it observed the target and nothing is left undetermined, use
   `resume_garmin_write_operation` to finish the steps that were provably never sent. The
   blocking entry is never re-sent.
4. If an entry stays `unknown`, the conservative options are: schedule the same workout on a
   **different** date (allowed), or a **different** workout on the same date (allowed) —
   provided the read that supports it is complete.
5. If you genuinely need that exact workout on that exact date, archive the journal with the
   offline procedure below, understanding that doing so removes the only record preventing a
   duplicate.

A read budget bounds step 2: at most `RECONCILE_MAX_READS` (3) calendar reads inside a
`RECONCILE_BUDGET_MS` (20 s) window. Exhausting it does not fail the reconcile; the
unread steps are reported as deferred and stay undetermined.

## Reading the calendar

`get_garmin_calendar` returns a range read: `entries`, `complete`, `missingRanges`,
`warnings`, `fetchedAt` and `requestsIssued`.

**Read `complete` before you believe an empty result.** `complete: true` with `entries: []`
means "this read of this range showed nothing" — it is not evidence about any write attempt.
`complete: false` means part of the range could not be read or validated, and the affected
span is listed in `missingRanges`. Every entry id stays a string end to end; an item whose
identifier cannot be mapped from its own field name is reported instead of guessed, and if
`scheduledWorkoutId` and `workoutScheduleId` disagree the item yields no id at all — picking
one at random risks deleting a different entry later.

Region support is gated on evidence, not on configuration. The read is implemented for the
`global` region only; a `cn` region — or any other label — is refused with
`CALENDAR_QUERY_UNSUPPORTED` **before a request is built**, rather than being answered with an
empty snapshot. The same refusal is enforced a second time in the client transport that
actually picks the host, so a caller that builds its own adapter cannot route around it. The
write paths still send to `garmin.cn`; that asymmetry is intentional and is recorded in
`docs/calendar-api-verification.md` §4.2.

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

A lock left behind by a hard kill is not a corruption: it is a lock whose owner is gone.
Removing it does not remove any write record. The waiting side is bounded, not infinite: a
caller waits up to a deadline and then reports `STATE_UNAVAILABLE` instead of writing.

## Backing up

Back up `state/<accountKey>/operations.json` before upgrading, reinstalling or migrating
machines. Copying it to a new machine carries the write history with it; that is usually
what you want when you are the only writer.

Two things follow from copying it: the new machine inherits the same blocks (an `unknown`
copied across stays blocking), and the two machines no longer share a lock, so they can write
concurrently. Keep one writer per state root.

## Batch results

`batch_schedule_garmin_workouts` reports per entry: `status`, `evidence`,
`desiredStateSatisfied`, `errorCode`, `nextAction`.

- `successCount` counts `succeeded` + `skipped` (target satisfied).
- `unknownCount`, `notAttemptedCount`, `skippedCount`, `definiteFailureCount` are new.
- `success` is true only when every entry is `succeeded` or `skipped`.
- **Legacy `failureCount` is `total − successCount`.** It is a "not confirmed complete"
  count, **not** a definite failure count. New callers must branch on per-entry `status`
  and `definiteFailureCount`, and must never retry based on `failureCount`.
- A batch stops early on a stopping condition — authentication failure, caller cancellation,
  a storage error, an account/region change, an expired confirmation or a lost lock. The
  remaining entries are recorded as `not_attempted` and the counts still add up to `total`.
  An `unknown` outcome is **not** a stopping condition: the later entries are still attempted.

## Remaining limitations

- No server-side exactly-once. The guard is entirely client-side and covers only writers
  that share this journal. Another device, the Garmin web UI, or a second machine with a
  different state root can still create a duplicate.
- An `unknown` step blocks its workout/date until a reliable receipt resolves it. A calendar
  read that merely *observes* the entry does not resolve it, by design: recoverability is not
  traded for duplicate-write risk.
- **The calendar read has never been exercised against a real account, in either region.** The
  request shape, response envelope and item field set rest on named public implementations
  (see `docs/calendar-api-verification.md` §4); whether the query is reachable for a given
  account, and what it answers for an empty day, is unknown.
- The `cn` region has no verified read at all, so it is refused rather than guessed. Absence
  cannot be proven there.
- Steps are journaled by kind (`create`, `schedule`, `batch-schedule`, `unschedule`), and every
  kind carries its own business key. A create is keyed by the account plus the canonical
  workout-definition fingerprint, not by name, so `create_garmin_workout` and
  `create_and_schedule_garmin_workout` share one `create:` key: an `unknown` create blocks that
  exact definition from being created again — through either tool — until a receipt resolves it.
- No automatic cleanup, export or rotation. The journal is capped at 32 MiB, after which
  new writes are refused while reads keep working.
- `write.lock` has no automatic takeover. A leak blocks new writes until the offline
  procedure above.
- `npm run test:integration` (live read-only checks) was not run: no real-account
  authorisation was available for this round.
- **The inode-identity check that was fixed in the journal store still exists in
  `assertSameFileSystemEntry` (`src/private-path.ts`), which the session-token path also uses.**
  It is left in place deliberately: the properties it guards are re-asserted from the opened
  handle's `fstat` immediately afterwards, and anyone able to write into the private state
  directory could already produce a schema-valid journal. Recorded as a residual risk, not as a
  verified absence of one.
- **Platform coverage is uneven.** macOS arm64 is verified on the host (12 write-state suites /
  189 tests). Linux aarch64 is verified in a container only, and on a channel that mounts the
  official `linux-arm64` Node tarball onto an `arm64v8/ubuntu:22.04` image rather than using the
  official `node:20` / `node:22` images — real POSIX semantics, but not the CI runner image.
  **Windows is not verified at all** for this commit: no Windows host or runner was available,
  so DACL enforcement, NTFS atomic rename and subprocess lock release are untested. See
  `docs/verification.md`, "Platform results, continuation round".

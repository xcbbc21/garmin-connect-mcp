# Calendar Write Recovery v0.2 — Migration and Use Guide

> **Historical note (superseded).** This is the design note written while the 0.2 recovery
> work was still scoped to a single journal version and one new tool. It is kept for the
> record and is **not** a description of the shipped behaviour. Three of its statements have
> since been overtaken:
>
> | This document says | The shipped revision does |
> | --- | --- |
> | "Calendar reads … Deferred; tools unchanged" | `get_garmin_calendar` exists and reads a bounded date range |
> | "The on-disk format is unchanged for v1.0 … the plaintext field is harmless to leave in place" | journals migrate from v1 to v2 automatically under the account lock; the plaintext key becomes a salted hash and is not retained |
> | "Public MCP tool names: 15 (was 14)" | 18 tools |
>
> For the current contract read `docs/calendar-write-recovery.md`,
> `docs/calendar-api-verification.md` and `docs/migration.md`.

This document covers what changed in 0.2 for the calendar-write safety
guarantees, how to migrate from 0.1.x, and how to use the new
`get_garmin_write_operation` tool to recover from interruptions.

## What changed

| Area | Before (0.1.x) | After (0.2) |
| --- | --- | --- |
| History lookup | `findStepByBusinessKey` returned the first matching step; a stale `not_attempted` could authorize a duplicate dispatch | `collectBusinessHistory` aggregates all steps sharing a business key in priority order: in_flight/unknown > succeeded/skipped > failed/not_attempted/prepared |
| Batch accounting | Parent operation stored only writable steps; receipts omitted blocked/satisfied entries | Parent operation stores every requested item in original order; receipts cover the full original set; blocked items pin a read-only `reference` to the blocker |
| Idempotency on a prepared step | A second preview returned the durable receipt and required no confirmation | A second preview advances `previewRevision` and re-issues a confirmation; the old `confirmationId` is invalidated |
| Persisted request payload | The plaintext `idempotencyKey` was hashed AND stored in `operation.request` | Only the hash is persisted (`idempotencyKeyHash`); the request payload is stripped of `idempotencyKey`, `confirmationId`, and `confirmed` before storage |
| Calendar reads | No public read tool — `garmin-connect` does not expose a stable calendar query | Deferred: no public API evidence; tools unchanged |
| Recovery tool | None | New `get_garmin_write_operation` reads the local write journal without login, supports lookup by `operationId` or `idempotencyKey`, paginates, and redacts secrets |

## Data migration

The on-disk format is unchanged for v1.0 (existing 0.1.x journals load
without migration). The new field `previewRevision` is optional in the
in-memory type so older journals continue to parse; the coordinator
defaults it to 0 when re-issuing a confirmation.

If you have 0.1.x journals with a `request.idempotencyKey` plaintext
field, it is still readable but no longer trusted: the lookup uses
`idempotencyKeyHash` only. The plaintext field is harmless to leave
in place, but you can prune it by re-issuing a fresh preview of each
operation (the next confirmed call rewrites the operation document
without the field).

## Recovering an interrupted write

1. List recent operations:

   ```text
   get_garmin_write_operation({})
   ```

2. Find the operation with `nextAction: "reconcile_garmin_write_operation"`
   (status `unknown` or `in_flight`).

3. Re-confirm or pause:
   - **Correction (superseded guidance):** do **not** re-call the original write tool to
     "retry" a step whose outcome is unknown — that is exactly the duplicate dispatch the
     journal exists to prevent. Use `reconcile_garmin_write_operation` to record what Garmin
     currently shows, then `resume_garmin_write_operation`, which re-arms only the steps that
     were never dispatched. For a step that is merely `prepared` (never sent), a fresh preview
     with the same `idempotencyKey` is legitimate: it advances `previewRevision` and issues a
     new `confirmationId`, invalidating every earlier handle.
   - If you want to abandon, do nothing: the operation stays in
     `unknown` until you explicitly resolve it.

## Compatibility

- Public MCP tool names: 15 (was 14). New: `get_garmin_write_operation`.
- Public Go/Java/Python SDKs: unchanged (this is a TypeScript project).
- Existing tool arguments and return shapes: unchanged except
  `batch_schedule_garmin_workouts` now always returns a `results` array
  whose `length` equals the requested batch size.

## Limitations

- `get_garmin_write_operation` does not contact Garmin; it only reads
  the local write journal. A successful `succeeded` step is the journal
  state at the time of the last write. It is not re-verified against
  the Garmin Calendar.
- `reconcile_garmin_write_operation` and `resume_garmin_write_operation`
  are deferred (see `docs/calendar-write-recovery-continuation.md` C7).
  Until they land, the recommended recovery path is the journal read
  plus a manual re-call of the original tool.
- Calendar reads (C6) are deferred pending public API evidence.

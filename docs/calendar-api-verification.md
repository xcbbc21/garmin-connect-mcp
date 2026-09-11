# Garmin Calendar API verification

Verification date: 2026-09-11
Package under test: `garmin-connect@1.6.2` (locked in `package-lock.json`)
Repository HEAD at verification: `67f5ec9` (§1–§3, §5); §4 rewritten at `dd9f825` while the
`src/calendar/` module it describes was still uncommitted, then updated when `src/calendar/` and
the `GarminClient` read wiring landed (the C6 commit).

**Reachability updated 2026-09-12 (`ff128b6`).** §4.1 evidence, §4.2 region asymmetry and §4.3
contract decisions are unchanged and still rest on the same public sources. What changed is
only who may call the read: the `get_garmin_calendar` tool now exposes it over MCP, and
`reconcile_garmin_write_operation` consults it under a read budget. The rows that previously
said "not reachable from any MCP tool" and "no recovery path can consult a calendar read" have
been corrected in place. **No live response has been captured in either region, so the read
side of this document remains evidence-free against the real service.**

This file records what was actually checked, how, and what remains unverified. It is
deliberately conservative: a row marked "source-verified" was read in the installed
dependency, in this repository, or in a named public implementation at a pinned commit —
**not** exercised against a real account. Where a claim is only about routing or
configuration, it says so and is not used as evidence about a response.

## 1. Client capability: what the SDK really exposes

| Claim | Method of checking | Result |
|---|---|---|
| `garmin-connect@1.6.2` exposes `scheduleWorkout` | `grep -rn "scheduleWorkout" node_modules/garmin-connect/dist/garmin/GarminConnect.js dist/garmin/GarminConnect.d.ts` | **No match.** The method is documented in the package `README.md` (lines 552-557) but is absent from the shipped code. |
| The SDK ships a schedule URL helper | `grep -n "calendar" node_modules/garmin-connect/dist/garmin/UrlClass.js` | **No match.** `UrlClass` exposes `WORKOUT(id)` (`/workout-service/workout/{id}`) and `WORKOUTS` (`/workout-service/workouts`) only. There is no `/workout-service/schedule/` helper. |
| The SDK types its workout surface | `GarminConnect.d.ts` (71 lines) | Contains no `workout` member at all; this repository calls workout methods through `(this.gc as any)`. |

Conclusion: calendar scheduling in this project is a **project-owned transport adapter**
over the SDK's already-authenticated Axios instance. It is not an SDK capability, and any
statement that the SDK performs the scheduling would be false.

## 2. Endpoints used by this repository

Source: `src/client.ts`, `GarminClient.calendarWrite` / `scheduleWorkout` / `unscheduleWorkout`.

| Operation | Method and path | Body | Source-verified | Live-verified |
|---|---|---|---|---|
| Schedule a library workout | `POST https://connectapi.garmin.com/workout-service/schedule/{workoutId}` (global) | `{ "date": "YYYY-MM-DD" }` | Yes — `src/client.ts` | **No** |
| Same, China region | `POST https://connectapi.garmin.cn/workout-service/schedule/{workoutId}` | `{ "date": "YYYY-MM-DD" }` | Yes — host chosen by `config.region` | **No** |
| Remove a calendar entry | `DELETE https://connectapi.garmin.{com,cn}/workout-service/schedule/{workoutScheduleId}` | none | Yes — `src/client.ts` | **No** |

Region evidence is **not transferable**: the `cn` host is only a different hostname in the
same code path. Verifying one region says nothing about the other until each is exercised.

## 3. ID semantics

Observed in code and in returned shapes; not confirmed against live data.

| Identifier | Meaning | Treatment in this project |
|---|---|---|
| `workoutId` | Workout-library template | Used for the schedule business key; never treated as a schedule id |
| `workoutScheduleId` | One Calendar entry | Returned by a successful `POST`; the only value accepted by `unschedule_garmin_workout` |
| `scheduledWorkoutId` | The same Calendar entry, as the **range read** names it (`scheduledWorkoutId`, not `workoutScheduleId`) | Read-side name only; mapped into the same entry field, never derived from `workoutId`. Evidence and the disagreement rule: §4.1 and §4.3 |
| Activity id | A completed activity | Never converted into a schedule id |
| Generic `id` | Unspecified | Never reinterpreted as a schedule id |

## 4. Calendar range query — implemented behind an evidence gate

**Status: implemented in `src/calendar/` (read adapter + conclusion contract), wired into
`GarminClient.getCalendarRange` (`src/client.ts`), exposed as the `get_garmin_calendar` MCP tool
and consulted by `reconcile_garmin_write_operation`; not live-verified.**

`src/calendar/adapter.ts` implements exactly one read: the GraphQL gateway query
`workoutScheduleSummariesScalar(startDate, endDate)`. Every protocol claim in that module
carries the `file:line` recorded below. **Nothing in this section was exercised against a real
account** (in either region): the request shape, the response envelope and the item field set
rest on the public sources below, which agree with each other.

Wiring state: `src/client.ts` imports `CALENDAR_SUPPORTED_REGIONS` and `createCalendarAdapter`
from `src/calendar/adapter.ts` and exposes `getCalendarRange(range, options)` plus
`calendarTransport()`; `src/tool-service.ts` holds the `calendarReader` used by both the
`get_garmin_calendar` tool and the coordinator. `tests/calendar-query.test.ts`,
`tests/client.test.ts` and `tests/write-stdio-recovery.test.ts` are the test importers.

**Reachability, precisely.** The read is reachable from two places and nowhere else:
`get_garmin_calendar` (read-only; it issues no write) and the reconcile pass inside
`reconcile_garmin_write_operation`, which is bounded to `RECONCILE_MAX_READS = 3` reads and
`RECONCILE_BUDGET_MS = 20_000` ms and records a `deferred` note instead of an error when the
budget runs out. Scheduling itself still never consults a calendar read before dispatching, and
the coordinator still never clears a business key from an empty range, because absence is not
provable from this read (§4.3).

The read is wired in two independent gates, both against the same constant: the adapter refuses
an unsupported region before it builds a request (`src/calendar/adapter.ts:748-756`), and the
client transport refuses again before it picks a host (`src/client.ts:936-959`,
`queryCalendarGateway`), so a caller that constructs its own adapter cannot route around the
gate. Neither path writes local state, and neither retries.

### 4.1 Evidence, global (`garmin.com`)

| Claim | Source (commit, path:line) | Result |
|---|---|---|
| Query text and parameter format | `cyberjunky/python-garminconnect@384c666` `docs/graphql_queries.txt:42` | `query{workoutScheduleSummariesScalar(startDate:"{startDate}", endDate:"{endDate}")}`, both params `YYYY-MM-DD` |
| Transport | same commit, `garminconnect/__init__.py:3663-3688` and endpoint at `:608` | `POST /graphql-gateway/graphql` on the `connectapi` host |
| Response envelope | `Taxuspt/garmin_mcp@655efb8` `tests/integration/test_workouts_tools.py:1220-1245`; `tamcore/garmin-mcp@a9440718` `internal/garmin/api/calendar_test.go:19-25` | `{"data":{"workoutScheduleSummariesScalar":[…]}}`, and the field is a JSON **array**, not a JSON-encoded string |
| Same envelope, three more independent sources | `serhiitroinin/serene@d822d696` `apps/web/src/server/sources/garmin.ts:363-392` (fetches the gateway directly, types it `ReadonlyArray<…>`); `brunosantos/garmin-workouts-mcp@753b725` `src/garmin_workouts_mcp/workouts.py:517-551`; `tamcore/garmin-mcp@a9440718` `internal/garmin/api/calendar.go:35-72` | same array shape |
| A non-empty GraphQL `errors` array is a failure even when `data` is present | `tamcore/garmin-mcp@a9440718` `internal/garmin/api/calendar_test.go:200-217` (expects `ErrGraphQLErrors`, without quoting the upstream message); `serhiitroinin/serene@d822d696` `apps/web/src/server/sources/garmin.ts:387-389` (throws on `errors?.length`) | never read as "the calendar is empty" |
| Item field set | `Taxuspt/garmin_mcp@655efb8` `src/garmin_mcp/workouts.py:544-592` | `scheduleDate`, `scheduledWorkoutId`, `workoutUuid`, `workoutId`, `trainingPlanId`, `fbtAdaptivePlanId`, `tpType`, `tpPlanName`, `workoutName`, `workoutType`, `workoutPhrase`, `isRestDay`, `race`, `estimatedDurationInSecs`, `estimatedDistanceInMeters`, `associatedActivityId` |
| Entry-id field name on this read | same (`workouts.py:544-592`, comment: "Calendar-entry id (distinct from workout_id)"); `tamcore/garmin-mcp@a9440718` `internal/garmin/api/calendar.go:35-72` (`ScheduledWorkoutID` ← `scheduledWorkoutId`) | `scheduledWorkoutId` — and it **can be `null`** (coach/plan entries) |
| The schedule POST answers with a *different* name | `drkostas/hevy2garmin@99a1d73` `src/hevy2garmin/garmin.py:487-505` reads `data.get("workoutScheduleId")` from the POST and `:510-516` feeds it back into DELETE | `workoutScheduleId` is the write-response alias, not the read's field name |
| No pagination input / cursor | `tamcore/garmin-mcp@a9440718` `internal/garmin/client/graphql.go` header (no `operationName`, no `variables`, arguments interpolated literally); no source we read passes one | unverified surface: the adapter detects a returned cursor and bounds the loop, but the production transport **refuses** to send one (no verified parameter name), so a paging provider ends as an incomplete slice rather than a guessed next page |
| Whether the answered date range is inclusive at both ends | — | **unverified** (this is why every slice is probed ±1 day) |
| Whether the query is reachable for a given account/region at all | — | **unverified** |
| Any calendar *read* in the pinned SDK | §1 above (`garmin-connect@1.6.2`) | none exists |

Corroboration breadth: four independent implementations read this same envelope
(`Taxuspt`, `tamcore`, `serene`, `brunosantos`), and two of them (`tamcore`, `serene`) also
define the `errors` failure semantics this adapter adopts. `python-garminconnect` is the source
for the query text and the transport, not for the envelope.

### 4.2 Evidence, China (`garmin.cn`) — recorded separately on purpose

| Claim | Source | Result |
|---|---|---|
| `garmin.cn` can be configured as the base domain | `cyberjunky/python-garminconnect@384c666` `garminconnect/__init__.py:617` (`domain = "garmin.cn" if is_cn else "garmin.com"`); `matin/garth@f99159a` `docs/configuration.md:10-14` and `tests/test_http.py:197-200` | a **routing/configuration** claim only |
| A `cn` response body, envelope or item shape | — | **no first-hand source found** |
| This repository's own `cn` write host | `src/client.ts:834-885` (host chosen from `config.region`) | a write-path host; **not** evidence about the read |

The same hostname in the same code path is not evidence that the same query works there, so
the `cn` region is refused with `CALENDAR_QUERY_UNSUPPORTED` (`not_applied`) **before any
request is built or sent** — there is deliberately no empty-snapshot fallback for it. The same
applies to any other region label (`eu`, `''`, …). This is the one place where read and write
differ today: the write path does send to `garmin.cn`, and that remains source-verified only
(§2).

### 4.3 Contract decisions that follow from the evidence

| Decision | Where | Why |
|---|---|---|
| One query per calendar-month slice, each padded ±1 day; entries outside the asked range are dropped | `src/calendar/adapter.ts:766-797`, `:327-335` | boundary inclusivity is unverified; padding can only add evidence. Guessing it in the exclusive direction could hide an entry on the requested end date — the one error that can later cause a duplicate write |
| `complete: true` for a complete **empty** read | `src/calendar/types.ts:97-112` | says "this read of this range showed nothing"; explicitly **not** evidence about any write attempt |
| A non-empty `errors` array makes the slice unreadable (`complete:false`) | `src/calendar/adapter.ts:443-449` | matches both sources in §4.1 |
| Ids stay strings end to end; a numeric id above `Number.MAX_SAFE_INTEGER` is rejected, never rounded | `src/calendar/adapter.ts:359-384` | a silently changed id would make an unschedule target wrong |
| `workoutId` (library template) and `workoutScheduleId` (calendar entry) are filled only from their own field names | `src/calendar/adapter.ts:560-645` | a generic `id` / `scheduleId` / `calendarItemId` / `workoutScheduleUuid` / `calendarEventId` is reported as `UNMAPPED_ITEM_IDENTIFIER` and never promoted |
| `scheduledWorkoutId` **and** `workoutScheduleId` are both accepted; disagreeing values yield no id, `ITEM_ID_CONFLICT` and `complete:false` | `src/calendar/adapter.ts:516-544` | either value could be the entry a later DELETE removes, so picking one risks deleting a different entry |
| An unreadable or unclassifiable item makes the whole snapshot `complete:false` while being retained in `warnings` | `src/calendar/adapter.ts:654-668`; `src/calendar/types.ts:113-119` | fail closed; dropping it silently would fake a complete read. Item-level problems are not reported as coverage problems |
| A read can never produce `provesWriteDidNotHappen: true`; only explicit attempt evidence can | `src/calendar/types.ts:204-228`, `:348-360`, with a type-level check in `tests/calendar-query.test.ts` | "the range came back empty" must not be laundered into "the POST never happened" |
| A `workoutScheduleId` miss stays `undetermined` / `SCHEDULE_ID_LOOKUP_UNSUPPORTED`, even for a complete read | `src/calendar/types.ts:277-287` | with no verified by-id read, an entry may simply have moved outside the queried range |
| The region gate exists twice, against one constant | `src/calendar/adapter.ts:748-756`; `src/client.ts:941-950` | the adapter gate is the design; the transport gate is the boundary that actually picks a host, and it also covers a caller that builds its own adapter |
| A returned cursor is refused by the production transport instead of sent under a guessed parameter name | `src/client.ts:951-959` | a provider that ignored a guessed cursor could return page one again, and a page that then omitted the repeat cursor would look like a finished slice |
| A failed read is an error, never an empty range | `src/calendar/adapter.ts:817-822` (request), `:908-916` (`CHUNK_READ_FAILED` + `missingRanges`); `src/client.ts:992-998` | the adapter converts a transport rejection into `complete:false` + `missingRanges` + `CHUNK_READ_FAILED`; the transport strips upstream message text before it can reach a warning |

### 4.4 Documented read surfaces that are deliberately **not** implemented

| Surface | Evidence it exists | Why it is not implemented |
|---|---|---|
| Month feed `GET /calendar-service/year/{year}/month/{month-1}` (month is zero-based on the wire) | `cyberjunky/python-garminconnect@384c666` `garminconnect/__init__.py:3581-3608`; `barnes-c/go-garminconnect@fde79fa` `garminconnect/workouts.go:59-64` | the only first-hand item shape for that feed is events/races (`tamcore/garmin-mcp@a9440718` `internal/garmin/api/calendarevents.go:1-30,66-95` reads `calendarItems` with `itemType`/`title`/`date`); no source documents its workout item shape, and this adapter has no REST transport |
| By-schedule-id read `GET /workout-service/schedule/{scheduledId}` | `cyberjunky/python-garminconnect@384c666` `garminconnect/__init__.py:3598-3608`; `serhiitroinin/serene@d822d696` `product/research/garmin-training-plan-api.md:30` | two sources name the path, none documents its response; the sources we read only document POST/DELETE on this path |
| `trainingPlanScalar` coach window | `Taxuspt/garmin_mcp@655efb8` `src/garmin_mcp/workouts.py:544-592` (plan fields on plan items) | returns a different item shape than the range query this adapter maps |
| Path disagreement, recorded and not resolved | `barnes-c/go-garminconnect@fde79fa` `garminconnect/workouts.go:69-80` uses `/calendar-service/schedule/workout/{id}`, while `python-garminconnect` (`:584`, `:3610-3634`) and this repository (`src/client.ts:834-885`) use `/workout-service/schedule/{workoutId}` | one of the two is wrong and neither was exercised, so a by-id **read** would be built on a coin flip today |

The `CALENDAR_QUERY_UNSUPPORTED` error code exists (`src/write-operations/errors.ts:26`) and is
what an unsupported region raises. The `get_garmin_calendar` tool **is now shipped** and, for an
unsupported region, fails closed with that code rather than returning an empty range. Both
regions must still be verified separately, and "the day has no entry" may only ever be reported
as a `complete` range fact — never as proof of absence.

## 5. Write-outcome classification evidence

Source: `src/client.ts` (`toWriteTransportError`), `src/write-operations/errors.ts`.

| Situation | Classification | Why |
|---|---|---|
| Local validation before dispatch (empty id, bad date) | `not_applied` | No request was built |
| Request timeout (`Promise.race` deadline) | `unknown` | The request may already have reached Garmin |
| Connection reset / malformed response | `unknown` | Cannot distinguish "not received" from "received, reply lost" |
| Auth epoch changed mid-flight | `unknown` | The write may have completed before the change |
| HTTP 4xx / 429 / 5xx | `unknown` | Endpoint semantics are unverified, so failure is never downgraded |

No automatic retry exists anywhere on these paths: the response interceptor only replays
`GET`/`HEAD`/`OPTIONS` (`installSafeResponseInterceptor`), and the coordinator dispatches a
given step at most once per confirmation.

## 6. What has not been verified

**Live: nothing, in either region.** Specifically still open about the read (§4):

- that the query is reachable at all for a given account, and what it answers for an empty day
  (an array, an omitted field, or `null`);
- whether the answered range is inclusive at both ends — the ±1-day probe pad exists because of
  this;
- whether any response ever carries a cursor or a truncation flag (the loop handles both, but
  neither is an evidenced shape);
- whether `scheduledWorkoutId` is present and correct on every item shape (one source's fixture
  has it `null` for coach entries);
- whether read and write really use two different field names, or one source is simply behind
  (`scheduledWorkoutId` vs `workoutScheduleId`);
- anything at all about a `cn` response;
- the month feed and the by-id read were never exercised, so their response shapes stay unknown;
- `src/calendar/*` is reachable from `GarminClient.getCalendarRange`, from the
  `get_garmin_calendar` tool and from the reconcile pass — but **not one of those calls has ever
  been made against the real service**, so the whole read side has zero live evidence;
- what the gateway answers when asked with a cursor (the transport refuses to construct that
  request, so even the failure mode is unobserved).

Open about writes (unchanged from §2/§5):

- Any request against a real Garmin account, in either region.
- That `POST` returns `workoutScheduleId` in every case (the mock returns it; live shape unknown).
- Whether a repeated `POST` for the same workout/date creates a second entry. This project
  assumes it **may**, which is why the guard is client-side.
- Whether `DELETE` is idempotent.

Until these are exercised with explicit user authorisation, delivery status is
**"safety infrastructure, recovery tooling and simulated verification complete; live calendar
read remains unverified"**. A read adapter exists behind a two-layer evidence gate, it is wired
into `GarminClient`, it is reachable from the `get_garmin_calendar` tool and from the reconcile
pass, and the whole read side is still backed by **no live observation in either region**.

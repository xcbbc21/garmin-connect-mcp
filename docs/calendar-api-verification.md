# Garmin Calendar API verification

Verification date: 2026-09-11
Package under test: `garmin-connect@1.6.2` (locked in `package-lock.json`)
Repository HEAD at verification: `67f5ec9`

This file records what was actually checked, how, and what remains unverified. It is
deliberately conservative: an endpoint listed as "source-verified" was read in the
installed dependency or in this repository, **not** exercised against a real account.

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
| Activity id | A completed activity | Never converted into a schedule id |
| Generic `id` | Unspecified | Never reinterpreted as a schedule id |

## 4. Calendar range query (`get_garmin_calendar`)

**Status: not implemented, not verified.**

- No calendar range endpoint was found in `garmin-connect@1.6.2` (see §1).
- This repository does not implement one, and no live request was made to discover one.
- Consequence: **there is no ability to prove a target is absent.** The coordinator
  therefore never concludes "not found" and never uses an empty query to clear a
  business key. Recovery of an `unknown` write does not depend on a calendar query.
- The planned `get_garmin_calendar` tool and the `CALENDAR_QUERY_UNSUPPORTED` capability
  error are **not shipped** in this increment. When such a tool is added, both regions
  must be verified separately, and "the day has no entry" may only be reported as
  `complete:false` evidence, never as proof of absence.

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

- Any request against a real Garmin account, in either region.
- That `POST` returns `workoutScheduleId` in every case (the mock returns it; live shape unknown).
- Whether a repeated `POST` for the same workout/date creates a second entry. This project
  assumes it **may**, which is why the guard is client-side.
- Whether `DELETE` is idempotent.
- Whether a calendar range read endpoint exists at all.

Until these are exercised with explicit user authorisation, delivery status is
**"safety infrastructure complete with simulated verification; live calendar query and
automatic recovery remain capability-limited"**.

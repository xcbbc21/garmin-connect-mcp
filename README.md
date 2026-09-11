# garmin-connect-mcp

A standalone Garmin Connect MCP server for AI agents. Connect any client that supports local MCP stdio to read activity and wellness data, create structured workouts, and schedule training in Garmin Calendar.

[中文说明](README.zh-CN.md) · [Client setup](docs/client-setup.md) · [Migration](docs/migration.md) · [Verification report](docs/verification.md) · [Write safety and recovery](docs/calendar-write-recovery.md)

No model-provider API key or agent framework is required by this server. Garmin access uses your own account. An optional agent skill provides usage guidance; it is not required to expose tools.

## Install from source

Use Node.js 22 for development (runtime requires Node.js 20+), npm, and GitHub CLI:

```bash
gh repo clone xcbbc21/garmin-connect-mcp
cd garmin-connect-mcp
npm ci
```

The install builds `lib/`. After a source update, run `npm ci` again. `npm run build` always clears this project's generated output before compiling.

**This fork is distributed from GitHub only.** The unscoped npm name is owned by another project. Do not install it to obtain this repository. The local manifest uses `private: true`; there is no npm release for this fork.

## First login

In the source directory, set your account email and choose your Garmin region:

```bash
export GARMIN_USERNAME='your@email.com'
node lib/auth-cli.js serve --account personal-codex --region global --open
```

Use `--region cn` for China. The command requires an explicit account alias and region. The same account alias, email and region must be used in the MCP configuration.

Your system browser opens a short-lived local login page. Enter credentials only in the Garmin sign-in form, then confirm the returned account identity. The local page embeds Garmin's sign-in page; its outer address is a loopback URL, not a Garmin URL. If the form is absent, do not enter credentials.

The default macOS session path, when no configuration-root override is set, is:
`~/.config/garmin-connect-mcp/accounts/personal-codex.session.json`.
`XDG_CONFIG_HOME`, `LOCALAPPDATA` and `APPDATA` can override the root. Use the destination selected by the CLI when configuring a custom path.

For a second concurrently running client, initialize a separate alias, for example `personal-claude`. Do not copy or concurrently share session files: refresh tokens can rotate.

`garmin-connect-auth` remains the authentication executable name. In a source checkout, call it through `node lib/auth-cli.js`; global installation is unnecessary. Diagnostic `login`, `login --browser` and `canary` commands are retained. Normal `serve` does not require Playwright; older browser diagnostics use the optional driver.

## Connect a client

Every client runs the same program:

- command: the absolute path to your Node executable (`command -v node` on macOS/Linux);
- argument: the absolute path to this checkout's `lib/mcp.js`;
- environment: `GARMIN_USERNAME`, `GARMIN_REGION`, `GARMIN_ACCOUNT` and your session-file path.

See [client setup](docs/client-setup.md) for Codex, Claude Desktop, Claude Code, Cursor, Windsurf, WorkBuddy and ZCode examples. These are configuration examples; protocol tests do not establish end-to-end validation of every desktop application.

If a client supports MCP URL elicitation, missing/expired sessions can prompt the same browser login. Otherwise run the independent login command above and retry. Authentication completion never automatically replays a write.

## Tools

| Capability | MCP tools |
| --- | --- |
| Activities and wellness | `get_garmin_activities`, `get_garmin_sleep`, `get_garmin_steps`, `get_garmin_heart_rate`, `get_garmin_weight` |
| Account and templates | `get_garmin_profile`, `get_garmin_workouts` |
| Running guidance | `get_running_skill_advice` |
| Create a template | `create_garmin_workout` |
| Calendar scheduling | `schedule_garmin_workout`, `batch_schedule_garmin_workouts`, `create_and_schedule_garmin_workout`, `unschedule_garmin_workout` |
| Activity export | `download_garmin_activity_fit` |
| Calendar read | `get_garmin_calendar` |
| Write inspection and recovery | `get_garmin_write_operation`, `reconcile_garmin_write_operation`, `resume_garmin_write_operation` |

There are 18 tools. Workout-library templates describe **what to do**; Calendar entries describe **when to do it**. The guidance tool offers training-method knowledge and athlete-intake checks; it does not independently generate and execute a complete training plan.

Workout creation and Calendar writes use two calls: first preview, then repeat the identical request with `confirmed: true` and the returned `confirmationId` after the user approves. IDs expire after ten minutes and cannot be reused. A `confirmationId` is `<operationId>:<previewRevision>`: because the revision and its deadline are stored with the operation, an unexpired handle still resolves after a restart, and re-previewing invalidates every earlier handle. The **write journal is durable** — Calendar results are recorded on disk and survive a restart. See [write safety and recovery](docs/calendar-write-recovery.md).

All five write tools — `create_garmin_workout`, `schedule_garmin_workout`, `batch_schedule_garmin_workouts`, `create_and_schedule_garmin_workout` and `unschedule_garmin_workout` — also accept an optional `idempotencyKey` (1–128 characters from `A-Z a-z 0-9 . _ : -`). It is a request label, not a permission token: reusing the same key with the same request returns the recorded receipt instead of writing again, and a different key never bypasses an in-flight or unknown write. `confirmationId` and `idempotencyKey` are never interchangeable.

Calendar writes are recorded under an account-scoped local directory, `GARMIN_STATE_DIR` (absolute, local, private; default `<platform config root>/garmin-connect-mcp/state`). It is independent of your login alias, so two aliases for the same account share one recovery record while session files stay separate. Back it up; deleting it destroys the records that prevent duplicate scheduling.

### Five runs next week

Ask your agent:

> Find the existing easy, threshold and long-run templates. Preview five runs next Monday, Tuesday, Thursday, Saturday and Sunday in Asia/Shanghai. Show dates and workouts before writing. Leave the other days empty.

The agent resolves real workout IDs and dates first. Example batch preview (replace these example IDs and dates):

```json
{
  "schedules": [
    { "workoutId": "123", "date": "2026-09-14" },
    { "workoutId": "456", "date": "2026-09-15" },
    { "workoutId": "123", "date": "2026-09-17" },
    { "workoutId": "123", "date": "2026-09-19" },
    { "workoutId": "789", "date": "2026-09-20" }
  ],
  "timezone": "Asia/Shanghai"
}
```

After approval, send the same request to `batch_schedule_garmin_workouts`, adding `confirmed: true` and the returned ID. A batch accepts 1–100 entries, so it can span multiple weeks.

- Dates are local `YYYY-MM-DD` values; the timezone defaults to the server host if omitted. Past or impossible dates and invalid IANA timezones are rejected.
- Reusing a template on different dates is supported. Duplicate workout/date pairs within one batch are rejected before anything is sent.
- Within one shared write journal, a template/date pair is not written twice: a repeated request is either skipped because a Calendar read shows the entry already there, or blocked because an earlier write for the same pair has an unknown outcome. This holds across a new preview, a different `idempotencyKey`, a service restart and concurrent callers. The guarantee is local — it covers the machines that share `GARMIN_STATE_DIR`. Garmin exposes no server-side idempotency, so a second state directory, another device, or a hand-edited Calendar is outside it, and `skipped` reports what the read returned rather than proving that no other entry exists.
- Rest days are omitted; a workout's internal recovery/rest step is still valid.
- Preview checks existing template IDs. Each confirmed entry is committed separately and reports its own `status`. A batch continues after an individual failure: `successCount` counts `succeeded` + `skipped`, and the legacy `failureCount` means "not confirmed complete", not "definitely failed" — branch on per-entry `status` and `definiteFailureCount`, never on `failureCount`.
- A timeout is reported as `status: "unknown"` together with a durable `operationId`, not as a plain failure. It is never re-sent. Check Garmin Calendar, then schedule a different date or template. Creation followed by failed scheduling reports the created workout ID when available.
- Cancellation needs the `workoutScheduleId` from the scheduling result, not the template ID. If Garmin does not return that ID, do not invent one.
- `create_garmin_workout`, `create_and_schedule_garmin_workout` and `unschedule_garmin_workout` are journal-backed and accept the same optional `idempotencyKey`. A create-and-schedule records both phases, so a crash after the template exists is recoverable without creating a second template, and a cancellation is logged rather than repeated. Read the current Calendar with `get_garmin_calendar`, then inspect and recover with `get_garmin_write_operation`, `reconcile_garmin_write_operation` and `resume_garmin_write_operation`. See [write safety and recovery](docs/calendar-write-recovery.md).

The pinned `garmin-connect@1.6.2` does not export schedule/cancel helpers. The existing adapter uses authenticated `POST /workout-service/schedule/{workoutId}` and `DELETE /workout-service/schedule/{workoutScheduleId}` requests. These are unofficial endpoints; mocked protocol/transport tests are not proof of current live Garmin acceptance or watch synchronization.

### Recovering an uncertain write

The example above stops at the per-entry receipts. If one entry comes back `unknown`, the rest of the chain is:

1. **Read the entries.** The batch result reports `status`, `action` and `evidence` per entry. `succeeded` carries a write receipt; `skipped` means the Calendar read already showed that entry.
2. **Query the operation.** `get_garmin_write_operation` takes exactly one of `operationId` or `idempotencyKey`, or neither to page through the newest operations (`limit` defaults to 20, maximum 100). It returns the durable record — which steps are `succeeded`, `unknown`, `prepared` or `not_attempted`, plus `canResume`, `manualReviewRequired` and `nextAction`.
3. **Reconcile.** `reconcile_garmin_write_operation` re-reads Garmin inside a fixed budget (at most 3 reads, 20 seconds) and reports what it observed. It never rewrites `status`: an `observed_present` result satisfies the desired state, but the original step stays `unknown`, because the observation cannot prove this request caused the entry. An empty Calendar read proves nothing, so it never authorizes an automatic re-post.
4. **Resume only the safe steps.** `resume_garmin_write_operation` previews first, exactly like any other write. It arms only steps that were never dispatched; a step whose outcome is unknown is listed as `blocked` and is never re-sent. Confirm the preview with the returned ID to commit the remaining steps.

Never delete the state directory, and never re-issue the same write to "clear" an unknown: neither removes the record, and the second write may duplicate the entry.

### Other examples

- “Show my last five runs.”
- “Compare the last seven complete days of sleep and resting heart rate.”
- “Preview a 3×8-minute threshold workout; wait for my approval before creating it.”
- “Download the FIT file for activity 123456789.” Set `GARMIN_FIT_DOWNLOAD_DIR` first.

## Configuration and troubleshooting

See [.env.example](.env.example) for all environment variables. MCP reads `.env` in its launch working directory; desktop clients should use explicit `env` fields. The login command example uses shell environment variables.

| Symptom | Check |
| --- | --- |
| Client cannot start Node | Use the absolute executable and `lib/mcp.js` paths; GUI apps may not inherit your shell PATH. |
| Username missing | Set `GARMIN_USERNAME` in the launching client's environment. |
| Session missing or expired | Login with the same alias/region and exact destination. |
| Session permissions rejected | Use a private, locally owned destination; keep the runtime's owner-only permissions. |
| Confirmation expired or changed | Request a new preview and obtain approval again. |
| Schedule blocked, `status: "unknown"` | An earlier write for that template/date is unresolved. Do not retry the write: read Garmin Calendar with `get_garmin_calendar`, resolve the pending step with `reconcile_garmin_write_operation`, and only then use `resume_garmin_write_operation` for the steps it reports as safe. A `reconcile` that observes the entry is still not a write receipt — the original step stays `unknown`. |
| Recorded operation not found | `get_garmin_write_operation` returns `OPERATION_NOT_FOUND` for both an unknown ID and an ID belonging to a different account, on purpose. Confirm you are on the account that wrote it and that `GARMIN_STATE_DIR` points at the same directory. |
| New writes refused / state unavailable | Verify `GARMIN_STATE_DIR` is absolute and writable and the journal is under 32 MiB. Do not delete the state directory — see [recovery](docs/calendar-write-recovery.md). |
| FIT export unavailable | Choose a trusted absolute `GARMIN_FIT_DOWNLOAD_DIR`; existing files are never overwritten. |

Activity detail defaults to compact. Full detail may include precise routes/locations. Health estimates are not medical diagnoses. Keep credentials, sessions and personal data outside Git.

## Optional skill and programmatic API

`skills/garmin-connect-mcp/SKILL.md` is neutral usage guidance for clients that support agent skills. Skill installation is client-specific and never a prerequisite for MCP. See [the skill](skills/garmin-connect-mcp/SKILL.md).

The package root exports `createMcpServer`, `GarminClient`, `GarminToolService`, `resolveConfig`, `resolveAccountAlias`, logging helpers and their public types. Importing the package neither loads dotenv nor starts a service. Construct the client as `new GarminClient(config, { logger })`; the logger implements `debug/info/warn/error(message: string)`.

## Development and verification

```bash
npm ci
npm run lint
npm test -- --runInBand
npm run test:coverage
npm run pack:smoke
npm run test:distribution
```

Tests build first. Lint never rewrites files. Packaging audits file contents and obsolete dependencies. CI checks Node 20/22 on Linux and platform behavior on macOS/Windows.

`npm run test:integration` is an explicitly invoked, read-only live check using the same client/session flow. Configure an authenticated account first. It is not run by CI; `GARMIN_INTEGRATION_VERBOSE=true` prints normalized personal data and should only be used deliberately.

For this refactor's actual results and limits, see [verification](docs/verification.md). License and upstream attribution are retained in [LICENSE](LICENSE) and [NOTICE](NOTICE.md).

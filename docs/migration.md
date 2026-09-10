# Migration to standalone MCP 0.2.0

## Existing MCP users

The server name `garmin-connect-mcp`, entry file `lib/mcp.js`, authentication command `garmin-connect-auth`, 14 tools and their complete input schemas remain compatible with baseline `52b67cd`.

Update this checkout and run `npm ci`, then restart the client. Use the same GARMIN_* configuration, alias and session destination. Session formats and default paths have not changed in this refactor; no copying, deletion or re-login is required solely because of this upgrade. Pending confirmations are process-local and expire on restart.

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

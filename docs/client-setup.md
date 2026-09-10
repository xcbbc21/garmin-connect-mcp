# Client setup / 客户端配置

All examples launch the same local stdio server. They are configuration examples, not claims that every client has been end-to-end tested. 本页示例不会自动修改你的客户端配置。

## Prepare

Run `npm ci` in the source checkout, then `command -v node` (Windows: `where node`). Replace every example executable/path/email below. Do not put `~` or shell variables into JSON paths.

For each simultaneously running client, initialize its own session:

```bash
export GARMIN_USERNAME='your@email.com'
node lib/auth-cli.js serve --account personal-codex --region cn --open
node lib/auth-cli.js serve --account personal-claude --region cn --open
```

Use `global` for an international account. Each command is an interactive login. Use the matching session destination; custom configuration-root variables can change the paths shown below.

## Codex

Merge into `~/.codex/config.toml`; preserve unrelated settings:

```toml
[mcp_servers.garmin-connect-mcp]
command = "/absolute/path/to/node"
args = ["/Users/YOUR_USER/garmin-connect-mcp/lib/mcp.js"]

[mcp_servers.garmin-connect-mcp.env]
GARMIN_USERNAME = "your@email.com"
GARMIN_REGION = "cn"
GARMIN_ACCOUNT = "personal-codex"
GARMIN_SESSION_TOKEN_FILE = "/Users/YOUR_USER/.config/garmin-connect-mcp/accounts/personal-codex.session.json"
```

Reload the client, then inspect the saved entry with `codex mcp get garmin-connect-mcp`. Configuration format follows [official Codex MCP documentation](https://developers.openai.com/codex/mcp/).

## Claude Desktop

Merge into `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS. Windows uses `%APPDATA%/Claude/claude_desktop_config.json` and its own absolute executable/session paths.

```json
{
  "mcpServers": {
    "garmin-connect-mcp": {
      "command": "/absolute/path/to/node",
      "args": ["/Users/YOUR_USER/garmin-connect-mcp/lib/mcp.js"],
      "env": {
        "GARMIN_USERNAME": "your@email.com",
        "GARMIN_REGION": "cn",
        "GARMIN_ACCOUNT": "personal-claude",
        "GARMIN_SESSION_TOKEN_FILE": "/Users/YOUR_USER/.config/garmin-connect-mcp/accounts/personal-claude.session.json"
      }
    }
  }
}
```

Quit and reopen the application. The [official local MCP guide](https://modelcontextprotocol.io/docs/develop/connect-local-servers) documents this file and the `mcpServers` structure.

## Other clients

Use the same absolute command, args and env values, with a separately initialized session alias for each concurrent process.

| Client | Configuration example |
| --- | --- |
| Claude Code | Register a user-scoped stdio server; its `add-json` command accepts the inner server object plus `"type": "stdio"`. |
| Cursor | Merge the `mcpServers` example into project `.cursor/mcp.json`; prefer user settings for personal credentials. |
| Windsurf | Add the entry in MCP settings or `~/.codeium/windsurf/mcp_config.json`. |
| WorkBuddy | Merge the same `mcpServers` entry into `~/.workbuddy/mcp.json`; no package-specific adapter or skill is required. |
| ZCode | In MCP settings choose local stdio and enter command/args/env. Native configuration uses `mcp.servers` instead of `mcpServers`. |

Client layouts can change between versions. This refactor does not install clients or claim desktop validation beyond the explicit verification report. WorkBuddy has no special role in the runtime.

## Authentication and optional FIT export

A client that supports URL elicitation can display the local login flow; otherwise run the independent authentication command above. Do not put passwords or inline tokens in these examples. Session credentials remain in local files with private permissions.

On a cold Windows host, the first native permission check may take over a minute
(bounded at 120 seconds). Complete the independent login before starting MCP if
your client's request timeout is shorter; the private-file checks are never skipped.

To enable FIT downloads, add `GARMIN_FIT_DOWNLOAD_DIR` with a trusted, absolute parent directory to that client's env. The returned tool result contains file metadata, not the secret session or complete local path.

After connecting, try “Show my last five runs” or “Preview a workout; wait for confirmation.” Calendar writes always use the server's preview/confirmation mechanism.

## Optional skill

Clients with skill support may load `skills/garmin-connect-mcp` through their own skill mechanism. Ordinary MCP clients can discover and call all 14 tools without it. Installing a skill does not register or start an MCP server.

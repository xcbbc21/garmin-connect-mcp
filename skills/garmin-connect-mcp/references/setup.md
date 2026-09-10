# Local MCP setup / 本地连接

Use the user's checkout of https://github.com/xcbbc21/garmin-connect-mcp.
The unscoped npm package of the same name belongs to a different project;
do not download or run it as a substitute.

1. Verify Node and the checkout. Build with npm ci in the checkout when installation is requested.
2. Configure a local stdio server with an absolute Node path and the absolute lib/mcp.js path.
3. Set GARMIN_USERNAME, GARMIN_REGION (cn/global), GARMIN_ACCOUNT, and the selected session-file path.
4. Initialize browser login with node lib/auth-cli.js serve --account <alias> --region <region> --open.
5. Reload the MCP client and verify tool discovery. A skill alone does not register tools.

Use the same alias, region and destination for login and MCP. Every concurrent client process needs an independently initialized session file. Login has local side effects: browser opening and private session persistence. Follow the user's authorization and the client's approval policy; never ask for passwords, tokens or MFA codes in chat.

The main project provides client configuration examples in docs/client-setup.md. If this skill was copied outside the checkout, find the user's checkout to read that document; do not guess its location.

Clients with URL elicitation may display the login flow automatically on an authentication error. Others need the independent login command. Retry the original request after authentication; never automatically replay a write.

The outer login page uses 127.0.0.1 and embeds Garmin's form. Credentials belong only in the Garmin form. Do not infer the embedded page's origin from the outer address bar alone.

For FIT export, configure a trusted absolute GARMIN_FIT_DOWNLOAD_DIR in the server environment. No path is accepted from the tool call. Keep unrelated client settings intact, and do not commit session files or personal configuration.

# MCP

Streamable HTTP MCP, on while `mcp_enabled` is true (the default; `false` makes both routes `404`):

| Endpoint | Credential | Tool arguments |
|---|---|---|
| `/mcp` (central) | API or OAuth access token | `sessionId` where a tool acts on a session; `tenantId` for a system-admin token or a multi-tenant OAuth grant |
| `/sessions/:sessionId/mcp` (session-bound) | API or OAuth access token, or that session's `aps_…` token | the session is bound from the URL and omitted from the arguments |

Both endpoints use `Authorization: Bearer ...`. Central MCP accepts Aperture API tokens and OAuth access tokens. Session-bound MCP additionally accepts that session's `sessionToken`. Resource allowlists apply before a tool reaches a session or snapshot. OAuth grants are rechecked against the consenting user’s current memberships and scopes on each request.

## OAuth

MCP clients such as ChatGPT, Codex, and Claude can connect with only the MCP URL. When browser login is configured, an unauthenticated request returns `401` with `WWW-Authenticate: Bearer resource_metadata="<base>/.well-known/oauth-protected-resource/mcp"`, and the client discovers the authorization server at `/.well-known/oauth-authorization-server`. Aperture supports dynamic client registration (`POST /oauth/register`), client ID metadata documents (an `https` URL as `client_id`), authorization code with PKCE `S256`, rotating refresh tokens, and revocation (`POST /oauth/revoke`).

`/oauth/authorize` sends the user to the consent page at `/oauth/consent`. The signed-in user picks one or more of their tenants, scopes, and either all resources or specific sessions and snapshots; a system administrator may instead opt in to full system administrator access. In each tenant the client gets the chosen scopes the user still holds there, rechecked on every request, so disabling the user or removing a membership takes effect immediately. Users review and revoke connected apps from the account menu.

Access tokens (`apo_...`) last one hour and refresh tokens (`apr_...`) 30 days; each refresh issues a new pair. A client granted several tenants passes `tenantId` to tools; with one tenant it may omit it. OAuth clients cannot create API tokens.

`tools/list` is the catalog with descriptions and schemas; the names, grouped:

- Native, on both endpoints: `sessions.status`, `sessions.connection` (`cdpUrl`, `sessionToken`, `media`), `sessions.suspend`, `browser.targets`, `cursor.get`, `cursor.set`, `session_files.list`, `session_files.create_download_url`, `recording.start`, `recording.list`, `recording.status`, `recording.retarget`, `recording.stop`, `recording.caption`, `recording.focus`, `recording.attention`. `sessions.promote` too, except for a session token.
- Native, central only: the rest of `sessions.*` (`create`, `create_from_snapshot`, `list`, `get`, `bulk_get`, `reopen`, `replace_tags`, `delete`, `session_token_rotate`), `snapshots.*`, `events.list`, `browser.channels`, `tenant.*`, `tenants.*`, `tokens.*`.
- Browser tools: Playwright MCP's `browser_*` tools, for the session named by the arguments or the URL.

Status, connection, list and bulk tools read without waking a suspended session; browser tools, `browser.targets` and recording tools wake it for the call. Connecting and listing tools never wake anything.

## Browser tools

The set is chosen when the connection is established and fixed for its lifetime; open a new connection to change it:

```text
/mcp?browserTools=core,vision,network          (the default)
/sessions/$SESSION_ID/mcp?browserTools=core,storage
```

Profiles are `core`, `vision`, `network` and `storage`. Playwright MCP starts lazily on the first browser call and stays attached to that browser session.

Aperture owns the browser process, so Playwright's browser close, browser install and arbitrary code execution tools are absent (stop a session with `sessions.suspend` or `sessions.delete`), and page-provided WebMCP tools are off. File arguments and results are session file paths, never host paths: automatically named output lands under `outputs/`, an explicit file name lands at that path, and `browser_file_upload` takes any session file `relativePath` ([session-files.md](session-files.md)).

When Playwright had to retry an action because its checks failed (the element was covered, moving, hidden or outside the view), the tool's result ends with a note naming the reasons. Each retry scrolled the element again, so clear the way before acting the next time, especially while recording.

A tool result is capped at `tool_output_max_bytes` (16 MiB by default).

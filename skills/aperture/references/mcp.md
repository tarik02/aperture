# MCP

Streamable HTTP MCP, on while `mcp_enabled` is true (the default; `false` makes both routes `404`):

| Endpoint | Credential | Tool arguments |
|---|---|---|
| `/mcp` (central) | API token | `sessionId` where a tool acts on a session; `tenantId` only on a system-admin token |
| `/sessions/:sessionId/mcp` (session-bound) | API token or that session's `aps_…` token | the session is bound from the URL and omitted from the arguments |

Resource allowlists on the API token apply before any tool reaches a session or snapshot. `tools/list` is the catalog with descriptions and schemas; the names, grouped:

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

A tool result is capped at `tool_output_max_bytes` (16 MiB by default).

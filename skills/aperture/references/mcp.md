# MCP

Aperture exposes Streamable HTTP MCP when `mcp_enabled` is true (the default):

- central management MCP: `/mcp`
- session-bound MCP: `/sessions/:sessionId/mcp`

Both endpoints use `Authorization: Bearer ...`. Central MCP accepts Aperture API tokens only. Session-bound MCP accepts either an authorized API token or that session's `sessionToken`. Apply the authority, tenant-selection, and resource-grant rules from [authentication.md](authentication.md).

Central tools take `tenantId` or `sessionId` where required and expose management, session, snapshot, event, and session-file workflows. Session-bound MCP binds the session from the URL and omits `sessionId` from tool inputs. A session token can use only tools for its bound session.

Central and session-bound MCP apply API token resource grants before native or Playwright tools reach a session or snapshot. `tokens.create` accepts `resourceMode` and `resourceGrants` with the same rules as the REST API.

Browser tool profiles are selected when the MCP connection is established with the `browserTools` query parameter:

```text
/mcp?browserTools=core,vision,network
/sessions/$SESSION_ID/mcp?browserTools=core,vision
```

The default is `core,vision,network`; `storage` is also available. `vision` no longer lists tools (coordinate input moved into the pointer tools below) and is accepted only so existing connections keep working. Profiles are validated at connection time and remain fixed for that connection. Open a new connection to change profiles. Browser calls wake the target session for the call duration; connecting and listing tools do not wake it. Playwright MCP starts lazily and remains attached for that browser session.

Pointer tools `browser_click`, `browser_move`, `browser_drag`, and `browser_scroll` replace Playwright's `browser_click`, `browser_hover`, `browser_drag`, and `browser_mouse_*`, and are in `core`. Each takes an element (`target`: a snapshot ref or selector, with an optional `element` description) or viewport CSS pixels (`x`, `y`); `browser_drag` takes `startTarget`/`startX`/`startY` and `endTarget`/`endX`/`endY`. Targets are scrolled into view and must be visible, stable, not covered, and (for clicks) enabled, so a covered, disabled, or stale-ref target fails with Playwright's explanation instead of clicking. `browser_click` also takes `button`, `clickCount` (1-3), `modifiers`, and `holdMs`; `browser_scroll` takes exact `deltaX`/`deltaY` and defaults to the viewport center. In a session with a compositor the visible pointer glides along an eased, slightly curved path and presses real buttons and keys; `motion` (`natural` by default, `fast`, `instant`, or `{durationMs}`) sets how it travels. Without a compositor the same calls go through Playwright's mouse and `motion` is ignored. Every tool that changes something (navigate, type, click, and so on; not snapshots or other reads) also takes an optional `caption` (at most 500 characters) describing the step. It is not passed to the tool; it appears in the recording's timeline when a recording runs (see [recordings.md](recordings.md)).

Browser close, browser installation, and arbitrary Playwright-process code execution tools are excluded because Aperture owns the browser lifecycle and does not expose host-process execution. Use `sessions.suspend` or `sessions.delete` to stop a browser session. File references returned by browser tools are session file relative paths (see [session-files.md](session-files.md)) rather than host filesystem paths; automatically named output lands under `outputs/`. `browser_file_upload` accepts any session file relative path, including downloads, recordings, and uploads. Page-provided WebMCP tools are disabled because Aperture exposes a static, authorized browser-tool surface.

Native tool names include `sessions.create`, `sessions.create_from_snapshot`, `sessions.list`, `sessions.get`, `sessions.bulk_get`, `sessions.status`, `sessions.connection`, `sessions.suspend`, `sessions.reopen`, `sessions.replace_tags`, `sessions.delete`, `sessions.promote`, `sessions.session_token_rotate`, `snapshots.list`, `snapshots.get`, `snapshots.update`, `snapshots.delete`, `snapshots.replace_tags`, `snapshots.restore`, `events.list`, `session_files.list`, `session_files.create_download_url`, `recording.start`, `recording.list`, `recording.status`, `recording.retarget`, `recording.stop`, `browser.channels`, `browser.targets`, `tenant.get`, `tenant.update`, `tenants.list`, `tenants.create`, `tenants.update`, `tenants.delete`, `tenants.restore`, `tokens.list`, `tokens.create`, and `tokens.revoke`.

MCP tool output is capped at `tool_output_max_bytes` (16 MiB by default). Set `mcp_enabled = false` to make both MCP routes return `404`.

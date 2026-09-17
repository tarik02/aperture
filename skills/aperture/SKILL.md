---
name: aperture
description: Operate an Aperture instance — browser sessions, snapshots, recordings, live view, CDP, and session files — over its MCP server or its HTTP API. Use for session lifecycle, tenant and token administration, viewport control, target-scoped recording, and downloading session files.
---

# Aperture

Aperture supervises remote Chromium sessions. A session is created from a browser
configuration (or a snapshot), driven over CDP or the live-session protocol, optionally
recorded, and finally promoted to a snapshot or deleted.

## Pick a route

| Route | Use when | Read |
| --- | --- | --- |
| MCP | An Aperture MCP server is connected to this client | `references/mcp.md` |
| HTTP API | No MCP server, or scripting with curl / your own client | `references/api.md` |
| Live session | Driving a browser interactively: WebSocket, WebRTC, CDP | `references/live-session.md` |

MCP and the HTTP API cover the same management surface, so prefer MCP when it is
available and read its tool schemas instead of restating request bodies. Drop to the
HTTP API for anything MCP does not expose, and to the live-session routes whenever you
need real-time input, presentation frames, or a CDP connection.

## Instance and credentials

Every request goes to the instance's public origin:

```bash
export APERTURE_BASE_URL="https://aperture.example.com"
```

- control plane: `$APERTURE_BASE_URL/api/*`
- central MCP: `$APERTURE_BASE_URL/mcp`
- live session data plane: `$APERTURE_BASE_URL/sessions/:sessionId/*`
- session-bound MCP: `$APERTURE_BASE_URL/sessions/:sessionId/mcp`

`/internal/*` is implementation-only; never call it.

API tokens (`apt_...`) go in `Authorization: Bearer`. A system-admin token must also
select a tenant with `X-Aperture-Tenant-Id`; a tenant token must not send that header.
Session-bound credentials (`aps_` session token, `ape_` editor, `apv_` viewer) authorize
only their own session's live routes, never `/api/*` or central MCP.

See `references/api.md` for scopes, delegation, and resource allowlists.

## Typical flow

1. `GET /api/browser/configurations` — pick a launchable `channel` + `mode` pair.
2. Create the session; keep `connection.cdpUrl` and `connection.sessionToken`.
3. Drive it over CDP, the live-session WebSocket, or MCP agent-browser tools.
4. Record and download through the session's recording and file routes.
5. Promote the session to a snapshot, or suspend/delete it.

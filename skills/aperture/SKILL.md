---
name: aperture
description: Use this skill when an agent needs to operate Aperture via its HTTP REST/WebSocket/MCP API: health checks, authentication, tenants, tokens, browser channels, sessions, snapshots, events, MCP tools, CDP proxy routes, WebRTC signaling, viewport resize, screencast control, or session files.
---

# Aperture API

## Auth

Send API tokens as:

```bash
Authorization: Bearer $APERTURE_TOKEN
```

Tenant-scoped operations require an effective tenant:

```bash
X-Aperture-Tenant-Id: $TENANT_ID
```

Tenant tokens already bind to one tenant; system-admin tokens must pass `X-Aperture-Tenant-Id` for tenant-scoped endpoints.

Scopes:

- `system:admin`: full access, required for `/api/admin/*`
- `tenants:write`: system-admin tenant administration
- `tenant:write`: tenant self-management and tenant token management
- `sessions:read`, `sessions:write`
- `snapshots:read`, `snapshots:write`

## Response Shapes

Errors are JSON with an error code/message, handled by `WriteError`.

Paginated list responses:

```json
{
  "data": [],
  "meta": {
    "nextCursor": null
  }
}
```

Common pagination/filter params:

- `limit`, `cursor`
- `includeDeleted=true`
- sessions: `status=creating|running|deleted|expired|failed`
- snapshots: `deleted=active|deleted|all`
- tag filters: repeat `tagKey`, `tagValue`, optional `tagOperator=eq|ne|in|not_in`

## Core Endpoints

Path namespaces:

- UI: `/-/*` (`/-/sessions`, `/-/sessions/:sessionId`, `/-/snapshots`, `/-/tokens`, `/-/tenants`)
- REST API: `/api/*`
- live session data plane: `/sessions/:sessionId/*`
- internal proxy/auth/job routes: `/internal/*`

Health:

- `GET /api/health` -> `{"status":"ok"}`

Current principal:

- `GET /api/auth/me`

Browser channels:

- `GET /api/browser/channels`

System admin:

- `POST /api/admin/tenants` body `{ "displayName": "Acme" }`
- `GET /api/admin/tenants`
- `PATCH /api/admin/tenants/:tenantId` body `{ "displayName": "New name" }`
- `DELETE /api/admin/tenants/:tenantId`
- `POST /api/admin/tenants/:tenantId/restore`
- `POST /api/admin/tokens`
- `GET /api/admin/tokens`
- `POST /api/admin/tokens/:tokenId/revoke`

Tenant self:

- `GET /api/tenant`
- `PATCH /api/tenant` body `{ "displayName": "New name" }`
- `POST /api/tenant/tokens`
- `GET /api/tenant/tokens`
- `POST /api/tenant/tokens/:tokenId/revoke`

Token creation body:

```json
{
  "name": "agent",
  "authorityType": "tenant",
  "tenantId": "optional-for-tenant-token-from-admin-route",
  "scopes": ["sessions:read", "sessions:write"],
  "expiresAt": "optional RFC3339Nano"
}
```

Tenant-local token body omits `authorityType` and `tenantId`:

```json
{ "name": "agent", "scopes": ["sessions:read"], "expiresAt": null }
```

Token creation returns `rawToken` once. Store it immediately if needed.

## MCP

Aperture exposes Streamable HTTP MCP when `mcp_enabled` is true (the default):

- central management MCP: `POST /mcp`
- session-bound MCP: `POST /sessions/:sessionId/mcp`

Both endpoints use `Authorization: Bearer ...`. The central endpoint accepts Aperture API tokens only. The session endpoint accepts either an authorized API token or that session's `sessionToken`.

Central MCP tools take an explicit `tenantId` where needed and expose management, session, snapshot, event, and session-file workflows. Session-bound MCP binds the session from the URL and omits `sessionId` from tool input; a session token can use only the tools for that session and cannot access central management MCP or `/api/*`.

The `sessionToken` is the live credential for exactly one session. It authorizes that session's routed live endpoints through forward auth, including CDP, WebRTC signaling, and per-session MCP; it does not authorize `/api/*`. Rotate it with `POST /api/sessions/:sessionId/session-token/rotate`.

Agent-browser tools are selected when the MCP connection is established with the `agentBrowserTools` query parameter:

```text
/mcp?agentBrowserTools=core,tabs,mobile,network
/sessions/$SESSION_ID/mcp?agentBrowserTools=core,tabs
```

The default is `core,tabs,mobile,network`. Profiles are validated at connection time; an invalid profile fails the request. Filtering is static for the lifetime of the MCP connection, so open a new connection to change profiles. Browser calls wake the target session for the call duration; listing tools and connecting do not wake it.

Native MCP tool names include `sessions.create`, `sessions.create_from_snapshot`, `sessions.list`, `sessions.get`, `sessions.bulk_get`, `sessions.status`, `sessions.connection`, `sessions.suspend`, `sessions.delete`, `sessions.promote`, `sessions.session_token_rotate`, `snapshots.list`, `snapshots.get`, `events.list`, `session_files.list`, and `session_files.create_download_url`, plus authorized tenant and token administration tools. Session-bound MCP additionally provides `sessions.status`, `sessions.connection`, `sessions.suspend`, and (for API-token callers with the required scopes) `sessions.promote`.

MCP tool output is capped at `tool_output_max_bytes` (16 MiB by default). Set `mcp_enabled = false` to make both MCP routes return `404`.

## Sessions

List:

- `GET /api/sessions`

Create:

- `POST /api/sessions`

```json
{
  "label": "optional label",
  "baseSnapshotName": "optional snapshot name",
  "browser": {
    "channel": "chromium",
    "args": []
  },
  "tags": {
    "key": "value"
  }
}
```

Create returns:

```json
{
  "session": {
    "id": "...",
    "tenantId": "...",
    "status": "running",
    "media": {
      "mode": "auto",
      "webrtcProducer": true,
      "iceServers": []
    },
    "cdpUrl": "..."
  },
  "cdpUrl": "...",
  "sessionToken": "..."
}
```

Mutations:

- `DELETE /api/sessions/:sessionId`
- `PUT /api/sessions/:sessionId/tags` body `{ "tags": { "key": "value" } }`
- `POST /api/sessions/:sessionId/reopen`
- `POST /api/sessions/:sessionId/session-token/rotate`
- `POST /api/sessions/:sessionId/promote`

Promote body:

```json
{ "name": "snapshot-name", "force": false, "tags": {} }
```

## Session Wrapper API

These live-session routes are forwarded to the per-session `browser-session-wrapper` through the forward-auth/session-token model. Routed requests are authorized for the session; WebRTC signaling accepts the bound `sessionToken`.

- `GET /sessions/:sessionId/browser/status`
- `POST /sessions/:sessionId/browser/viewport`
- `GET /sessions/:sessionId/webrtc/signal?role=viewer`
- `POST /sessions/:sessionId/screencast/start`
- `POST /sessions/:sessionId/screencast/stop` returns the recorded WebM attachment
- `GET /sessions/:sessionId/screencast/status`

Viewport body:

```json
{ "width": 1280, "height": 720 }
```

Screencast start body:

```json
{
  "fps": 60,
  "bitrateKbps": 6000,
  "codec": "vp8",
  "path": "/absolute/path/optional.webm"
}
```

`codec` may be `vp8` or `h264-va`. If `path` is omitted, the wrapper writes into the session's `recordings` directory. Browser downloads are written into that session's `downloads` directory.

WebRTC signaling is a WebSocket endpoint. Use subprotocols:

- `aperture-webrtc.v1`
- `authorization.bearer.$SESSION_TOKEN`
- session tokens are bound to the session and do not need a tenant header

## Snapshots

- `GET /api/snapshots`
- `DELETE /api/snapshots/:name`
- `PUT /api/snapshots/:name/tags` body `{ "tags": { "key": "value" } }`
- `POST /api/snapshots/:name/restore`

## Events

- `GET /api/events`

Filters:

- `resourceType`
- `resourceId`
- plus pagination params

## CDP Proxy

Live CDP discovery proxy:

- `/sessions/:sessionId/cdp`
- `/sessions/:sessionId/cdp/*path`

The CDP proxy uses session token auth.

## Session Files

Session files are limited to regular files below the session's `downloads` and `recordings` directories. Recordings created by the screencast wrapper and browser downloads are both included.

Through MCP:

- central `session_files.list` takes `tenantId` and `sessionId`
- central `session_files.create_download_url` takes `tenantId`, `sessionId`, `relativePath`, and optional `ttlSeconds`
- session-bound versions omit `tenantId` and `sessionId` and bind them from `/sessions/:sessionId/mcp`

`session_files.list` returns `name`, `relativePath`, `size`, `modifiedAt`, and `mimeType`. MCP returns metadata and signed URLs rather than large file contents.

Signed downloads use:

```text
/sessions/:sessionId/files/<relative-path>?token=...
```

The URL is bound to the exact session and relative path. Omitting `ttlSeconds` uses `signed_file_url_ttl` (15 minutes); callers may request any positive lifetime up to `signed_file_url_max_ttl` (24 hours), including one longer than the default. The route validates the signature, expiry, path, and session file root before serving an attachment.

## Curl Patterns

Health:

```bash
curl -fsS http://polygon:28081/api/health
```

List sessions:

```bash
curl -fsS \
  -H "Authorization: Bearer $APERTURE_TOKEN" \
  -H "X-Aperture-Tenant-Id: $TENANT_ID" \
  "http://polygon:28081/api/sessions?limit=20"
```

Resize a session viewport:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $APERTURE_TOKEN" \
  -H "X-Aperture-Tenant-Id: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{"width":1280,"height":720}' \
  "http://polygon:28081/sessions/$SESSION_ID/browser/viewport"
```

Start screencast:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $APERTURE_TOKEN" \
  -H "X-Aperture-Tenant-Id: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{"fps":60,"bitrateKbps":6000,"codec":"vp8"}' \
  "http://polygon:28081/sessions/$SESSION_ID/screencast/start"
```

Stop and download screencast:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $APERTURE_TOKEN" \
  -H "X-Aperture-Tenant-Id: $TENANT_ID" \
  -o "screencast-$SESSION_ID.webm" \
  "http://polygon:28081/sessions/$SESSION_ID/screencast/stop"
```

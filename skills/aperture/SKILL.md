---
name: aperture
description: Use this skill when an agent needs to operate Aperture via its HTTP REST/WebSocket API: health checks, authentication, tenants, tokens, browser channels, sessions, snapshots, events, CDP proxy routes, WebRTC signaling, viewport resize, or screencast control.
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

These routes are authenticated through the main API and forwarded to the per-session `browser-session-wrapper`.

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

`codec` may be `vp8` or `h264-va`. If `path` is omitted, the wrapper writes into the session artifacts directory.

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

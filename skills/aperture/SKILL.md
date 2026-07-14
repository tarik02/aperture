---
name: aperture
description: Operate an Aperture instance through its public HTTP and WebSocket APIs. Use for authentication, tenant and token administration, browser channels, session lifecycle, snapshots, events, CDP discovery/proxying, WebRTC signaling, viewport control, and screencast recording.
---

# Aperture API

Use the instance's public origin for every request:

```bash
export APERTURE_BASE_URL="https://aperture.example.com"
```

Public surfaces:

- control plane: `$APERTURE_BASE_URL/api/*`
- live session data plane: `$APERTURE_BASE_URL/sessions/:sessionId/*`

Treat `/internal/*` as implementation-only. Do not call it directly.

## Authentication

Send API tokens on HTTP requests:

```http
Authorization: Bearer $APERTURE_TOKEN
```

Tenant tokens are already bound to their tenant. System-admin tokens must select a tenant for tenant-scoped operations:

```http
X-Aperture-Tenant-Id: $TENANT_ID
```

Do not send another tenant ID with a tenant token; a mismatched tenant selection is rejected.

Authorities are `system_admin` and `tenant`. Current scope behavior:

- `system:admin`: grants every scope and is required by `/api/admin/*`
- `tenant:write`: tenant self-management and tenant token management; only tenant-authority tokens may use `/api/tenant*`
- `sessions:read`, `sessions:write`: session control-plane and live data-plane access
- `snapshots:read`, `snapshots:write`: snapshot access
- `tenants:write`: accepted only on system-admin tokens, but does not replace `system:admin` for current admin routes

Creating a session from a snapshot also requires `snapshots:read`. Promoting a session requires both `sessions:write` and `snapshots:write`.

## Response Conventions

Public API errors use:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "..."
  }
}
```

Paginated responses use:

```json
{
  "data": [],
  "meta": {
    "limit": 50,
    "nextCursor": "optional cursor",
    "hasMore": false
  }
}
```

Pass `limit` and `cursor` to paginated endpoints. Treat cursors as opaque.

## General Endpoints

- `GET /api/health` — unauthenticated health check; `status` is `ok` when healthy
- `GET /api/auth/me` — authenticated principal and selected tenant
- `GET /api/browser/channels` — available browser channel names; requires `sessions:read`
- `GET /api/events` — paginated tenant events; requires `sessions:read`

Event filters:

- `resourceType`
- `resourceId`

## Tenants and API Tokens

System administration, requiring a system-admin token:

- `POST /api/admin/tenants`
- `GET /api/admin/tenants`
- `PATCH /api/admin/tenants/:tenantId`
- `DELETE /api/admin/tenants/:tenantId`
- `POST /api/admin/tenants/:tenantId/restore`
- `POST /api/admin/tokens`
- `GET /api/admin/tokens`
- `POST /api/admin/tokens/:tokenId/revoke` — returns `204`

Tenant self-service, requiring a tenant token with `tenant:write`:

- `GET /api/tenant`
- `PATCH /api/tenant`
- `POST /api/tenant/tokens`
- `GET /api/tenant/tokens`
- `POST /api/tenant/tokens/:tokenId/revoke` — returns `204`

Tenant create/update body:

```json
{ "displayName": "Acme" }
```

Admin token creation body:

```json
{
  "name": "agent",
  "authorityType": "tenant",
  "tenantId": "required for tenant authority",
  "scopes": ["sessions:read", "sessions:write"],
  "expiresAt": "optional RFC3339Nano timestamp"
}
```

Tenant-local token creation omits `authorityType` and `tenantId`:

```json
{
  "name": "agent",
  "scopes": ["sessions:read"],
  "expiresAt": null
}
```

Token creation returns `{ "token": {...}, "rawToken": "apt_..." }`. The raw token is returned only on creation; persist it immediately when required.

Tenant and token lists are paginated. Tenant lists accept `deleted=active|deleted|all` or `includeDeleted=true`. Token lists accept `name`, `scope`, `revoked=active|revoked|all`; the admin list also accepts `tenantId` and `authorityType=system_admin|tenant`.

## Sessions

Endpoints:

- `GET /api/sessions` — paginated list
- `POST /api/sessions/bulk` — fetch up to 100 unique UUIDv7 session IDs
- `GET /api/sessions/:sessionId`
- `POST /api/sessions` — create
- `DELETE /api/sessions/:sessionId`
- `PUT /api/sessions/:sessionId/tags` — replace all tags
- `POST /api/sessions/:sessionId/suspend`
- `POST /api/sessions/:sessionId/reopen`
- `POST /api/sessions/:sessionId/cdp-token/rotate`
- `POST /api/sessions/:sessionId/promote`

Session list filters:

- `includeDeleted=true`
- `status=creating|running|suspended|deleted|expired|failed`
- repeated tag filters: matching `tagKey`, `tagValue`, and optional `tagOperator=eq|ne|in|not_in`

Bulk request:

```json
{ "ids": ["01900000-0000-7000-8000-000000000001"] }
```

Create request:

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

`browser.channel` is required. Use `GET /api/browser/channels` rather than assuming a channel name.

Create returns `201`:

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
    "cdpUrl": "https://aperture.example.com/sessions/.../cdp",
    "cdpToken": "cdp_..."
  },
  "cdpUrl": "https://aperture.example.com/sessions/.../cdp",
  "cdpToken": "cdp_..."
}
```

Session reads may include `cdpUrl` and `cdpToken` while retained CDP access is available. Suspend, reopen, and CDP-token rotation return `{ "session": {...}, "cdpUrl": "...", "cdpToken": "..." }`; other mutations return `{ "session": {...} }`.

Promotion body:

```json
{
  "name": "snapshot-name",
  "description": "optional description",
  "force": false,
  "tags": {}
}
```

Promotion returns `{ "snapshot": {...} }`.

## Snapshots

- `GET /api/snapshots` — paginated list
- `PATCH /api/snapshots/:name` — update description
- `DELETE /api/snapshots/:name`
- `PUT /api/snapshots/:name/tags` — replace all tags
- `POST /api/snapshots/:name/restore`

Description update body:

```json
{ "description": "new description or null" }
```

Mutation responses use `{ "snapshot": {...} }`.

Snapshot list filters:

- `deleted=active|deleted|all` or `includeDeleted=true`
- repeated `tagKey`, `tagValue`, and optional `tagOperator`

## Live Session Data Plane

These public routes are forwarded to the running session wrapper:

- `GET /sessions/:sessionId/browser/status` — `sessions:read`
- `POST /sessions/:sessionId/browser/viewport` — `sessions:write`
- `GET /sessions/:sessionId/webrtc/signal?role=viewer` — WebSocket, `sessions:write`
- `POST /sessions/:sessionId/screencast/start` — `sessions:write`
- `POST /sessions/:sessionId/screencast/stop` — `sessions:write`, returns a WebM attachment
- `GET /sessions/:sessionId/screencast/status` — `sessions:write`

Use the normal bearer and tenant headers for HTTP data-plane routes.

Viewport body:

```json
{
  "width": 1280,
  "height": 720,
  "deviceScaleFactor": 1
}
```

The viewport response reports logical and physical dimensions plus the effective scale.

Screencast start body:

```json
{
  "fps": 60,
  "bitrateKbps": 6000,
  "codec": "vp8",
  "path": "/optional/absolute/output.webm"
}
```

Supported codecs are `vp8` and `h264-va`. Omitted or non-positive FPS/bitrate values use instance defaults. Screencast start/status return fields such as `active`, `path`, `startedAt`, `stoppedAt`, `fps`, `codec`, and `sizeBytes` when applicable.

## CDP Proxy

CDP uses the session-specific `cdpToken`, not the Aperture API bearer token. Append the token as the next path segment after the returned `cdpUrl`:

```bash
curl -fsS "$CDP_URL/$CDP_TOKEN/json/version"
curl -fsS "$CDP_URL/$CDP_TOKEN/json/list"
```

Discovery responses contain rewritten WebSocket debugger URLs under the same tokenized public path. Connect to those URLs without an `Authorization` header or WebSocket subprotocol.

Rotate a compromised CDP token with `POST /api/sessions/:sessionId/cdp-token/rotate`; previously issued CDP URLs then stop authorizing.

## WebRTC Signaling

Connect to:

```text
wss://aperture.example.com/sessions/:sessionId/webrtc/signal?role=viewer
```

Send these WebSocket subprotocols:

- `aperture-webrtc.v1`
- `authorization.bearer.$APERTURE_TOKEN`
- `x-aperture-tenant-id.$TENANT_ID` when using a system-admin token

The selected WebSocket protocol is `aperture-webrtc.v1`. Only the `viewer` role is accepted, and a new viewer replaces the previous viewer for that session.

## Generic Curl Patterns

Health:

```bash
curl -fsS "$APERTURE_BASE_URL/api/health"
```

List sessions with a system-admin token:

```bash
curl -fsS \
  -H "Authorization: Bearer $APERTURE_TOKEN" \
  -H "X-Aperture-Tenant-Id: $TENANT_ID" \
  "$APERTURE_BASE_URL/api/sessions?limit=20"
```

Suspend a session with a tenant token:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $APERTURE_TOKEN" \
  "$APERTURE_BASE_URL/api/sessions/$SESSION_ID/suspend"
```

Resize a viewport:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $APERTURE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"width":1280,"height":720,"deviceScaleFactor":1}' \
  "$APERTURE_BASE_URL/sessions/$SESSION_ID/browser/viewport"
```

Stop and download a screencast:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $APERTURE_TOKEN" \
  -o "screencast-$SESSION_ID.webm" \
  "$APERTURE_BASE_URL/sessions/$SESSION_ID/screencast/stop"
```

Add `X-Aperture-Tenant-Id` to tenant-scoped examples when using a system-admin token.

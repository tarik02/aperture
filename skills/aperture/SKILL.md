---
name: aperture
description: Operate an Aperture instance through its public HTTP, WebSocket, and MCP APIs. Use for authentication, tenant and token administration, browser configurations, session lifecycle, snapshots, events, MCP tools, CDP discovery/proxying, WebRTC signaling, viewport control, target-scoped recording, and session files.
---

# Aperture API

Use the instance's public origin for every request:

```bash
export APERTURE_BASE_URL="https://aperture.example.com"
```

Public surfaces:

- control plane: `$APERTURE_BASE_URL/api/*`
- central MCP: `$APERTURE_BASE_URL/mcp`
- live session data plane: `$APERTURE_BASE_URL/sessions/:sessionId/*`
- session-bound MCP: `$APERTURE_BASE_URL/sessions/:sessionId/mcp`

Treat `/internal/*` as implementation-only. Do not call it directly.

## Authentication

Send API tokens on HTTP requests:

```http
Authorization: Bearer $APERTURE_TOKEN
```

The web UI can use server-side account sessions established through OIDC, a registered passkey, or email/password. Passkey registration and password setup require an existing account session and never provision a user. TOTP and one-time recovery codes can protect password login. These cookie sessions authorize same-origin UI, API, and live-session requests, but not MCP clients.

Tenant tokens are already bound to their tenant. System-admin tokens must select a tenant for tenant-scoped operations:

```http
X-Aperture-Tenant-Id: $TENANT_ID
```

Do not send `X-Aperture-Tenant-Id` with a tenant token. In MCP tool arguments, omit `tenantId`; any explicit tenant selection is rejected.

Authorities are `system_admin` and `tenant`. Current scope behavior:

- `system:admin`: grants every scope and is required by `/api/admin/*`
- `tenant:write`: tenant self-management and tenant token management; only tenant-authority tokens may use `/api/tenant*`
- `sessions:read`, `sessions:write`: session control-plane and live data-plane access
- `snapshots:read`, `snapshots:write`: snapshot access
- `tenants:write`: accepted only on system-admin tokens, but does not replace `system:admin` for current admin routes

Creating a session from a snapshot also requires `snapshots:read`. Promoting a session requires both `sessions:write` and `snapshots:write`.

API tokens use `apt_<tokenId>_<secret>`. The `sessionToken` uses `aps_<sessionId>_<secret>` and is bound to exactly one session. It authorizes that session's routed live endpoints through forward auth, including CDP, WebRTC signaling, and per-session MCP. It does not authorize `/api/*` or central MCP.

Authenticated API and MCP token creation delegates the caller's authority. A child cannot add scopes, cross a tenant boundary, or outlive an expiring parent token. A resource-restricted parent can create only another `allowlist` token whose grants are a subset of its own. Token metadata identifies the creating principal in `createdByType` and `createdById`; `parentTokenId` identifies the API token used for delegation.

Tenant API tokens support `resourceMode: "all"` or `resourceMode: "allowlist"`. Allowlist grants use `{ "resourceType": "session" | "snapshot", "resourceId": "<UUIDv7>" }`. Authorization requires the tenant boundary, action scope, and matching resource grant. System-admin tokens cannot use allowlists. Restricted session, snapshot, bulk, and event lists filter ungranted rows before pagination; direct access returns `resource_access_denied`. `GET /api/tenant` remains available, but restricted tokens cannot mutate the tenant.

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
- `GET /api/browser/configurations` — launchable browser channel and mode pairs with prospective capabilities; requires `sessions:read`
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
  "resourceMode": "allowlist",
  "resourceGrants": [
    { "resourceType": "session", "resourceId": "01900000-0000-7000-8000-000000000001" }
  ],
  "expiresAt": "optional RFC3339Nano timestamp"
}
```

Tenant-local token creation omits `authorityType` and `tenantId`:

```json
{
  "name": "agent",
  "scopes": ["sessions:read"],
  "resourceMode": "all",
  "resourceGrants": [],
  "expiresAt": null
}
```

Token creation returns `{ "token": {...}, "rawToken": "apt_..." }`. The raw token is returned only on creation; persist it immediately when required.

Tenant and token lists are paginated. Tenant lists accept `deleted=active|deleted|all` or `includeDeleted=true`. Token lists accept `name`, `scope`, `revoked=active|revoked|all`; the admin list also accepts `tenantId` and `authorityType=system_admin|tenant`.

## MCP

Aperture exposes Streamable HTTP MCP when `mcp_enabled` is true (the default):

- central management MCP: `/mcp`
- session-bound MCP: `/sessions/:sessionId/mcp`

Both endpoints use `Authorization: Bearer ...`. Central MCP accepts Aperture API tokens only. Session-bound MCP accepts either an authorized API token or that session's `sessionToken`.

Central tools take `tenantId` or `sessionId` where required and expose management, session, snapshot, event, and session-file workflows. Session-bound MCP binds the session from the URL and omits `sessionId` from tool inputs. A session token can use only tools for its bound session.

Central and session-bound MCP apply API token resource grants before native or agent-browser tools reach a session or snapshot. `tokens.create` accepts `resourceMode` and `resourceGrants` with the same rules as the REST API.

Agent-browser tools are selected when the MCP connection is established with the `agentBrowserTools` query parameter:

```text
/mcp?agentBrowserTools=core,tabs,mobile,network
/sessions/$SESSION_ID/mcp?agentBrowserTools=core,tabs
```

The default is `core,tabs,mobile,network`. Profiles are validated at connection time and remain fixed for that connection. Open a new connection to change profiles. Browser calls wake the target session for the call duration; connecting and listing tools do not wake it.
`agent_browser_close` is excluded because Aperture owns the browser session lifecycle. Use `sessions.suspend` or `sessions.delete` instead.

Native tool names include `sessions.create`, `sessions.create_from_snapshot`, `sessions.list`, `sessions.get`, `sessions.bulk_get`, `sessions.status`, `sessions.connection`, `sessions.suspend`, `sessions.reopen`, `sessions.replace_tags`, `sessions.delete`, `sessions.promote`, `sessions.session_token_rotate`, `snapshots.list`, `snapshots.get`, `snapshots.update`, `snapshots.delete`, `snapshots.replace_tags`, `snapshots.restore`, `events.list`, `session_files.list`, `session_files.create_download_url`, `recording.start`, `recording.list`, `recording.status`, `recording.stop`, `browser.configurations`, `tenant.get`, `tenant.update`, `tenants.list`, `tenants.create`, `tenants.update`, `tenants.delete`, `tenants.restore`, `tokens.list`, `tokens.create`, and `tokens.revoke`.

MCP tool output is capped at `tool_output_max_bytes` (16 MiB by default). Set `mcp_enabled = false` to make both MCP routes return `404`.

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
- `POST /api/sessions/:sessionId/session-token/rotate`
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
    "mode": "headless",
    "args": []
  },
  "tags": {
    "key": "value"
  }
}
```

`browser.channel` is required. `browser.mode` is `headed` or `headless` and defaults to `headed` when omitted. Use `GET /api/browser/configurations` to select a launchable pair rather than assuming either field.

A restricted token may create a blank session or use a granted base snapshot. New sessions and promoted snapshots do not extend its allowlist automatically. The returned `sessionToken` still authorizes the new session. Force promotion may replace an existing deleted snapshot tombstone only when that snapshot is granted.

Create returns `201`:

```json
{
  "session": {
    "id": "...",
    "tenantId": "...",
    "status": "running",
    "browser": {
      "channel": "chromium",
      "mode": "headless",
      "args": []
    },
    "capabilities": {
      "state": "active",
      "liveView": {"transports": ["cdp"]},
      "recording": {
        "mechanism": "cdp",
        "scope": "page",
        "modes": ["tab", "viewer"],
        "audio": false,
        "codecs": [{"codec": "vp8", "mediaType": "video/webm"}],
        "concurrencyLimit": 4,
        "cdp": {"formats": ["jpeg", "png"], "defaultFormat": "jpeg", "defaultQuality": 80}
      }
    },
    "connection": {
      "cdpUrl": "https://aperture.example.com/sessions/.../cdp",
      "sessionToken": "..."
    }
  }
}
```

Capability state is `active` for a running launch, `prospective` for a configuration that can currently launch, and `unavailable` when the persisted browser choice no longer resolves. Connection data is populated only for usable runtime routes. Create, suspend, reopen, session-token rotation, and other session mutations return `{ "session": {...} }`.

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

## Live session data plane

These public routes are forwarded to the running session wrapper:

- `GET /sessions/:sessionId/browser/status` — `sessions:read`
- `POST /sessions/:sessionId/browser/viewport` — `sessions:write`
- `GET /sessions/:sessionId/webrtc/signal?role=viewer` — WebSocket, `sessions:write`; present only when `capabilities.liveView.transports` contains `webrtc`
- `GET /sessions/:sessionId/recordings` — list recordings, `sessions:write`
- `POST /sessions/:sessionId/recordings` — start a recording, `sessions:write`
- `GET /sessions/:sessionId/recordings/:recordingId` — recording status, `sessions:write`
- `POST /sessions/:sessionId/recordings/:recordingId/stop` — stop and download, `sessions:write`
- `GET /sessions/:sessionId/recordings/client?clientId=:uuid` — recording client WebSocket, `sessions:write`

Use an authorized API bearer token and tenant header, or the bound `sessionToken`, for routed live-session requests.

Viewport body:

```json
{
  "width": 1280,
  "height": 720,
  "deviceScaleFactor": 1
}
```

The viewport response reports the logical size, DPR-scaled content rectangle, `64x64`-bucketed media canvas, and effective scale.

Tab recording body:

```json
{
  "mode": "tab",
  "targetId": "TARGET_ID",
  "fps": 60,
  "bitrateKbps": 6000,
  "codec": "vp8"
}
```

Viewer recording body:

```json
{
  "mode": "viewer",
  "targetId": "TARGET_ID",
  "clientId": "CLIENT_UUID"
}
```

`targetId` must identify a ready browser target. A tab recording stays pinned to it. A viewer recording follows the selected target of the connected `clientId`; `clientId` is required for viewer mode. Pass `clientId` with a tab recording when it should also stop if that client disconnects. Multiple recordings may run concurrently.

Supported codecs are `vp8` and `h264-va`. Omitted or non-positive FPS and bitrate values use instance defaults. Omit `path` to generate a file in the session's `recordings` directory. A supplied path must be absolute and inside that directory; session tokens cannot override the generated path.

When the recording capability reports `mechanism: "cdp"`, capture is page-scoped and video-only. The request may add `"cdp":{"format":"jpeg","quality":80}`. Format is `jpeg` or `png`; quality from 1 to 100 applies only to JPEG. VP8 downloads use WebM, while `h264-va` downloads use Matroska.

Start and status return `recordingId`, `mode`, `targetId`, `captureGeneration`, `status`, `path`, `startedAt`, `fps`, `bitrateKbps`, and `codec`. CDP jobs also report their `cdp` controls plus `acceptedFrames` and `droppedFrames`. Completed jobs may include `stopReason`, `stoppedAt`, and `sizeBytes`. Status is `starting`, `running`, `stopped`, or `failed`. The list route returns an array of these objects.

The normal stop request finalizes the recording and serves the completed media attachment. Send `Range: bytes=0-0` to finalize it while transferring only one byte. Use `POST /api/sessions/:sessionId/recordings/:recordingId/stop` with `sessions:write` to finalize without media transfer and return the completed session file with `name`, `relativePath`, `size`, `modifiedAt`, and `mimeType`.

Recording clients connect to:

```text
wss://aperture.example.com/sessions/:sessionId/recordings/client?clientId=:uuid
```

Send these WebSocket subprotocols:

- `aperture-recording.v1`
- `authorization.bearer.$SESSION_TOKEN` or an authorized API token
- `x-aperture-tenant-id.$TENANT_ID` when using a system-admin token

The selected protocol is `aperture-recording.v1`. Select the client's confirmed media target with:

```json
{"version":1,"type":"target.select","targetId":"TARGET_ID"}
```

Keep the client alive with periodic heartbeats:

```json
{"version":1,"type":"heartbeat"}
```

The server acknowledges target changes with `target.select.result`. Closing the socket or missing the two-minute heartbeat deadline finalizes every recording owned by that client and leaves the files in session storage.

MCP exposes `recording.start`, `recording.list`, `recording.status`, and `recording.stop`. MCP starts tab recordings only. Central tools take `sessionId` and tenant selection where required; session-bound tools bind the session from the URL. `recording.start` takes `targetId`, optional `fps`, `bitrateKbps`, and `codec`, plus optional CDP controls when that mechanism is active. Status and stop take `recordingId`.

## CDP Proxy

CDP uses `session.connection.sessionToken`, not the Aperture API bearer token. Append it as the next path segment after `session.connection.cdpUrl`:

```bash
curl -fsS "$CDP_URL/$SESSION_TOKEN/json/version"
curl -fsS "$CDP_URL/$SESSION_TOKEN/json/list"
```

Discovery responses contain rewritten WebSocket debugger URLs under the same tokenized public path. Connect to those URLs without an `Authorization` header or WebSocket subprotocol.

Rotate a compromised session token with `POST /api/sessions/:sessionId/session-token/rotate`; previously issued live-session URLs then stop authorizing.

## WebRTC Signaling

Connect to:

```text
wss://aperture.example.com/sessions/:sessionId/webrtc/signal?role=viewer
```

Send these WebSocket subprotocols:

- `aperture-webrtc.v1`
- `authorization.bearer.$SESSION_TOKEN` or an authorized API token
- `x-aperture-tenant-id.$TENANT_ID` when using a system-admin token

The selected WebSocket protocol is `aperture-webrtc.v1`. Only the `viewer` role is accepted, and a new viewer replaces the previous viewer for that session.

## Session Files

Session files are limited to regular files below the session's `downloads` and `recordings` directories. Browser downloads and recordings created by the wrapper are included.

Through MCP:

- central `session_files.list` takes `sessionId` and `tenantId` where required by the caller's authority
- central `session_files.create_download_url` takes `sessionId`, `relativePath`, optional `ttlSeconds`, and `tenantId` where required
- session-bound versions omit tenant and session identity inputs and bind them from `/sessions/:sessionId/mcp`

`session_files.list` returns `name`, `relativePath`, `size`, `modifiedAt`, and `mimeType`. MCP returns metadata and signed URLs rather than large file contents.

Through HTTP, `POST /api/sessions/:sessionId/files/download-url` requires `sessions:read` and accepts:

```json
{
  "relativePath": "recordings/recording-019f6cf0-0000-7000-8000-000000000010.webm",
  "ttlSeconds": 900
}
```

The response contains `url` and `expiresAt`. Omit `ttlSeconds` to use the configured default.

Signed downloads use:

```text
/sessions/:sessionId/files/<relative-path>?token=...
```

The query token uses `apf_<payload>.<signature>` and is bound to the exact session and relative path. Omitting `ttlSeconds` uses `signed_file_url_ttl` (15 minutes by default); callers may request any positive lifetime up to `signed_file_url_max_ttl` (24 hours by default). The route validates the signature, expiry, path, and session file root before serving an attachment.

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

Stop and download a recording:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $APERTURE_TOKEN" \
  -o "recording-$RECORDING_ID.webm" \
  "$APERTURE_BASE_URL/sessions/$SESSION_ID/recordings/$RECORDING_ID/stop"
```

Add `X-Aperture-Tenant-Id` to tenant-scoped examples when using a system-admin token.

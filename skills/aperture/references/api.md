# Aperture HTTP API

Control plane under `$APERTURE_BASE_URL/api`. For the live session routes see
`live-session.md`; for the MCP route see `mcp.md`.

## Authentication

```http
Authorization: Bearer $APERTURE_TOKEN
X-Aperture-Tenant-Id: $TENANT_ID   # system-admin tokens only
```

Scopes:

- `system:admin` — grants every scope; required by `/api/admin/*`
- `tenant:write` — tenant self-management and tenant token management; only
  tenant-authority tokens may use `/api/tenant*`
- `sessions:read`, `sessions:write` — session control plane and live data plane
- `snapshots:read`, `snapshots:write` — snapshots
- `tenants:write` — accepted on system-admin tokens, but does not replace `system:admin`

Creating a session from a snapshot also requires `snapshots:read`. Promoting a session
requires `sessions:write` and `snapshots:write`.

The web UI may instead use cookie sessions from OIDC, passkey, or password login
(optionally TOTP-protected). They authorize same-origin UI, API, and live-session
requests, but never MCP clients.

### Delegation and resource allowlists

Token creation delegates the caller's authority: a child cannot add scopes, cross a
tenant boundary, or outlive an expiring parent. Tenant tokens support
`resourceMode: "all"` or `"allowlist"`, with grants of
`{ "resourceType": "session" | "snapshot", "resourceId": "<UUIDv7>" }`; a restricted
parent can only create another `allowlist` token with a subset of its grants.
System-admin tokens cannot use allowlists.

Authorization needs the tenant boundary, the action scope, and a matching grant.
Restricted list endpoints filter ungranted rows before pagination; direct access
returns `resource_access_denied`. A restricted token can still read `GET /api/tenant`
but cannot mutate the tenant.

## Conventions

Errors: `{ "error": { "code": "validation_failed", "message": "..." } }`.

Paginated responses: `{ "data": [], "meta": { "limit": 50, "nextCursor": "...", "hasMore": false } }`.
Pass `limit` and `cursor`; treat cursors as opaque.

## General

- `GET /api/health` — unauthenticated; `status` is `ok` when healthy
- `GET /api/auth/me` — authenticated principal and selected tenant
- `GET /api/browser/configurations` — launchable channel/mode pairs with prospective
  capabilities; `sessions:read`
- `GET /api/events` — paginated tenant events, filtered by `resourceType` and
  `resourceId`; `sessions:read`

## Tenants and tokens

System administration (system-admin token):

- `POST|GET /api/admin/tenants`, `PATCH|DELETE /api/admin/tenants/:tenantId`,
  `POST /api/admin/tenants/:tenantId/restore`
- `POST|GET /api/admin/tokens`, `POST /api/admin/tokens/:tokenId/revoke` → `204`

Tenant self-service (tenant token with `tenant:write`):

- `GET|PATCH /api/tenant`
- `POST|GET /api/tenant/tokens`, `POST /api/tenant/tokens/:tokenId/revoke` → `204`

Tenant body: `{ "displayName": "Acme" }`.

Admin token creation:

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

Tenant-local creation omits `authorityType` and `tenantId`. The response
`{ "token": {...}, "rawToken": "apt_..." }` returns the raw token only once — persist it
immediately.

Tenant lists accept `deleted=active|deleted|all` or `includeDeleted=true`. Token lists
accept `name`, `scope`, `revoked=active|revoked|all`; the admin list also accepts
`tenantId` and `authorityType=system_admin|tenant`.

## Sessions

- `GET /api/sessions` — paginated list
- `POST /api/sessions/bulk` — `{ "ids": [...] }`, up to 100 unique UUIDv7 IDs
- `GET /api/sessions/:sessionId`
- `POST /api/sessions` — create
- `DELETE /api/sessions/:sessionId`
- `PUT /api/sessions/:sessionId/tags` — replace all tags
- `POST /api/sessions/:sessionId/suspend`
- `POST /api/sessions/:sessionId/reopen`
- `POST /api/sessions/:sessionId/session-token/rotate`
- `POST /api/sessions/:sessionId/promote`

List filters: `includeDeleted=true`, `status=creating|running|suspended|deleted|expired|failed`,
and repeated `tagKey` / `tagValue` / `tagOperator=eq|ne|in|not_in`.

Create request:

```json
{
  "label": "optional label",
  "baseSnapshotName": "optional snapshot name",
  "browser": { "channel": "chromium", "mode": "headless", "args": [] },
  "tags": { "key": "value" }
}
```

`browser.channel` is required; `browser.mode` is `headed` (default) or `headless`. Pick
the pair from `GET /api/browser/configurations` rather than assuming one launches.

Create returns `201` with `{ "session": {...} }`; other mutations return the same shape.
The session carries `status`, `browser`, `capabilities`, and `connection`:

```json
{
  "capabilities": {
    "state": "active",
    "liveView": { "transports": ["cdp"] },
    "recording": {
      "mechanism": "cdp",
      "scope": "page",
      "modes": ["tab", "viewer"],
      "audio": false,
      "codecs": [{ "codec": "vp8", "mediaType": "video/webm" }],
      "concurrencyLimit": 4,
      "cdp": { "formats": ["jpeg", "png"], "defaultFormat": "jpeg", "defaultQuality": 80 }
    }
  },
  "connection": {
    "cdpUrl": "https://aperture.example.com/sessions/.../cdp",
    "sessionToken": "aps_..."
  }
}
```

Capability `state` is `active` for a running launch, `prospective` for a configuration
that can currently launch, and `unavailable` when the persisted browser choice no longer
resolves. `connection` is populated only for usable runtime routes.

A restricted token may create a blank session or use a granted base snapshot; the new
session and any promoted snapshot are not added to its allowlist, though the returned
`sessionToken` still authorizes the session. Force promotion may replace a deleted
snapshot tombstone only when that snapshot is granted.

Promotion body `{ "name": "...", "description": null, "force": false, "tags": {} }`
returns `{ "snapshot": {...} }`.

## Snapshots

- `GET /api/snapshots` — paginated list
- `PATCH /api/snapshots/:name` — `{ "description": "new description or null" }`
- `DELETE /api/snapshots/:name`
- `PUT /api/snapshots/:name/tags` — replace all tags
- `POST /api/snapshots/:name/restore`

Filters: `deleted=active|deleted|all` or `includeDeleted=true`, plus repeated `tagKey`,
`tagValue`, `tagOperator`. Mutations return `{ "snapshot": {...} }`.

## Session files

Session files are regular files under the session's `downloads` and `recordings`
directories, including browser downloads and wrapper recordings. Each entry reports
`name`, `relativePath`, `size`, `modifiedAt`, and `mimeType`.

`POST /api/sessions/:sessionId/files/download-url` (`sessions:read`):

```json
{
  "relativePath": "recordings/recording-019f6cf0-0000-7000-8000-000000000010.webm",
  "ttlSeconds": 900
}
```

Returns `url` and `expiresAt`. The signed URL is
`/sessions/:sessionId/files/<relative-path>?token=apf_<payload>.<signature>`, bound to
that exact session and path. Omitting `ttlSeconds` uses `signed_file_url_ttl`
(15 minutes by default), up to `signed_file_url_max_ttl` (24 hours by default).

## Curl patterns

```bash
curl -fsS "$APERTURE_BASE_URL/api/health"

curl -fsS \
  -H "Authorization: Bearer $APERTURE_TOKEN" \
  -H "X-Aperture-Tenant-Id: $TENANT_ID" \
  "$APERTURE_BASE_URL/api/sessions?limit=20"

curl -fsS -X POST \
  -H "Authorization: Bearer $APERTURE_TOKEN" \
  "$APERTURE_BASE_URL/api/sessions/$SESSION_ID/suspend"
```

Add `X-Aperture-Tenant-Id` to tenant-scoped calls only when using a system-admin token.

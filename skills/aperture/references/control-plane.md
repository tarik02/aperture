# Control plane

Apply the authority, scope, tenant-selection, and resource-grant rules from [authentication.md](authentication.md) before using these endpoints.

## General endpoints

- `GET /api/health` — unauthenticated health check; `status` is `ok` when healthy
- `GET /api/auth/me` — authenticated principal and selected tenant
- `GET /api/browser/channels` — available browser channel names; requires `sessions:read`
- `GET /api/events` — paginated tenant events; requires `sessions:read`; accepts `resourceType` and `resourceId`

## Tenants and API tokens

System administration requires a system-admin token:

- `POST /api/admin/tenants`
- `GET /api/admin/tenants`
- `PATCH /api/admin/tenants/:tenantId`
- `DELETE /api/admin/tenants/:tenantId`
- `POST /api/admin/tenants/:tenantId/restore`
- `POST /api/admin/tokens`
- `GET /api/admin/tokens`
- `POST /api/admin/tokens/:tokenId/revoke` — returns `204`

Tenant self-service requires a tenant token with `tenant:write`:

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

## Sessions

- `GET /api/sessions` — paginated list
- `POST /api/sessions/bulk` — fetch up to 100 unique UUIDv7 session IDs
- `GET /api/sessions/:sessionId`
- `POST /api/sessions` — create
- `DELETE /api/sessions/:sessionId`
- `PUT /api/sessions/:sessionId/tags` — replace all tags
- `PUT /api/sessions/:sessionId/proxy` — replace the egress proxy configuration
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
    "args": []
  },
  "tags": {
    "key": "value"
  },
  "proxy": {
    "upstreams": {
      "operator": {
        "url": "wss+yamux+socks5://tunnel.example.com/t/assignment",
        "auth": "per-assignment bearer secret"
      },
      "corp": { "url": "socks5://user:pass@proxy.example.com:1080" }
    },
    "rules": [
      { "match": "*.test", "via": "operator" },
      { "match": "localhost:3000", "via": "local" },
      { "match": "*.internal.example.com", "via": "direct" },
      { "match": "*.ai", "via": "refuse" },
      { "match": "*", "via": "corp" }
    ]
  }
}
```

Every session routes browser egress through a session-local SOCKS5 proxy. Chromium proxy flags are system-owned (`--proxy-server` / `--proxy-bypass-list` are rejected as user args). `proxy.rules` is checked in order and the first rule whose `match` covers a connection routes it; unmatched connections go direct. A `match` is `host` or `host:port`, where the host is exact, `*.suffix` for subdomains, or `*` for any host. `via` is `direct`, `refuse`, `local` (the [local tunnel](live-session.md#local-tunnel); fails while none is attached), a name from `proxy.upstreams`, or an inline proxy URL without a secret.

An upstream `url` is a generic `http`/`https`/`socks`/`socks5`/`socks5h` proxy URL or a compound `ws+yamux+socks5://` / `wss+yamux+socks5://` tunnel URL. A tunnel URL needs `auth`, a bearer secret for its handshake; each SOCKS session gets its own yamux stream and is terminated by the tunnel operator. Proxy credentials go in the URL userinfo, `socks5://user:pass@host:1080`, sent as RFC 1929 username/password for the socks schemes and as Basic `Proxy-Authorization` for `http`/`https`. The port may be omitted; it defaults to 1080 for socks, 80 for http, 443 for https. Upstream names use lowercase letters, digits and dashes; `direct`, `refuse` and `local` are reserved.

`*` never matches `localhost`, which stays on the session host unless a rule names it. Loopback IPs never reach the proxy, so local services are matched as `localhost`, not `127.0.0.1`.

`PUT /api/sessions/:sessionId/proxy` replaces the configuration with the same object plus `"drain": true` to reset live tunnel streams instead of letting them finish. Secrets are write-only: session reads return upstream URLs but never `auth`, and proxy URLs come back with their passwords masked (`socks5://user:xxxxx@host:1080`).

The deprecated single-upstream shape, `upstream` (`direct`, `proxy`, `tunnel`) with `url`, `tunnel: {url, auth}` and `bypass`, is still accepted and translated into rules; it cannot be mixed with `upstreams` and `rules`. Reads also carry a deprecated `upstream`, which is approximate when the rules do not fit that shape. Use `upstreams` and `rules` in new code.

`browser.channel` is required. Use `GET /api/browser/channels` rather than assuming a channel name.

A restricted token may create a blank session or use a granted base snapshot. New sessions and promoted snapshots do not extend its allowlist automatically. The returned `sessionToken` still authorizes the new session. Force promotion may replace an existing deleted snapshot tombstone only when that snapshot is granted.

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
    "sessionToken": "..."
  },
  "cdpUrl": "https://aperture.example.com/sessions/.../cdp",
  "sessionToken": "..."
}
```

Session reads may include `cdpUrl` and `sessionToken` while retained live access is available. Suspend, reopen, and session-token rotation return `{ "session": {...}, "cdpUrl": "...", "sessionToken": "..." }`; other mutations return `{ "session": {...} }`.

Reopen applies only to retained `deleted` or `failed` sessions. Do not reopen a `suspended` session; live-session and browser MCP operations wake it automatically.

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

# Control plane

`/api/*` is specified by the instance itself; this file holds only what the spec does not say.

## Reading the spec

```bash
curl -fsS "$APERTURE_BASE_URL/openapi.json" > /tmp/aperture-openapi.json
jq '.paths | keys' /tmp/aperture-openapi.json
jq '.paths["/api/sessions"].post | {description, "x-aperture-auth", "x-aperture-errors", requestBody}' /tmp/aperture-openapi.json
jq '.components.schemas.CreateSession' /tmp/aperture-openapi.json
```

Every operation carries `x-aperture-auth` (accepted authorities, required scopes, how the tenant is resolved) and `x-aperture-errors` (its stable error codes); `components.schemas.ErrorCode` is the complete code catalog. Errors are `{"error": {"code", "message"}}`; lists are newest-first pages with `meta.nextCursor` and `meta.hasMore`.

## Tokens and delegation

A token created through the API or MCP is a delegate of its creator: it cannot hold a scope the creator lacks, belong to another tenant, or expire later than an expiring creator. `createdByType`, `createdById` and `parentTokenId` on the token record say who made it. The raw `apt_…` value appears once, in the creation response.

Tenant tokens carry `resourceMode: "all"` or `"allowlist"` with grants `{ "resourceType": "session" | "snapshot", "resourceId" }`. A restricted token sees only granted rows in lists (filtered before pagination) and gets `resource_access_denied` on direct access; it can create only another allowlist token whose grants are a subset of its own. Sessions it creates and snapshots it promotes are not added to its allowlist, but the `sessionToken` returned by create still works. System-admin tokens cannot be restricted.

## Session lifecycle

- `creating` → `running` → `suspended` ⇄ `running`; `deleted`, `failed` and `expired` are terminal unless reopened. `reopen` applies to retained `deleted` and `failed` sessions. A `suspended` session is never reopened: any browser call, MCP browser tool or authorized data-plane request wakes it.
- `POST /api/sessions?waitForReady=false` returns the session and its credentials in `creating` while the browser starts.
- Session reads include `cdpUrl` and `sessionToken` only while live access is retained; treat them as secrets. `session-token/rotate` invalidates every URL built with the old token.
- `GET /sessions/:sessionId/browser/status` and the thumbnail routes read retained state without waking or touching retention. `source` is `live` for a running session, `persisted` for the page set saved at suspension, `unavailable` when nothing was saved. Persisted target IDs are historical and may change after resume.
- Promotion makes a snapshot from a session's filesystem; session files never enter it, and a session created from a snapshot starts with none. `force: true` may replace a deleted snapshot tombstone of the same name.

## Egress proxy

Every session's browser egress goes through a session-local SOCKS5 proxy, so `--proxy-server` and `--proxy-bypass-list` are rejected in `browser.args`. The rule and upstream grammar is in the spec (`ProxyConfig`, `ProxyRule`, `ProxyUpstream`). What it implies for an operator: `via: "local"` is the [local tunnel](live-session.md#local-tunnel) and fails until a client attaches one; the browser reaches a tunneled service as `localhost`, never as a loopback IP, because loopback bypasses the proxy; secrets are write-only, so a read of the proxy config cannot be replayed as a write.

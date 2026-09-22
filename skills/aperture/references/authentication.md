# Authentication and authorization

Send API tokens on HTTP requests:

```http
Authorization: Bearer $APERTURE_TOKEN
```

The web UI can use server-side account sessions established through OIDC, a registered passkey, or email/password. Passkey registration and password setup require an existing account session and never provision a user. TOTP and one-time recovery codes can protect password login. These cookie sessions authorize same-origin UI, API, and live-session requests, but not MCP clients.

Tenant tokens are already bound to their tenant. System-admin tokens must select a tenant for tenant-scoped operations:

```http
X-Aperture-Tenant-Id: $TENANT_ID
```

Omit `X-Aperture-Tenant-Id` when using a tenant token. In MCP tool arguments, omit `tenantId`; an explicit tenant selection is rejected.

Authorities are `system_admin` and `tenant`. Current scope behavior:

- `system:admin`: grants every scope and is required by `/api/admin/*`
- `tenant:write`: tenant self-management and tenant token management; only tenant-authority tokens may use `/api/tenant*`
- `sessions:read`, `sessions:write`: session control-plane and live data-plane access
- `snapshots:read`, `snapshots:write`: snapshot access
- `tenants:write`: accepted only on system-admin tokens, but does not replace `system:admin` for current admin routes

Creating a session from a snapshot also requires `snapshots:read`. Promoting a session requires both `sessions:write` and `snapshots:write`.

API tokens use `apt_<tokenId>_<secret>`. The owner-only `sessionToken` uses `aps_<sessionId>_<secret>` and is bound to exactly one session. Editor (`ape_`) and viewer (`apv_`) collaboration capabilities authorize narrower live-session routes and never authorize MCP, files, or recordings. None of these session-bound credentials authorize `/api/*` or central MCP.

Authenticated API and MCP token creation delegates the caller's authority. A child cannot add scopes, cross a tenant boundary, or outlive an expiring parent token. A resource-restricted parent can create only another `allowlist` token whose grants are a subset of its own. Token metadata identifies the creating principal in `createdByType` and `createdById`; `parentTokenId` identifies the API token used for delegation.

Tenant API tokens support `resourceMode: "all"` or `resourceMode: "allowlist"`. Allowlist grants use `{ "resourceType": "session" | "snapshot", "resourceId": "<UUIDv7>" }`. Authorization requires the tenant boundary, action scope, and matching resource grant. System-admin tokens cannot use allowlists. Restricted session, snapshot, bulk, and event lists filter ungranted rows before pagination; direct access returns `resource_access_denied`. `GET /api/tenant` remains available, but restricted tokens cannot mutate the tenant.

## Response conventions

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

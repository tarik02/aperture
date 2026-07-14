# Web UI implementation plan

## Goal

Add a production web UI for Aperture without adding a Node runtime to production.
The Go service remains the packaged runtime. The web app builds to static assets
and Aperture serves them at `/`.

The UI must support both tenant operators and system admins. It must let users
store and switch between multiple API tokens locally, browse and mutate Aperture
resources, and control running Chromium sessions through a browser workbench.

## Hard decisions

- The frontend lives in `web/`.
- The frontend uses pnpm, tsgo, vite-plus, TanStack Start in SPA mode, TanStack
  Query, Zustand, shadcn with Base UI primitives, and Lucide icons.
- Production serves embedded static assets from the Go binary.
- Development uses vite-plus full bundle mode. If bundled dev mode conflicts
  with the chosen stack, treat it as a build problem to solve, not a reason to
  silently fall back.
- The app owns `/` and normal frontend routes.
- Public REST routes move under `/api/*`.
- Raw CDP moves to `/cdp/{sessionId}`.
- The API-authenticated CDP proxy lives at `/api/cdp/{sessionId}`.
- The browser-control gateway lives at `/api/control/{sessionId}`.
- Internal routes stay mounted under `/internal/*` on the loopback Go server,
  but public Traefik rules must not expose them.
- Public health moves to `/api/health`.
- No backwards compatibility layer is required for the route move.
- Do not add new tests. Existing tests may be updated when route paths change.
- Do not start a dev server during implementation.

## Route contract

### Public frontend routes

The SPA should handle all non-reserved public paths.

Initial UI routes:

- `/`
- `/sessions`
- `/sessions/:sessionId`
- `/snapshots`
- `/tokens`
- `/tenants`
- `/settings`

The root route should open the session workbench, not a marketing page.

### Public API routes

Move existing public JSON routes under `/api`:

- `/api/health`
- `/api/admin/*`
- `/api/tenant/*`
- `/api/sessions/*`
- `/api/snapshots/*`

Add:

- `GET /api/auth/me`
- `GET /api/browser/channels`
- `GET /api/sessions`
- `GET /api/snapshots`
- `GET /api/admin/tenants`
- `GET /api/admin/tokens`
- `GET /api/tenant/tokens`
- `GET /api/events`
- `PUT /api/sessions/{sessionId}/tags`
- `PUT /api/snapshots/{name}/tags`
- `GET /api/cdp/{sessionId}/*`
- `GET /api/control/{sessionId}`

The exact method for the control gateway should be WebSocket upgrade on
`GET /api/control/{sessionId}`.

### Raw CDP route

Raw CDP remains available for external protocol clients at:

```text
/cdp/{sessionId}
```

This route uses CDP bearer tokens and Traefik ForwardAuth. The UI should not
need to reveal session tokens for browser control. session token display belongs only in
the connection panel for external clients when a token was just returned by
create, reopen, or rotate.

### API-authenticated raw CDP proxy

Add:

```text
/api/cdp/{sessionId}
```

This route accepts normal API bearer tokens and requires `sessions:write`.
It proxies raw CDP HTTP and WebSocket traffic to the selected running session.
This gives the UI and trusted API clients a way to use CDP without exposing raw
session tokens.

### Traefik routing

Render these public route groups:

- high-priority CDP routes for `/cdp/{sessionId}` to Chromium ports
- an Aperture catch-all for `/`, excluding `/internal` and `/cdp`

The catch-all must not rely on `requireLoopback` to protect `/internal/*`.
Traefik reaches Aperture over loopback, so a public request proxied by Traefik
would otherwise look local to the Go server.

Use a negative match rule for the catch-all:

```text
PathPrefix(`/`) && !PathPrefix(`/internal`) && !PathPrefix(`/cdp`)
```

Keep `/internal/forward-auth/cdp/{sessionId}` and `/internal/jobs/gc` private to
the loopback listener.

## API response contract

### Errors

Change JSON API errors to:

```json
{
  "error": {
    "code": "session_not_found",
    "message": "session not found"
  }
}
```

Use stable `code` strings so the UI can branch without parsing messages.

Recommended initial codes:

- `authentication_required`
- `invalid_authentication_token`
- `authentication_token_expired`
- `authentication_token_revoked`
- `insufficient_scope`
- `tenant_selection_required`
- `tenant_selection_not_permitted`
- `tenant_not_found`
- `tenant_deactivated`
- `token_not_found`
- `token_name_conflict`
- `invalid_request_body`
- `validation_failed`
- `session_not_found`
- `session_expired`
- `session_not_running`
- `session_not_reopenable`
- `snapshot_not_found`
- `snapshot_name_conflict`
- `browser_start_failed`
- `browser_control_failed`
- `internal_error`

### Pagination

All list endpoints use cursor pagination with newest-first ordering.

Request query:

- `limit`
- `cursor`
- optional filters per resource

Response envelope:

```json
{
  "data": [],
  "meta": {
    "limit": 50,
    "nextCursor": "opaque-value",
    "hasMore": true
  }
}
```

Cursor values are opaque base64url strings. Internally they should encode the
last item order key and id. The client must only store and pass the cursor back.

Default ordering:

```text
created_at DESC, id DESC
```

Use the same pattern for tenants, sessions, snapshots, tokens, and events.

### Filters

Initial filters:

- `includeDeleted=true` where the resource supports tombstones
- `status=running|deleted|failed|expired|creating` for sessions
- exact tag filters for sessions and snapshots
- tenant selection through `X-Aperture-Tenant-Id` for system-admin tokens on
  tenant-scoped resource routes

Do not add broad text search in the first pass.

## Backend work

### Stage 1, route move and static shell

1. Move public REST route registration under `/api`.
2. Keep private routes under `/internal`.
3. Move public health to `/api/health`.
4. Add static asset serving to the Go router.
5. Embed the web build output in the Go binary.
6. Return the SPA shell for non-reserved paths.
7. Update Traefik config rendering for `/api`, `/cdp`, and the root catch-all.
8. Update existing tests and golden files that assert route paths or Traefik
   output.

Static serving rules:

- serve concrete asset files first
- return `index.html` for frontend routes
- never return the SPA shell for `/api/*`, `/internal/*`, or `/cdp/*`

### Stage 2, auth bootstrap endpoints

Add `GET /api/auth/me`.

Request:

- uses normal `Authorization: Bearer {apiToken}`
- accepts optional `X-Aperture-Tenant-Id`

Response:

```json
{
  "principal": {
    "tokenId": "018f...",
    "name": "admin",
    "authorityType": "system_admin",
    "tenantId": null,
    "scopes": ["system:admin"]
  },
  "selectedTenant": {
    "id": "018f...",
    "displayName": "default",
    "createdAt": "2026-07-04T00:00:00Z",
    "deletedAt": null
  }
}
```

For tenant tokens, `selectedTenant` should be the token tenant.
For system-admin tokens, return `selectedTenant` only when a valid tenant header
is supplied. If a tenant header is required by a route but missing, that route
still returns `tenant_selection_required`.

Add `GET /api/browser/channels`.

Authorization:

- requires `sessions:read`

Response:

```json
{
  "channels": [
    {
      "name": "chromium"
    }
  ]
}
```

Do not return executable paths.

### Stage 3, list endpoints and tag mutation

Add cursor-paginated repository helpers for:

- tenants
- API tokens
- sessions
- snapshots
- events

Add service methods and HTTP handlers that preserve tenant ownership rules.

Session list response item should include:

- id
- tenant id
- base snapshot name
- status
- browser channel
- created at
- started at
- stopped at
- deleted at
- expires at
- tags
- CDP URL when available
- persistent sessionToken when the authorized session contract exposes live access.

Snapshot list response item should include:

- id
- name
- tenant id
- parent snapshot id
- promoted from session id
- created at
- deleted at
- expires at
- tags

Token list response item should include:

- id
- authority type
- tenant id
- name
- scopes
- created at
- expires at
- revoked at

Token lists must never include raw token values.

Add:

- `PUT /api/sessions/{sessionId}/tags`
- `PUT /api/snapshots/{name}/tags`

Tag writes require the matching resource write scope:

- sessions need `sessions:write`
- snapshots need `snapshots:write`

### Stage 4, raw CDP proxy

Add an API-authenticated CDP proxy under `/api/cdp/{sessionId}`.

Authorization:

- normal API bearer token
- selected tenant rules
- `sessions:write`
- session must be running and not expired

Behavior:

- proxy HTTP CDP endpoints such as `/json/version`
- proxy WebSocket upgrades
- strip the `/api/cdp/{sessionId}` prefix before forwarding to Chromium
- do not require or reveal the session token beyond the authorized persistent sessionToken contract

Use a maintained WebSocket library for upgrade and proxy handling. Do not
hand-roll WebSocket framing.

### Stage 5, control gateway

Add a WebSocket gateway at:

```text
GET /api/control/{sessionId}
```

Authorization:

- normal API bearer token
- selected tenant rules
- `sessions:write`
- session must be running and not expired

Use `github.com/coder/websocket` for the UI WebSocket and `chromedp/cdproto`
for CDP protocol types.

The gateway should connect to Chromium CDP over loopback using the session's
current CDP port. It should not go back through public Traefik.

Initial gateway messages from client:

- `targets.list`
- `targets.activate`
- `targets.create`
- `targets.close`
- `page.navigate`
- `page.reload`
- `page.stopLoading`
- `viewport.set`
- `screencast.start`
- `screencast.stop`
- `input.mouse`
- `input.wheel`
- `input.key`
- `clipboard.copy`
- `clipboard.cut`
- `clipboard.paste`

Initial gateway messages from server:

- `targets.snapshot`
- `target.changed`
- `screencast.frame`
- `screencast.stopped`
- `clipboard.data`
- `error`

Frame transport:

- use `Page.startScreencast`
- send JSON messages with base64 image data
- include frame id, target id, image format, width, height, device scale factor,
  scroll offsets, timestamp, and session id
- acknowledge frames back to CDP

Input:

- map UI pointer coordinates back to emulated viewport CSS pixels
- support mouse move, down, up, click, double click, wheel
- support key down, key up, and text insertion where appropriate
- captured viewport sends browser shortcuts to the remote tab
- `Esc` releases keyboard capture back to the UI shell

Viewport:

- expose preset and custom viewport sizes
- use CDP emulation for selected targets
- scale frames to fit the UI panel without changing the emulated viewport unless
  the user changes it

Clipboard:

- use TanStack Hotkeys in the UI for Ctrl or Command X, C, and V while the
  viewport is captured
- copy and cut request selected remote content through CDP
- paste sends local clipboard content to the remote tab through the gateway
- support text, HTML, and common image clipboard items where browser APIs and
  CDP allow it
- report per-format failures instead of hiding them

File upload and download management are out of scope for the first web UI.

## Frontend work

### Stage 6, package setup

Create `web/` as a pnpm package.

Required stack:

- TypeScript
- tsgo
- vite-plus
- TanStack Start SPA mode
- TanStack Router through TanStack Start
- TanStack Query
- Zustand
- shadcn Base UI components
- Lucide icons
- Zod
- TanStack Hotkeys
- sonner

The production build must produce static assets that the Go binary embeds.

Scripts should cover:

- typecheck
- build
- lint
- format check

Do not add a script that starts the dev server as part of verification.

### Stage 7, shadcn setup

Initialize shadcn in `web/` with:

- Base UI primitives
- Lucide icons
- neutral, dense styling
- semantic colors
- compact component sizing

Use shadcn components before custom markup.

Install the first component set for the agreed UI:

- button
- input
- input group
- field
- select
- checkbox
- switch
- toggle group
- tabs
- table
- pagination
- badge
- card
- sidebar
- dropdown menu
- dialog
- sheet
- tooltip
- popover
- alert
- empty
- skeleton
- separator
- scroll area
- resizable
- sonner

Keep UI copy short. Do not add visible instructional text for obvious controls.

### Stage 8, API client

Build a small typed client around `fetch`.

Client requirements:

- adds `Authorization: Bearer {token}`
- adds `X-Aperture-Tenant-Id` when a token profile has a selected tenant
- parses every response with handwritten Zod schemas
- parses structured API errors
- exposes pagination helpers for TanStack Query infinite queries
- never logs or stores raw session tokens outside explicit create, reopen, rotate,
  or connection-panel flows

Do not generate an OpenAPI client in the first pass.

### Stage 9, local token vault

Use Zustand persist for token profiles and UI preferences.

Stored token profile fields:

- local label
- raw API token
- masked token id
- authority type from `/api/auth/me`
- token name from `/api/auth/me`
- tenant id for tenant tokens
- scopes
- selected tenant id for system-admin tokens
- last used timestamp

UI behavior:

- first visit asks for an API token
- users can add, rename, remove, and switch token profiles
- after selecting a token, call `/api/auth/me`
- if the token is system-admin, show tenant picker before tenant-scoped pages
- tenant tokens infer their tenant and cannot override it

This is a local browser vault, not server-side login. Do not add UI sessions or
cookies in the first pass.

### Stage 10, application shell

Build a dense operational shell:

- left sidebar navigation
- token switcher in the header or sidebar footer
- selected tenant control for system-admin profiles
- compact status area for API health and active token role
- no hero page
- no marketing copy

Top-level navigation:

- sessions
- snapshots
- tokens
- tenants, admin only
- settings

Session workbench is the default route.

Use TanStack Query for server data:

- visible tables poll every few seconds
- refetch on focus
- mutations invalidate affected queries

Use sonner toasts for action failures and inline errors for forms, tables, and
gateway state.

### Stage 11, resource pages

Sessions page:

- paginated table
- status filter
- include deleted toggle
- exact tag filters
- create session action
- delete action
- reopen action
- promote action
- rotate session token action
- edit tags action
- detail drawer with metadata, events, connection panel, and raw CDP URL

Create session form:

- channel select from `/api/browser/channels`
- base snapshot select from snapshots list
- browser args textarea
- tag editor

Snapshots page:

- paginated table
- include deleted toggle
- exact tag filters
- delete action
- restore action
- edit tags action
- detail drawer with metadata and events

Tokens page:

- paginated table
- create token action
- revoke token action
- copy raw token only at creation time
- tenant-token mode uses `/api/tenant/tokens`
- system-admin mode uses `/api/admin/tokens`

Tenants page, admin only:

- paginated table
- include deleted toggle
- create tenant action
- update display name action
- delete action
- restore action
- selected tenant shortcut

Events:

- show resource events inside detail drawers
- page through events with the shared cursor contract

### Stage 12, browser workbench

Layout:

- session list pane
- browser control pane
- detail or inspector pane
- resizable panels

Control toolbar:

- icon-first buttons with tooltips
- tab strip with title, URL, and status
- compact URL input
- reload, stop, back, forward, new tab, close tab, viewport preset controls
- capture state indicator

Keyboard:

- click viewport to capture
- `Esc` releases capture
- while captured, remote tab receives common browser shortcuts
- app shell hotkeys should not intercept captured input except release

Frames:

- render base64 screencast frames to a canvas or image element
- maintain stable aspect ratio
- map input coordinates from rendered size back to emulated viewport
- show stale or disconnected state inline

Tab lifecycle:

- list page targets
- activate target
- create target with URL
- navigate target
- reload target
- stop loading
- close target

Connection panel:

- show API-auth CDP proxy URL
- show raw CDP URL
- copy URL buttons
- show the persistent sessionToken for authorized sessions wherever the session contract provides it
- rotate token action

Do not require the user to handle raw session tokens for normal browser control.

## Packaging work

Update the Nix package so the web build runs before the Go build and the Go
binary embeds the generated assets.

Package requirements:

- pnpm dependencies are locked
- web build output is deterministic
- final package contains no development server
- final runtime does not require Node
- Go embed path is stable

The Go build should fail clearly if embedded web assets are missing.

## Verification

Do not add new tests.

Allowed checks:

- update existing route and Traefik golden assertions
- run existing Go checks if needed
- run frontend typecheck, lint, format check, and production build
- inspect built assets and Go embed wiring

Do not start the dev server.

Manual browser verification can happen later against the already running service.

## Implementation order

1. Move backend public routes to `/api` and add structured errors.
2. Update Traefik routing and static SPA fallback rules.
3. Add `/api/auth/me` and `/api/browser/channels`.
4. Add cursor pagination helpers and list endpoints.
5. Add tag mutation endpoints.
6. Add API-auth raw CDP proxy.
7. Add the first control gateway with target listing and screencast.
8. Create `web/` package and configure tooling.
9. Add shadcn Base UI setup and shared app shell.
10. Add token vault and `/api/auth/me` bootstrap flow.
11. Add API client with Zod parsing and Query hooks.
12. Build resource tables and mutations.
13. Build session workbench and control panel.
14. Wire production build output into Go embed.
15. Update packaging.
16. Run allowed verification.

## Deferred work

- server-side UI sessions or cookie login
- broad text search
- global admin aggregate view across tenants
- downloads and uploads
- native host clipboard bridge for arbitrary file/custom MIME data
- dedicated event streaming for live invalidation
- OpenAPI or generated TypeScript client
- mobile-first redesign

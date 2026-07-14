# Vendored DevTools iframe plan

## Goal

Render the original Chrome DevTools frontend inside the session workspace.

The solution vendors a pinned DevTools frontend build and serves it from
`/devtools/*`. DevTools connects to the running browser through Aperture's CDP
proxy, not directly to Chromium's loopback port.

## Non-negotiables

- Use vendored DevTools assets. Do not depend on
  `chrome-devtools-frontend.appspot.com` at runtime.
- Serve DevTools assets from `/devtools/*`.
- Do not expose raw session tokens to the workspace iframe flow.
- Do not let `/devtools/*` fall back to the SPA shell.
- Do not start a dev server for validation.
- Do not add new tests. Use existing checks and manual smoke validation.
- Bail out on any major blocker before widening the implementation.

## Stage 0, pin scope and frontend revision

Decide the exact DevTools frontend revision to vendor.

Implementation notes:

- Prefer a revision matching the supported Chromium or Chrome major version.
- Store a small metadata file beside the vendored assets with:
  - upstream revision
  - source URL or fetch method
  - license path
  - generated asset root
- Treat multi-major browser support as out of scope unless validation proves the
  pinned revision is incompatible.

Validation:

- `inspector.html` exists in the vendored output.
- `entrypoints/inspector/inspector.js` exists and loads from the same asset root.
- License files are present.
- The revision is recorded in a human-readable file.

Bail out if:

- The required frontend revision cannot be obtained reproducibly.
- The vendored license requirements are unclear.
- The asset size is unacceptable for the product package.

## Stage 1, serve `/devtools/*` as static assets

Add an explicit static route for DevTools assets.

Implementation notes:

- Put vendored built assets under a path that is copied into the production SPA
  asset tree as `devtools/*`.
- Register an explicit `GET` and `HEAD` handler for `/devtools/*`.
- Serve `/devtools/inspector.html` as the frontend entrypoint.
- Return `404` for missing `/devtools/*` files.
- Reserve `/devtools` from SPA fallback only after the explicit static handler
  exists.
- Do not add `/devtools` only to the generic reserved-path check, because the
  current fallback checks reserved paths before attempting static file serving.

Validation:

- `GET /devtools/inspector.html` returns `200` and `text/html`.
- `GET /devtools/entrypoints/inspector/inspector.js` returns `200` and a JS MIME
  type.
- `GET /devtools/not-found.js` returns `404`, not `index.html`.
- The response does not include `X-Frame-Options: DENY`.
- The frontend response does not include a `frame-ancestors` directive that
  blocks the workspace origin.
- Production build embeds the `/devtools/*` files.

Bail out if:

- Serving `/devtools/*` requires invasive changes to unrelated SPA routing.
- The vendored frontend cannot load its own resources from `/devtools/*`.

## Stage 2, add short-lived DevTools launch tickets

Add an API-authenticated launch flow that mints a short-lived CDP WebSocket
ticket.

Proposed API:

```text
POST /api/sessions/{sessionId}/devtools-launch
```

Authorization:

- normal API bearer token
- selected tenant rules
- `sessions:write`
- session must be running and not expired

Response shape:

```json
{
  "frontendPath": "/devtools/inspector.html",
  "webSocketPath": "/cdp/{sessionId}/devtools/page/{targetId}",
  "ticket": "opaque-short-lived-ticket",
  "expiresAt": "2026-07-05T13:00:00Z"
}
```

Implementation notes:

- Discover page targets from Chromium's loopback `/json/list`.
- Pick the current active page target when the workspace knows it; otherwise use
  the first `page` or `webview` target.
- If no inspectable page target exists, return a conflict error. Do not create a
  new page implicitly in this stage.
- Store only a hash of the ticket server-side.
- Scope each ticket to:
  - session id
  - tenant id
  - target WebSocket path
  - expiry
- Use a short TTL, for example 60-120 seconds.
- Consume the ticket on the first successful WebSocket authorization.
- Strip `ticket` from the proxied backend query string before forwarding to
  Chromium.
- Tickets authorize only the specific DevTools WebSocket path. They must not
  authorize `/json/*` or arbitrary CDP HTTP requests.

Validation:

- Launch endpoint returns no raw session token.
- Launch endpoint fails without `sessions:write`.
- Launch endpoint fails for stopped, expired, missing, or wrong-tenant sessions.
- WebSocket upgrade succeeds with `?ticket=...` and no Authorization header.
- Reusing a consumed ticket fails.
- Expired tickets fail.
- A ticket for one session or target cannot authorize another.
- Proxied Chromium requests do not receive the `ticket` query parameter.

Bail out if:

- Stock DevTools needs unauthenticated HTTP CDP discovery from inside the iframe.
- Stock DevTools opens multiple independent WebSockets that cannot be scoped
  without broadening ticket permissions.
- Browser target selection cannot be made deterministic.

## Stage 3, build the workspace iframe mode

Add a DevTools mode to the session workspace.

Implementation notes:

- Add a workspace view switch between the existing browser viewport and
  DevTools.
- Only run the existing custom CDP control connection while the browser viewport
  mode is active.
- When DevTools mode opens, call the launch endpoint and build the iframe URL:
  - use `wss` when the workspace is loaded over HTTPS
  - use `ws` when loaded over HTTP
  - value format is `{window.location.host}{webSocketPath}?ticket={ticket}`
  - iframe `src` is
    `/devtools/inspector.html?wss={encodedValue}` or
    `/devtools/inspector.html?ws={encodedValue}`
- Do not persist the iframe URL or ticket in local storage.
- Unmount the iframe when leaving DevTools mode so the WebSocket closes.
- Provide a reload action that requests a fresh launch ticket.

Validation:

- Opening DevTools mode renders the iframe inside the workspace.
- The browser Network view shows DevTools assets loading from `/devtools/*`.
- No runtime request goes to `chrome-devtools-frontend.appspot.com`.
- The DevTools WebSocket connects through `/cdp/{sessionId}/...`.
- Raw session token is absent from the DOM, iframe URL, logs, and storage.
- Switching away from DevTools closes the DevTools WebSocket.
- Switching back to the browser viewport restores the existing control flow.

Bail out if:

- The iframe is blocked by browser framing policy.
- DevTools requires top-level-window privileges that cannot work in an iframe.
- DevTools and the custom viewport cannot be isolated without target conflicts.

## Stage 4, harden proxy and routing behavior

Make DevTools routing explicit and auditable.

Implementation notes:

- Keep Chromium remote debugging bound to loopback.
- Continue routing browser CDP through Aperture's proxy.
- Keep `/cdp/{sessionId}` token auth for external clients.
- Add DevTools ticket auth as a separate authorization mode, not as a raw CDP
  token alias.
- Log ticket mint, consume, expiry, and denial events without logging ticket
  values.
- Ensure Traefik catch-all continues to send `/devtools/*` to Aperture.
- Do not expose `/internal/*`.

Validation:

- `/internal/*` remains unavailable through public routing.
- `/api/*`, `/cdp/*`, and `/devtools/*` do not return the SPA shell on missing
  paths.
- Public session token auth still works for external clients.
- DevTools ticket auth cannot be used as a bearer token.
- Ticket denial logs include reason and session id but no secret material.

Bail out if:

- Ticket auth weakens public session token isolation.
- Traefik routing needs a broad rule change that risks exposing internal routes.

## Stage 5, package and smoke validate

Validate the complete packaged behavior without a dev server.

Validation:

- Frontend typecheck passes.
- Frontend production build passes.
- Go build passes.
- Existing relevant Go checks pass.
- Packaged assets include `/devtools/inspector.html`.
- Against an existing running Aperture service:
  - open a running session
  - switch to DevTools mode
  - inspect Elements
  - inspect Network
  - reload the target page
  - switch back to browser viewport
- Browser console has no failed module imports from `/devtools/*`.
- Browser Network view has no hosted DevTools frontend requests.

Bail out if:

- Production build cannot embed the vendored assets.
- Packaged runtime differs from local static behavior.
- DevTools works only in development-like asset serving.

## Stage 6, compatibility decision

Decide whether one vendored frontend revision is enough.

Validation:

- Smoke validate at least the configured default browser channel.
- If more than one browser channel is supported, smoke validate each configured
  major version that product support requires.
- Record any unsupported browser major clearly in product documentation.

Bail out if:

- Supported browser channels require incompatible DevTools frontend revisions.
- Multiple vendored revisions become necessary and package size or routing
  complexity is not acceptable.

## Final acceptance

The feature is complete only when:

- DevTools loads from `/devtools/*`.
- DevTools renders inside the workspace iframe.
- DevTools connects through a short-lived ticket, not a raw session token.
- Missing `/devtools/*`, `/api/*`, and `/cdp/*` paths never return the SPA shell.
- Existing browser viewport control still works.
- No runtime dependency on hosted DevTools remains.

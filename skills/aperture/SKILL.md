---
name: aperture
description: Operate a running Aperture instance (isolated Chromium sessions) through its HTTP, WebSocket and MCP APIs. Use when a task creates, inspects, suspends or snapshots a browser session, drives one through Playwright MCP or CDP, records a session, moves files in or out of one, connects an interactive client, or administers tenants and API tokens.
---

# Aperture

Aperture supervises isolated Chromium sessions and keeps the files they produce. Everything is reached through one public origin:

```bash
export APERTURE_BASE_URL="https://aperture.example.com"
```

| Surface | Path | Where it is specified |
|---|---|---|
| Control plane | `/api/*` | `$APERTURE_BASE_URL/openapi.json` (browsable at `/docs`): every route, body, scope and error code. Read it before calling `/api/*`; [control-plane.md](references/control-plane.md) adds only what it leaves unsaid. |
| MCP | `/mcp`, `/sessions/:sessionId/mcp` | [mcp.md](references/mcp.md) |
| Data plane | `/sessions/:sessionId/*` | [live-session.md](references/live-session.md), [recordings.md](references/recordings.md), [session-files.md](references/session-files.md) |

Data-plane routes are served by the session itself. They exist for `running` and `suspended` sessions, and an authorized request wakes a suspended one; `browser/status`, `files/*` and the thumbnails are the exceptions that read retained state without waking. `/internal/*` is not public.

## Credentials

One rule decides every call: which credential is in hand.

| Credential | Shape | Opens |
|---|---|---|
| API token | `apt_…` as `Authorization: Bearer` | `/api/*`, both MCP endpoints, and the data plane of any session its scopes and grants reach. |
| Session token | `aps_…`, returned by session create, `sessions.connection` and token rotation | Exactly one session: its data plane, its CDP URL and its session-bound MCP. Never `/api/*` or `/mcp`. |
| Editor capability | `ape_…` | One session's `/session`, `/webrtc/*`, `browser/viewport`, `browser/cursor` and `recordings*`. |
| Viewer capability | `apv_…` | One session's `/session` and `/webrtc/*`, observing only. |
| Account session | cookie from the web UI login | Same-origin `/api/*` and data plane. Never MCP. |

Scopes on API tokens: `sessions:read` opens reads and the observing live routes; `sessions:write` opens mutations, recordings, uploads, the local tunnel and the owner role on a live connection; `snapshots:read`/`snapshots:write` guard snapshots (creating from a snapshot needs `snapshots:read`, promoting needs both `sessions:write` and `snapshots:write`); `tenant:write` is tenant self-service on `/api/tenant*`; `system:admin` is every scope plus `/api/admin/*`. A system-admin token selects the tenant with `X-Aperture-Tenant-Id` on tenant-scoped calls; a tenant token omits the header, and omits `tenantId` in MCP arguments.

## Workflows

### Drive a session with automation

1. `GET /api/browser/channels` and pick a channel from the answer.
2. `POST /api/sessions` with `{"browser": {"channel": "<channel>"}}`; keep `session.id`, `sessionToken` and `cdpUrl`. Done when `session.status` is `running` (the default `waitForReady=true` waits for it).
3. Drive it either through MCP at `/sessions/<id>/mcp` with the session token, where `browser_*` tools are Playwright's, or through CDP at `<cdpUrl>/<sessionToken>/json/version` ([CDP](references/live-session.md#cdp)).
4. End with `POST /api/sessions/<id>/suspend` to keep the session or `DELETE /api/sessions/<id>` to drop it. A suspended session wakes by itself on the next browser call; `reopen` is for `deleted` and `failed` sessions only.

### Record what the automation does

1. `browser.targets` (MCP) and take a target whose `state` is `ready`.
2. `recording.start` with that `targetId` and the edit settings; it returns once the first frame is captured.
3. Drive the browser. Add `recording.caption`, `recording.focus` and `recording.attention` where a viewer needs them.
4. `recording.stop`; it returns the recording at once, raw video published, `editing: true` while the edit runs.
5. Poll `recording.status` until `editing` is false; then `editedRelativePath` and `timelineRelativePath` exist, or `editError` says why not.
6. `session_files.create_download_url` with a `relativePath`, then `GET` the URL.

Settings, journal and edit output: [recordings.md](references/recordings.md).

### Move files in and out

In: `POST /sessions/<id>/uploads` (multipart) returns `relativePath`s that `browser_file_upload` accepts. Out: list files, create a signed download URL, `GET` it. Paths and limits: [session-files.md](references/session-files.md).

### Watch or control a session interactively

Open the WebSocket `/sessions/<id>/session` with subprotocol `aperture-session.v1`, send `session.hello`, act on the `session.snapshot`. Protocol, viewport ownership, pacing, WebRTC: [live-session.md](references/live-session.md).

### Administer tenants, tokens, users

`/api/admin/*` with `system:admin`, `/api/tenant*` with `tenant:write`; routes and bodies are in the spec, delegation and allowlist rules in [control-plane.md](references/control-plane.md).

## Route by branch

Load the reference whose branch the task touches; leave the rest unloaded.

- `/api/*` behaviour the spec leaves implicit: token delegation, resource allowlists, session lifecycle, egress proxy, passive status: [control-plane.md](references/control-plane.md)
- MCP endpoints, tool catalog, `browserTools` profiles, what Playwright tools can and cannot do here: [mcp.md](references/mcp.md)
- Live-session WebSocket protocol, viewport ownership, automation pacing, WebRTC signaling, CDP proxy, local tunnel: [live-session.md](references/live-session.md)
- Recording over the three surfaces, annotations, edit settings and outputs, lifecycle: [recordings.md](references/recordings.md)
- Session files, uploads, signed download URLs, sandbox paths: [session-files.md](references/session-files.md)

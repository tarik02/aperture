# Aperture Implementation Plan

## Purpose

Build a generic Chromium session supervisor for automation agents.

The product manages isolated browser sessions, immutable saved browser-state snapshots, CDP access, browser lifecycle, retention, and remote visual access integration. It does not depend on agent-browser. agent-browser, Playwright, custom agents, and other tools are only clients that connect to the exposed CDP endpoint.

## Fixed Product Decisions

- Chromium-compatible browsers only.
- Every concurrent agent gets a dedicated Chromium process.
- The supervisor launches no browser directly. systemd user units own browser processes.
- Sessions always start as ephemeral writable state.
- Persistent browser state exists only as immutable snapshots.
- A session can be promoted into a new snapshot.
- Snapshot browser filesystem state is immutable.
- Snapshot operational metadata can change where specified.
- Snapshot names are immutable API aliases, unique per tenant.
- Filesystem paths use internal UUIDv7 ids, not names.
- Deleted sessions and snapshots are tombstoned and retained for 7 days.
- Session `expires_at` is a non-null lease timestamp.
- Any meaningful session action extends `expires_at`.
- Running sessions periodically refresh `expires_at`.
- Reopen restores a retained deleted session.
- Snapshot restore makes a tombstoned snapshot active again.
- API clients are trusted operators within their tenant.
- Tenants are administrative/API/data boundaries, not hostile OS-level security boundaries.
- Aperture runs as a per-user desktop service, initially targeting NixOS with an active Plasma session.
- Browser processes run as the same logged-in user as Aperture.
- Privileged mount/unmount operations go through a minimal sudoers helper surface.
- Sudo-able helper commands accept validated ids only, never arbitrary filesystem paths or Chromium args.
- Chromium args from callers are trusted extras.
- Server-required Chromium args always win.
- Traefik is the public edge proxy for v1.
- Aperture writes Traefik dynamic config but does not manage Traefik's lifecycle.
- Aperture listens only on loopback.
- SQLite stores orchestration metadata.
- GC is triggered by a systemd user timer through an internal request to the main Aperture process.
- Running session lease refresh is handled by a lightweight periodic monitor inside the main process.
- No backwards compatibility layer is required.
- Full testing is required before considering v1 complete.

## Tech Stack

- Language: Go.
- CLI framework: Cobra.
- Configuration library: Viper.
- HTTP router: Gin.
- Logging: Zap.
- Database: SQLite.
- Database query/schema layer: Bun ORM for Go (`github.com/uptrace/bun`).
- SQLite driver: Bun `sqliteshim` initially, with the option to force CGO SQLite later if needed.
- Migrations: explicit embedded SQL migrations, auto-run on service startup.
- Runtime validation: Go request structs plus explicit validation functions.
- Build, format, lint, and packaging: Go toolchain plus Nix.
- Tooling and final build: Nix.
- Process manager: systemd user services and timers.
- Reverse proxy: Traefik.

## CLI and Configuration

Cobra owns the command surface.

Required commands:

- `aperture serve`
- `aperture migrate`
- `aperture admin bootstrap`
- `aperture admin tenants create`
- `aperture admin tenants list`
- `aperture admin tenants update`
- `aperture admin tenants delete`
- `aperture admin tenants restore`
- `aperture admin tokens create`
- `aperture admin tokens revoke`
- `aperture trigger gc`

Viper owns configuration loading.

Configuration precedence:

1. command-line flags
2. environment variables
3. config file
4. built-in defaults

Configuration file format should be TOML or YAML, chosen during implementation based on the cleaner Nix module integration. Environment variables use an `APERTURE_` prefix. Config values are still decoded into explicit Go structs and validated before service startup.

## Implementation Environment

The current development machine has a desktop session available. Implementation and verification may run real user-level systemd commands, Traefik, Chromium, bwrap, overlay mount helpers, and browser sessions as needed.

Live desktop testing is part of the implementation plan, not a separate future exercise.

## Operational Model

Aperture is a per-user service for a graphical Linux desktop session.

The primary target for v1 is NixOS with a logged-in user running Plasma. Browser sessions should inherit or receive the same user-level display, audio, GPU, D-Bus, and runtime environment access that a normal browser launched by that user would have.

Systemd units are user units:

- `aperture.service`
- `aperture-gc.timer`
- `aperture-gc.service`, which triggers the main process over loopback
- `aperture-traefik.service`
- `browser-session@.service`

Socket activation may be used for Aperture startup, but Aperture stays running once started. A lightweight in-process monitor periodically checks systemd user state for running sessions and refreshes their `expires_at` leases. Traefik socket activation is optional and must not be a v1 dependency unless the packaged Traefik version cleanly supports the needed inherited-fd behavior.

Traefik is the only intended non-loopback HTTP listener. Aperture listens on loopback TCP. If Traefik cannot proxy to a Unix socket directly in the supported configuration, do not add a socket bridge process for v1.

## Privilege Boundary

Aperture itself should not run as root.

Privileged operations are limited to root-owned helper commands invoked through sudoers. The sudoers surface must be narrow and command-specific.

Helper rules:

- accept only ids such as session id and optional snapshot id
- validate ids before doing any work
- derive all filesystem paths from fixed configured roots
- reject symlinks and paths outside configured roots
- run with a minimal environment
- perform only one narrow operation per command
- never accept arbitrary shell fragments, filesystem paths, Chromium args, or systemd unit names from the API

Expected helper commands:

- `aperture-mount-session <session-id> [base-snapshot-id|empty]`
- `aperture-unmount-session <session-id>`

Starting, stopping, and inspecting browser units are normal user-level systemd operations and should not require sudo.

## Go Rules

- Keep domain state transitions explicit.
- Use `context.Context` on request, DB, and command boundaries.
- Use typed request/response structs.
- Validate external input immediately after binding.
- Avoid global mutable state except process-level logger/config handles initialized at startup.
- Keep filesystem, process, systemd, Traefik, and privileged-helper calls behind small package interfaces.
- Prefer explicit transactions for lifecycle changes.
- Avoid broad helper packages.
- Avoid ORM auto schema sync; use explicit SQL migrations.
- Use structured Zap fields for logs.
- Return structured application errors and map them centrally to HTTP responses.

## Code Layout

Use domain folders with this shape where the domain needs a service:

```text
cmd/
  aperture/
    main.go
internal/
  cli/
    root.go
    serve.go
    admin.go
    trigger.go
  app/
    app.go
  config/
    config.go
    validate.go
  auth/
    service.go
    token.go
    scope.go
    errors.go
  db/
    db.go
    models.go
    migrations.go
    tx.go
  session/
    service.go
    lifecycle.go
    errors.go
  snapshot/
    service.go
    promotion.go
    errors.go
  browser/
    supervisor.go
    channel.go
    runtime_env.go
    errors.go
  overlay/
    service.go
    materialize.go
    errors.go
  systemd/
    user.go
    errors.go
  traefik/
    render.go
    reconcile.go
    errors.go
  gc/
    service.go
  httpapi/
    router.go
    middleware.go
    handlers.go
    dto.go
    errors.go
  ids/
    uuidv7.go
  paths/
    bucket.go
  sudo/
    helper.go
migrations/
  000001_initial.up.sql
  000001_initial.down.sql
packaging/
  nix/
  systemd-user/
  sudoers/
```

Package boundaries should stay practical. Do not split tiny expressions into separate packages just to mirror this layout.

## Runtime Services

### ConfigService

Owns resolved runtime configuration.

Configuration fields:

- `storeRoot`
- `runtimeRoot`
- `artifactRoot`
- `traefikDynamicConfigPath`
- `apertureListenAddress`, loopback only
- `systemdBrowserUnitName`, fixed default `browser-session@.service`
- `sessionRetentionDays`, fixed default `7`
- `snapshotRetentionDays`, fixed default `7`
- `channelRegistry`
- `externalBaseUrl`
- `cdpRouteBasePath`, fixed default `/sessions`

Configuration is loaded with Viper, decoded into Go structs, and validated on startup. Application code should depend on the resolved config struct, not on Viper directly.

### DatabaseService

Owns SQLite and Bun access.

Responsibilities:

- open SQLite database
- run migrations on service startup
- provide transactional helpers
- expose typed repository/query operations
- expose the Bun DB handle only inside the database/repository layer

The database stores orchestration metadata only. Browser filesystem content is not stored in SQLite.

Use explicit SQL migrations embedded into the binary. Do not use ORM auto schema sync as the migration mechanism.

### AuthService

Responsibilities:

- authenticate API tokens
- hash API tokens for storage
- validate tenant ownership
- validate coarse scopes
- validate CDP bearer tokens through Traefik ForwardAuth

API tokens:

- multiple tokens supported
- stored hashed
- either system-admin or tenant-scoped
- coarse scopes
- revocable
- optionally expiring
- system-admin tokens can manage tenants and tenant tokens
- tenant tokens operate only within their tenant

session tokens:

- stored hashed or encrypted according to implementation choice
- one persisted token per session lifetime
- belongs to session and tenant
- not inherited by snapshots
- valid while the retained session exists
- Traefik ForwardAuth checks token, tenant, route, and session state
- distinct from API tokens
- wire format is `session_<sessionId>_<secret>`
- independently revocable
- rotatable without deleting or reopening the session

### SessionService

Owns session lifecycle.

Responsibilities:

- create and immediately start sessions
- tombstone/delete sessions
- reopen retained deleted sessions
- promote sessions to snapshots
- reconcile session state at startup
- enforce tenant ownership
- manage session tags
- extend session expiration leases after meaningful session actions
- periodically refresh running session expiration leases
- periodically verify running sessions against systemd user state

### SnapshotService

Owns snapshot lifecycle.

Responsibilities:

- create snapshots during promotion
- tombstone snapshots
- restore snapshots
- enforce name uniqueness per tenant
- manage snapshot tags
- decide GC eligibility

### BrowserSupervisorService

Owns browser runtime setup and user-level systemd orchestration.

Responsibilities:

- allocate random local CDP port
- write per-session runtime env file
- call `systemctl --user start/stop/show` through a fixed command adapter
- delete runtime env file when browser stops
- mark runtime state in DB

The service never spawns Chromium directly.

### OverlayService

Owns profile filesystem layout.

Responsibilities:

- create overlay lower/upper/work/merged directories
- mount overlayfs
- unmount overlayfs
- materialize snapshot from session overlay
- use hardlinks only for immutable snapshot files
- attempt reflink copy for mutable overlay files
- fall back to normal copy if reflink unsupported
- invoke sudo mount/unmount helpers by id only

### TraefikService

Owns generated Traefik dynamic configuration. It does not own the Traefik process lifecycle.

Responsibilities:

- generate routes from SQLite state
- generate API route to Aperture's loopback listener
- expose stable CDP route per session
- configure ForwardAuth for CDP routes
- reconcile config on startup and runtime changes
- write dynamic config atomically

Browser units never write Traefik config.

If Aperture is down, new ForwardAuth checks fail closed. Existing upgraded WebSocket connections may continue through Traefik.

### GcService

Runs inside the main Aperture process when triggered.

GC is triggered by a systemd user timer that runs a command such as:

```text
aperture trigger gc
```

The trigger command sends an authenticated loopback request to Aperture, for example `POST /internal/jobs/gc`. Socket activation may start Aperture if needed.

Internal timer-triggered jobs use a separate local job token, not a system-admin API token. The trigger sends:

```http
X-Aperture-Job-Token: <local-secret>
```

The job token authorizes only fixed internal job endpoints. It is stored in a local runtime/config file with tight permissions and is not represented as a normal API token.

Internal job endpoints must be loopback-only and job-token authenticated. If Aperture later gains multiple listeners, `/internal/jobs/*` must not be mounted on public listeners.

Responsibilities:

- expire retained deleted sessions after 7 days
- expire non-running sessions whose `expires_at` lease has passed
- physically remove session overlays after expiry
- remove session cache on expiry
- retain session artifacts for 7 days after expiry
- GC tombstoned snapshot files after 7 days when unreferenced
- preserve snapshot files while retained sessions reference them

## Identity

Use UUIDv7 for:

- tenant ids
- session ids
- snapshot ids
- api token ids
- event ids

Session ids are globally unique.

Tenant ids are the only tenant identifiers used by APIs and audit logs.

Tenant display names are mutable labels and are not identifiers.

Snapshot names are unique per tenant.

Snapshot filesystem directories use snapshot ids.

Snapshots are fully materialized independent profile trees. `parent_snapshot_id` is lineage metadata only and must not be required to use or retain a child snapshot.

Session filesystem directories use session ids.

## Filesystem Layout

Use a flat bucketed layout based on id prefixes.

Example with id `018f1234-...`:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/aperture/
  snapshots/
    01/8f/{snapshot_id}/
      profile/
  sessions/
    01/8f/{session_id}/
      upper/
      work/
      merged/
      downloads/
      cache/
      metadata/
  artifacts/
    01/8f/{session_id}/
      logs/
      crash-dumps/
```

Runtime-only files:

```text
${XDG_RUNTIME_DIR}/aperture/
  sessions/
    {session_id}.env
```

Traefik dynamic config:

```text
${XDG_RUNTIME_DIR}/aperture/traefik/dynamic.yaml
```

The actual root paths are configurable through ConfigService. The sudo mount helpers must derive the same paths from trusted configuration and ids, not from API-supplied paths.

## Overlay Model

For a session created from a snapshot:

- snapshot profile path is overlay lowerdir
- session `upper/` is overlay upperdir
- session `work/` is overlay workdir
- session `merged/` is passed as Chromium `--user-data-dir`

For an empty session:

- use the same overlay model
- lowerdir is an empty immutable directory
- upper/work/merged behave the same

The browser sees one merged profile tree.

Snapshots are never mounted writable.

## Promotion Materialization

Promotion creates a new immutable snapshot directory.

Rules:

- promotion requires a stopped retained session in v1
- promotion takes a per-session lock
- live browser flush/quiesce is a non-goal for v1
- promotion never hardlinks mutable session overlay files
- unchanged base snapshot files may be hardlinked
- no global content-addressed deduplication in v1
- changed overlay files are copied with reflink attempt first
- fallback to normal copy
- overlayfs whiteouts must be honored so deleted lowerdir files do not reappear
- overlayfs opaque directories must be honored
- volatile files are excluded
- final snapshot becomes visible only after filesystem materialization and DB transaction succeed
- materialization reconstructs from lower snapshot plus session `upper/`, not by blindly copying `merged/`
- the algorithm should remain explicit: walk lower as base, apply upper changes, honor whiteouts/opaque dirs, exclude volatile paths, hardlink unchanged lower files, reflink/copy changed upper files

Volatile exclusions:

- lock files
- sockets
- crashpad temp files
- GPU cache
- browser cache
- downloads
- browser process state
- runtime env files
- Traefik files
- systemd state

Promotion captures all non-volatile browser profile state in v1. There are no named policies and no per-category include flags.

Downloads and cache are always excluded from promotion in v1. They are retained with the session until session expiry but are never written into snapshots.

## Session Lifecycle

### Create

`POST /sessions`

Behavior:

1. authenticate API token
2. bind and validate request struct
3. resolve tenant
4. resolve optional `baseSnapshotName` within tenant
5. create session id
6. create session row
7. create session token for session lifetime
8. create overlay dirs
9. mount overlayfs
10. allocate random local CDP port
11. write runtime env file
12. start `browser-session@{sessionId}.service`
13. reconcile Traefik config
14. return session, CDP URL, and session token

The browser is running when the response succeeds.

Session creation sets `expires_at = now + sessionRetentionDays`. Running sessions refresh this lease periodically.

### Delete

`DELETE /sessions/{id}`

Behavior:

1. authenticate and authorize tenant
2. if running, stop systemd user unit
3. delete runtime env file
4. remove Traefik route or mark unavailable through generated config
5. mark session deleted
6. set `deleted_at`
7. extend `expires_at = deleted_at + sessionRetentionDays`
8. keep overlay and metadata until expiry

Delete is reversible during retention.

There is no separate close endpoint.

Deleting/stopping a session unmounts its overlay after the browser stops. Retained deleted sessions keep `upper/`, `work/`, downloads, cache, and metadata on disk, but should not remain mounted.

### Reopen

`POST /sessions/{id}/reopen`

Behavior:

1. authenticate and authorize tenant
2. require session retained and overlay present
3. clear deleted runtime status as needed
4. mount overlay
5. allocate new random local CDP port
6. write fresh runtime env file
7. start `browser-session@{sessionId}.service`
8. reconcile Traefik config
9. return session and existing persisted session token

Reopen uses the same session id.

Failed sessions are retryable through reopen while retained and not expired. Reopen on `failed` clears failed runtime fields, mounts the overlay, allocates a new CDP port, writes a fresh env file, starts the browser unit, and appends an event if retry fails again.

Successful reopen extends `expires_at`.

Session lease refresh rules:

- refresh on create
- refresh on reopen
- refresh on delete/tombstone
- refresh on promote
- refresh on session token rotation
- refresh on session tag update
- refresh on explicit `POST /sessions/{id}/touch`
- refresh periodically while status is `running`
- do not refresh on `GET /sessions/{id}` or list sessions
- do not refresh on raw CDP traffic because Aperture is not in the CDP data path

### Rotate Session Token

`POST /sessions/{id}/session-token/rotate`

Behavior:

1. authenticate and authorize tenant
2. require retained or running session
3. revoke existing session token
4. create replacement session token for the same session
5. return session, stable CDP URL, and new session token

Rotation does not delete, reopen, or restart the browser session.

Rotation affects new ForwardAuth approvals only. Existing upgraded CDP WebSocket connections may continue until the client disconnects, the browser stops, or the session is deleted.

### Expire

GC behavior:

1. find sessions past `expires_at`
2. stop browser if still running
3. remove runtime env file
4. remove route
5. unmount overlay
6. remove overlay/download/cache/session metadata
7. mark session expired
8. retain artifacts for 7 more days

Expired sessions cannot reopen.

Session expiry is a hard lease. If a running session passes `expires_at`, GC stops its browser unit, removes route/env state, unmounts the overlay, removes retained session filesystem state, and marks it expired.

### Host Reboot or Service Restart

On startup reconciliation:

- inspect DB sessions
- inspect systemd user browser units
- regenerate Traefik config
- previously running sessions that are not actually running become failed retained sessions
- no session auto-reopens after host reboot
- reopen is explicit

## Snapshot Lifecycle

### Promote

`POST /sessions/{id}/promote`

Behavior:

1. authenticate and authorize tenant
2. bind and validate request struct
3. require session retained, stopped, and not expired
4. require snapshot name unique within tenant unless tombstoned and `force: true`
5. reject `force: true` against active snapshot name
6. lock session promotion
7. materialize new snapshot from stopped overlay into temporary id directory
9. atomically rename into final snapshot id path
10. insert snapshot row
11. insert tags
12. commit transaction
13. return snapshot

Promotion does not inherit session tags.

Promotion tags are optional.

### Delete

`DELETE /snapshots/{name}`

Behavior:

1. authenticate and authorize tenant
2. mark snapshot tombstoned
3. set `deleted_at`
4. set `expires_at = deleted_at + 7 days`
5. keep files until GC and reference checks pass

### Restore

`POST /snapshots/{name}/restore`

Behavior:

1. authenticate and authorize tenant
2. require tombstoned snapshot exists
3. clear deleted state
4. make snapshot usable for new sessions again

### GC

Snapshot files are physically removed only when:

- snapshot is tombstoned
- retention has passed
- no retained or running session references it as base snapshot

Deleted snapshot names can be reused by promotion with `force: true`. Active snapshot names cannot be overridden.

## Browser Launch

The API prepares everything, then calls user-level systemd.

User systemd unit:

```ini
[Unit]
Description=Browser session %i
After=graphical-session.target
PartOf=graphical-session.target

[Service]
Type=simple
EnvironmentFile=%t/aperture/sessions/%i.env
ExecStart=%h/.nix-profile/lib/aperture/browser-session-wrapper
Restart=no
KillMode=mixed
TimeoutStopSec=20

[Install]
WantedBy=default.target
```

The Nix packaging/module should substitute the exact store path for `browser-session-wrapper` when installing the unit. The example shows user-unit intent, not a literal portable path.

Wrapper responsibilities:

- read env file
- run bwrap
- launch configured Chromium executable
- pass server-required args
- pass request-provided extra args after required args only where they cannot override required values
- preserve GPU/audio/display/D-Bus access from the logged-in user session
- keep stdout/stderr in systemd journal

Required Chromium args include:

- `--user-data-dir=${MERGED_USER_DATA_DIR}`
- `--remote-debugging-address=127.0.0.1`
- `--remote-debugging-port=${CDP_PORT}`
- cache location args pointing to per-session cache dir
- download configuration handled through profile preferences before browser launch

Request args are trusted, but server-required args win.

Aperture writes or updates Chromium profile preferences before launch so the default download directory points at the per-session downloads directory and download prompting is disabled where practical. Failure to write required preferences should fail session start explicitly.

Request-provided Chromium args are allowed, but Aperture rejects args that conflict with supervisor-owned behavior:

- `--user-data-dir`
- `--remote-debugging-address`
- `--remote-debugging-port`
- cache directory args owned by Aperture
- download directory or download preference args owned by Aperture, if applicable

The API accepts configured browser channel names only, never arbitrary executable paths.

## Browser Channel Registry

Channels are server configured.

Example config shape:

```json
{
  "channels": {
    "chromium": {
      "executable": "/usr/bin/chromium",
      "defaultArgs": []
    },
    "chrome-stable": {
      "executable": "/usr/bin/google-chrome-stable",
      "defaultArgs": []
    }
  }
}
```

API accepts channel names only. It does not accept arbitrary executable paths.

## bwrap Sandbox

Each browser process runs under bwrap after overlay mount is prepared.

The sandbox must preserve:

- GPU access
- audio access
- display access
- required browser runtime directories
- session merged user data dir
- session downloads dir
- session cache dir
- session artifacts dir

The sandbox is for accident containment and profile isolation, not a hostile multi-tenant security guarantee.

`bwrap` remains required for v1. The exact bind list for Plasma, GPU, audio, D-Bus, and browser runtime dependencies will be validated through live implementation testing.

## CDP and Traefik

Traefik is the public edge for API and CDP access. Aperture listens only on loopback and writes Traefik dynamic config.

Internal Chromium CDP:

- listens on `127.0.0.1`
- random free port per start/reopen
- not exposed directly on LAN

External route:

```text
/sessions/{sessionId}/cdp
```

The external route is stable across reopen. Traefik target port changes as runtime state changes.

Traefik routes by default:

- normal API requests to Aperture's loopback listener
- `/sessions/*`
- `/snapshots/*`
- `/admin/*`, system-admin only
- `/tenant/*`, tenant self-administration
- CDP requests directly to the session's local Chromium CDP port
- never `/internal/*` routes

Traefik uses ForwardAuth to Aperture for CDP routes:

- validate CDP bearer token
- validate session id
- validate tenant
- validate session is running
- allow websocket upgrade

If Aperture is down, new CDP ForwardAuth checks fail closed. Existing upgraded CDP WebSocket connections may continue if Traefik and Chromium remain running.

Clients receive:

- `cdpUrl`
- `sessionToken`

Clients send:

```http
Authorization: Bearer {sessionToken}
```

session token is created at session creation and persists for session lifetime.

Authorized session responses expose the persistent sessionToken alongside the stable CDP URL wherever the existing session contract exposes live access, including create, get, status, list, bulk, reopen, and rotation responses.

Portal access uses normal API auth, not the session token.

## API Authentication and Tenancy

API tokens:

- multiple tokens
- hashed in DB
- either system-admin or tenant-scoped
- coarse scopes
- revocable
- optionally expiring

API token authority types:

- `system_admin`: not tied to a tenant; can call system administration endpoints and cross-tenant endpoints according to scopes.
- `tenant`: tied to exactly one tenant; can operate only within that tenant according to scopes.

API token wire format:

```text
apt_<tokenId>_<secret>
```

Authentication parses `tokenId` to find the token row and verifies a hash of the secret material with constant-time comparison. Store no raw API tokens.

API token revocation and expiration affect new requests. In-flight requests that already passed authentication may complete.

Tenant is a hard API/data ownership boundary for:

- sessions
- snapshots
- session tokens
- tags
- events

Tenant isolation is not a Unix-user, kernel, or hostile workload isolation guarantee in v1. Tenant operators with write access are trusted to run browser processes and trusted extra Chromium args within the same logged-in user's desktop environment.

Suggested scopes:

- `system:admin`
- `sessions:read`
- `sessions:write`
- `snapshots:read`
- `snapshots:write`
- `tenant:write`
- `tenants:write`

For v1, `system:admin` is enough for system administration. Tenant tokens should not use an ambiguous `admin` scope.

System-admin tokens may cross tenants only for explicit system admin endpoints or when a cross-tenant query parameter is intentionally supported. Tenant tokens never cross tenants.

System-admin tokens must select a tenant explicitly for normal tenant-scoped resource operations. V1 tenant selection uses `X-Aperture-Tenant-Id` with a tenant id only. Tenant tokens infer tenant from the token and must not override it.

Administration route split:

- `/admin/*` is system-admin only.
- `/tenant/*` is tenant self-administration for tenant-scoped tokens with `tenant:write`.
- `/sessions/*` and `/snapshots/*` remain tenant-scoped resource routes.

Tenant token management:

- system-admin tokens can create and revoke any API token
- tenant tokens with `tenant:write` can create and revoke tenant-scoped API tokens only within their own tenant
- tenant tokens with `tenant:write` can update mutable tenant metadata such as `display_name`
- tenant tokens can never create `system_admin` tokens
- tenant deletion and restore remain system-admin only
- `tenant:write` is treated as tenant-local admin authority; do not add scope delegation/subset rules in v1

Tag mutation follows resource write scopes:

- `sessions:write` can update session tags
- `snapshots:write` can update snapshot tags
- `tenant:write` is not required for session or snapshot tag updates

Session and snapshot write scope semantics:

- `sessions:write` allows create, delete/tombstone, reopen, session token rotation, and session tag updates
- creating an empty session requires `sessions:write`
- creating a session from `baseSnapshotName` requires `sessions:write` and `snapshots:read`
- `snapshots:write` allows delete, restore, and snapshot tag updates
- promotion requires both `sessions:write` and `snapshots:write`

Bootstrap:

- `aperture admin bootstrap` works only when the database has no API tokens.
- It creates an initial system-admin token.
- It stores only the token hash.
- It prints the raw token once.
- Bootstrap token defaults to no expiration unless an expiration option is provided.
- There is no unauthenticated HTTP bootstrap endpoint.

Tenant deletion is deactivation:

- set `tenants.deleted_at`
- revoke or disable tenant-scoped API tokens
- reject new sessions and snapshots under the tenant
- stop running browser units for the tenant
- tombstone active sessions with normal 7-day retention
- remove active Traefik routes for the tenant's sessions
- do not physically cascade-delete browser state immediately
- existing snapshots remain stored but unusable while the tenant is deactivated unless explicitly deleted
- sessions and snapshots continue through their own delete/retention/GC lifecycle

Tenant restore is system-admin only:

- `POST /admin/tenants/{tenantId}/restore`
- clear `tenants.deleted_at`
- do not automatically reopen retained sessions
- do not un-revoke old tenant-scoped API tokens
- system admin can create new tenant tokens and explicitly reopen retained sessions if needed

## HTTP API

All request and response bodies must have Go struct definitions. Request structs must be validated before service-layer logic runs.

### Create Session

```http
POST /sessions
Authorization: Bearer {apiToken}
Content-Type: application/json
```

Request:

```json
{
  "baseSnapshotName": "github-main",
  "browser": {
    "channel": "chromium",
    "args": []
  },
  "tags": {
    "agent": "researcher-1",
    "task": "SUB-123"
  }
}
```

`baseSnapshotName` is optional. Omit for an empty browser state.

Response:

```json
{
  "session": {
    "id": "018f1234-0000-7000-8000-000000000000",
    "tenantId": "018f1234-0000-7000-8000-000000000001",
    "baseSnapshotName": "github-main",
    "status": "running",
    "createdAt": "2026-07-03T00:00:00.000Z",
    "deletedAt": null,
    "expiresAt": null,
    "tags": {
      "agent": "researcher-1",
      "task": "SUB-123"
    }
  },
  "cdpUrl": "https://browser.example.test/sessions/018f1234-0000-7000-8000-000000000000/cdp",
  "sessionToken": "returned-token-value"
}
```

### Delete Session

```http
DELETE /sessions/{sessionId}
Authorization: Bearer {apiToken}
```

Response:

```json
{
  "session": {
    "id": "018f1234-0000-7000-8000-000000000000",
    "status": "deleted",
    "deletedAt": "2026-07-03T00:00:00.000Z",
    "expiresAt": "2026-07-10T00:00:00.000Z"
  }
}
```

### Reopen Session

```http
POST /sessions/{sessionId}/reopen
Authorization: Bearer {apiToken}
```

Response includes existing session token:

```json
{
  "session": {
    "id": "018f1234-0000-7000-8000-000000000000",
    "status": "running"
  },
  "cdpUrl": "https://browser.example.test/sessions/018f1234-0000-7000-8000-000000000000/cdp",
  "sessionToken": "same-session-token"
}
```

### Rotate Session Token

```http
POST /sessions/{sessionId}/session-token/rotate
Authorization: Bearer {apiToken}
```

Response includes a replacement session token:

```json
{
  "session": {
    "id": "018f1234-0000-7000-8000-000000000000",
    "status": "running"
  },
  "cdpUrl": "https://browser.example.test/sessions/018f1234-0000-7000-8000-000000000000/cdp",
  "sessionToken": "new-session-token"
}
```

### Touch Session

```http
POST /sessions/{sessionId}/touch
Authorization: Bearer {apiToken}
```

Extends the session `expiresAt` lease and returns the updated session metadata.

### Promote Session

```http
POST /sessions/{sessionId}/promote
Authorization: Bearer {apiToken}
Content-Type: application/json
```

Request:

```json
{
  "name": "github-main-v2",
  "force": false,
  "tags": {
    "purpose": "github-auth"
  }
}
```

Response:

```json
{
  "snapshot": {
    "id": "018f1234-0000-7000-8000-000000000002",
    "name": "github-main-v2",
    "tenantId": "018f1234-0000-7000-8000-000000000001",
    "createdAt": "2026-07-03T00:00:00.000Z",
    "deletedAt": null,
    "tags": {
      "purpose": "github-auth"
    }
  }
}
```

### Delete Snapshot

```http
DELETE /snapshots/{name}
Authorization: Bearer {apiToken}
```

Behavior tombstones snapshot.

### Restore Snapshot

```http
POST /snapshots/{name}/restore
Authorization: Bearer {apiToken}
```

Behavior restores tombstoned snapshot.

### Update Tags

Session and snapshot tags are mutable.

Suggested endpoints:

```http
PUT /sessions/{sessionId}/tags
PUT /snapshots/{name}/tags
```

Request:

```json
{
  "tags": {
    "owner": "automation",
    "task": "SUB-123"
  }
}
```

Tags are key-value strings.

## SQLite Schema

Use Bun models for query mapping and explicit embedded SQL migrations for schema evolution.

### tenants

- `id` UUIDv7 text primary key
- `display_name` text not null
- `created_at` text not null
- `deleted_at` text nullable

### api_tokens

- `id` UUIDv7 text primary key
- `authority_type` text not null
- `tenant_id` text nullable references tenants(id)
- `name` text not null
- `token_hash` text not null
- `scopes_json` text not null
- `created_at` text not null
- `expires_at` text nullable
- `revoked_at` text nullable

Allowed `authority_type` values:

- `system_admin`
- `tenant`

Constraints:

- `tenant_id` must be null for `system_admin`
- `tenant_id` must be non-null for `tenant`

Unique:

- `(tenant_id, name)`
- `(authority_type, name)` for system-admin tokens where `tenant_id is null`

### snapshots

- `id` UUIDv7 text primary key
- `tenant_id` text not null references tenants(id)
- `name` text not null
- `path` text not null
- `parent_snapshot_id` text nullable references snapshots(id)
- `promoted_from_session_id` text nullable references sessions(id)
- `created_at` text not null
- `deleted_at` text nullable
- `expires_at` text nullable
- `gc_completed_at` text nullable

Unique:

- `(tenant_id, name)`

The unique name remains in the row even after tombstone. Promotion with `force: true` against a deleted name updates/replaces according to an explicit transactional rule. Active names cannot be overridden.

### sessions

- `id` UUIDv7 text primary key
- `tenant_id` text not null references tenants(id)
- `base_snapshot_id` text nullable references snapshots(id)
- `status` text not null
- `overlay_path` text not null
- `upper_path` text not null
- `work_path` text not null
- `merged_path` text not null
- `downloads_path` text not null
- `cache_path` text not null
- `artifacts_path` text not null
- `runtime_env_path` text nullable
- `current_cdp_port` integer nullable
- `browser_channel` text not null
- `browser_args_json` text not null
- `created_at` text not null
- `started_at` text nullable
- `stopped_at` text nullable
- `deleted_at` text nullable
- `expires_at` text not null
- `expired_at` text nullable

Allowed statuses:

- `creating`
- `running`
- `deleted`
- `expired`
- `failed`

Failed session starts leave a retained session row and filesystem state for debugging. The API call returns an error, but the failed session remains inspectable with events/artifact pointers until explicitly deleted or expired by retention.

### session_tokens

- `session_id` text primary key references sessions(id)
- `tenant_id` text not null references tenants(id)
- `token_hash` text not null
- `created_at` text not null
- `revoked_at` text nullable

### session_tags

- `session_id` text not null references sessions(id)
- `key` text not null
- `value` text not null

Primary key:

- `(session_id, key)`

### snapshot_tags

- `snapshot_id` text not null references snapshots(id)
- `key` text not null
- `value` text not null

Primary key:

- `(snapshot_id, key)`

### events

- `id` UUIDv7 text primary key
- `tenant_id` text not null references tenants(id)
- `resource_type` text not null
- `resource_id` text not null
- `type` text not null
- `message` text not null
- `data_json` text not null
- `created_at` text not null

Events are for audit/debugging. They do not drive lifecycle truth.

## Startup Sequence

On API service startup:

1. load and validate config
2. open database
3. acquire migration lock
4. run pending embedded SQL migrations automatically
5. reconcile DB session state with systemd user unit state
6. mark stale running sessions as deleted retained sessions
7. remove stale runtime env files
8. regenerate Traefik dynamic config
9. start running-session monitor
10. start HTTP server

GC is not scheduled inside `aperture serve`. A systemd user timer triggers GC by calling an internal Aperture endpoint through `aperture trigger gc`.

The running-session monitor is scheduled inside `aperture serve`. It periodically checks systemd user state for sessions marked running and extends `expires_at` for sessions that are still active.

Running-session monitor defaults:

- interval: 30 minutes
- refresh value: `expires_at = now + sessionRetentionDays`
- refresh only when DB status is `running` and systemd user unit is active

## Reconciliation Rules

DB is source of truth for retained resources.

systemd user units are source of truth for whether a browser process is running.

Traefik dynamic config is generated output.

Rules:

- running in DB but not active in systemd after unexpected exit or restart reconciliation: mark failed retained
- active in systemd but session missing/expired: stop systemd user unit
- deleted/expired sessions: no active Traefik route
- running sessions: Traefik route to current local CDP port
- missing runtime env for running session: stop unit and mark failed retained

## Traefik Dynamic Config

Generate one router/service pair per running session.

ForwardAuth endpoint:

```text
/internal/forward-auth/cdp/{sessionId}
```

ForwardAuth validates:

- `Authorization` header exists
- token matches `session_tokens`
- session id matches route
- session status is `running`
- session tenant exists
- token not revoked

Traefik config writes must be atomic:

1. render temp file
2. fsync file and parent directory where supported
3. rename over dynamic config path

## Nix

The repository must include a flake that provides both development and packaging outputs.

Nix provides:

- Go toolchain for builds
- dev shell with Go, gopls, SQLite tools, Traefik, Chromium, bwrap, and test tools
- package output for the `aperture` binary and helper binaries/scripts
- check outputs for formatting, linting, unit tests, integration tests where practical, and packaging evaluation
- systemd user unit files in final package/module
- Traefik static config template
- Traefik package/runtime dependency
- browser wrapper installation
- sudo helper installation
- sudoers snippet for helper commands
- service binary/package built from Go

Expected package outputs:

```text
/nix/store/...-aperture/
  bin/aperture
  browser-session-wrapper
  libexec/aperture-mount-session
  libexec/aperture-unmount-session
systemd user units:
  aperture.service
  aperture.socket optional
  aperture-gc.service
  aperture-gc.timer
  aperture-traefik.service
  browser-session@.service
sudoers:
  aperture-mount-helpers
```

The service should be deployable as a Nix-built artifact with no development tooling required at runtime. The flake should expose at minimum:

- `devShells.<system>.default`
- `packages.<system>.default`
- `packages.<system>.aperture`
- `checks.<system>.default`
- NixOS/Home Manager module output if the packaging shape needs one for user services and sudoers integration

## Go Tooling

Go tooling owns:

- building the service binary
- formatting with `gofmt`
- static checks with the chosen lint set
- running unit tests
- running integration tests
- running live desktop smoke tests where required

Code quality rules:

- no unchecked request input in service-layer logic
- no shell command construction from unvalidated external strings
- no sudo helper invocation with API-provided paths
- no ORM auto schema sync in production startup

## Testing Requirements

Full testing is required for v1.

Required test layers:

- unit tests for ids, path derivation, config validation, token parsing/hashing, scope checks, lifecycle state transitions, Traefik config rendering, and promotion materialization rules
- SQLite migration tests from empty database to latest schema
- repository tests for tenant, token, session, snapshot, tag, event, and lease behavior
- HTTP handler tests for auth, tenant selection, validation, and error mapping
- integration tests for systemd user command adapter with fake command runners
- integration tests for sudo helper argument validation and path derivation
- filesystem integration tests for overlay mount/unmount and whiteout/opaque materialization on Linux
- live desktop smoke tests for Chromium launch through bwrap, CDP connectivity through Traefik, delete/reopen, failed-session retry, promotion from stopped retained session, and GC expiry
- Nix checks for dev shell evaluation, package build, unit/integration test execution, and formatting/linting

Live tests may be gated behind explicit flags or Nix app/check names so routine fast checks do not unexpectedly start browsers or require sudo.

## Implementation Stages

### Stage 0: Plan and Repo Skeleton

Deliverables:

- move planning docs under `plans/`
- initialize Go module
- add Cobra command skeleton
- add Viper config loading skeleton
- add Zap logger setup
- add Gin health endpoint
- add flake with dev shell and package/check placeholders

Tests:

- `gofmt`
- `go test ./...`
- `nix flake check` evaluates dev shell, package, and checks

### Stage 1: Config, Database, and Migrations

Deliverables:

- resolved config struct and validation
- SQLite connection setup
- Bun model mapping
- embedded explicit SQL migration runner
- initial schema
- repository transaction helpers

Tests:

- config precedence and validation tests
- migration tests from empty DB
- repository transaction tests
- Nix check runs DB tests

### Stage 2: Auth, Tenants, and Admin Surface

Deliverables:

- `apt_<tokenId>_<secret>` API token generation and verification
- system-admin and tenant token authority model
- bootstrap command
- `/admin/*` tenant/token endpoints
- `/tenant/*` tenant-local display-name and token endpoints
- tenant-id selection with `X-Aperture-Tenant-Id`
- centralized HTTP error mapping

Tests:

- token parsing/hash/expiration/revocation tests
- scope and tenant-selection tests
- admin and tenant HTTP handler tests
- bootstrap idempotency and safety tests

### Stage 3: Paths, Helpers, and Systemd User Adapter

Deliverables:

- UUIDv7 ids and bucketed path derivation
- sudo mount/unmount helper commands with ids-only arguments
- systemd user command adapter
- browser runtime env rendering
- browser channel registry

Tests:

- path traversal/symlink rejection tests
- helper argument validation tests
- fake systemd adapter tests
- runtime env rendering tests

### Stage 4: Overlay and Browser Launch

Deliverables:

- overlay directory creation
- kernel overlayfs mount/unmount through helpers
- Chromium preference writing for downloads
- browser wrapper with bwrap
- session create/delete/reopen
- failed-session retention and retry
- running-session monitor

Tests:

- overlay mount/unmount integration tests
- browser arg denylist tests
- session lifecycle handler/service tests
- live desktop smoke test launching Chromium through bwrap

### Stage 5: Traefik and CDP Access

Deliverables:

- Traefik static config template
- dynamic config rendering
- API routes through Traefik except `/internal/*`
- CDP routes to session Chromium ports
- ForwardAuth endpoint
- `session_<sessionId>_<secret>` token generation, validation, and rotation

Tests:

- Traefik config render golden tests
- ForwardAuth handler tests
- session token rotation tests
- live Traefik WebSocket/CDP smoke test

### Stage 6: Snapshots and Promotion

Deliverables:

- snapshot delete/restore
- promotion from stopped retained sessions only
- manual lower-plus-upper materialization
- whiteout and opaque directory handling
- volatile/download/cache exclusions
- parent-only hardlink dedup

Tests:

- materialization unit and filesystem integration tests
- whiteout/opaque behavior tests
- promotion service and HTTP tests
- live stopped-session promotion and restore smoke test

### Stage 7: GC, Reconciliation, and Packaging

Deliverables:

- `aperture trigger gc`
- loopback-only job-token protected internal job endpoint
- GC expiry behavior for hard session leases and snapshots
- startup reconciliation
- systemd user units and GC timer
- Nix package, checks, and optional module
- installation documentation

Tests:

- GC service tests
- reconciliation tests with fake systemd state
- internal job auth tests
- Nix package build
- live end-to-end desktop smoke test covering create, CDP, delete, reopen, promote, restore, GC, and restart reconciliation

## Error Semantics

Use tagged errors and map them to HTTP responses.

Examples:

- `AuthTokenMissingError` -> 401
- `AuthTokenInvalidError` -> 401
- `ScopeDeniedError` -> 403
- `TenantResourceNotFoundError` -> 404
- `SnapshotNameConflictError` -> 409
- `SnapshotDeletedError` -> 409
- `SessionExpiredError` -> 410
- `SessionNotRunningError` -> 409 for CDP ForwardAuth
- `SystemdCommandError` -> 502 or 500 depending operation
- `OverlayMountError` -> 500
- `PromotionConflictError` -> 409
- `RequestDecodeError` -> 400

Errors should include structured fields, not arbitrary untyped causes.

## Non-Goals for v1

- Firefox support.
- Browser action API.
- Page/tab reservation API.
- Raw local CDP port exposure.
- Direct Chromium spawning from API.
- Mutable persistent profiles.
- Profile mutation in place.
- Live promotion from a running browser.
- Per-session X/Wayland display.
- Full hostile multi-tenant sandbox guarantee.
- D-Bus systemd integration.
- Named promotion policies.
- Backwards compatibility shims.
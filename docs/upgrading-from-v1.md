# Upgrading from v1

v2 is a rewrite. It shares no API, no protocol and no credential with v1, and there is no compatibility layer: nothing in v2 answers v1's routes, takes v1's tokens or speaks v1's session protocol. That was decided, not left undone.

What does carry over is **data**. A one-time migrator moves accounts, tenants, snapshots and sessions into v2 and keeps their ids. Everything that talks to Aperture (scripts, MCP configurations, embedding pages, agents' skills) is changed by hand, with this page as the map.

## v1 concept → v2 concept

| v1 | v2 | |
|---|---|---|
| One server with a SQLite database | A control plane with PostgreSQL, one executor on each node, and a proxy before them | [Install](install.md) |
| Tenant | Workspace | A workspace holds sessions and snapshots for its members. It holds no tokens |
| Personal tenant | The account itself | A session or snapshot of no workspace is its account's own |
| User | Account of kind `person` | |
| Membership with scopes per tenant | Role `member` or `admin` per workspace | |
| Tenant token | Service account with API tokens, let into workspaces | A token is always some account's |
| System-admin token, choosing a tenant with `X-Aperture-Tenant-Id` | An admin's token, or the bootstrap token | No header: `workspaceId` is a field of the request |
| API token `apt_…` | API token `apc_…` | Reissued; see below |
| Session token `aps_…`, one per session | Ticket: signed, short-lived, any number, each with its own access | Nothing durable to store. Ask for a fresh one |
| Editor and viewer capabilities `ape_…`, `apv_…` | Share links, `watch` or `control`, named, expiring, revocable | A guest gets the workbench alone |
| Roles `owner`, `editor`, `viewer` | Access by area: `input`, `tabs`, `lease`, `sound`, `clipboard`, `uploads`, `downloads`, `recordings`, `proxy`, `mcp`, `cdp`, `tunnel` | |
| Signed file URL `?token=apf_…` | A file link from `POST /sessions/{id}/file-links` | Good at that one file, for five minutes by default |
| Snapshot, addressed by name | Snapshot, addressed by id | A name is optional; find one with `GET /snapshots?name=…` |
| Deleted and expired sessions and snapshots, restorable for a while | Deleting is final | No `restore`, no `reopen` |
| A suspended session wakes on any call | A session that fell **asleep** from idleness wakes on any call. One suspended on request stays suspended until `resume` | |
| Browser channel and arguments per session | The node's browser | `browser.channel` is gone |
| Aperture Companion, connected to a tenant | [Aperture Companion](using.md#the-companion-extension), connected to an account | Install the v2 release's extension and connect again: it asks which workspace a teleport goes to |
| `initialTargets` and `storageState` when a session is created | `storageState` alone, with `tabs` in it | [Another form](../skills/aperture/references/session.md#storage-state) |
| Events and audit events | Events, one stream | |

## For an operator

- **Deployment.** v1 was one program and one image. v2 is the control plane, a proxy and one or more nodes, installed by the flake's NixOS modules. There is no single image of all of v2.
- **The image changed name and meaning.** v1's `ghcr.io/tarik02/aperture` was the whole server. v2 publishes `ghcr.io/tarik02/aperture-session`, which is one session with no control plane. Pulling the old name gets v1, for as long as it is there. See [Container image](install.md#container-image).
- **The database.** SQLite becomes PostgreSQL. The migrator reads the first and writes the second.
- **Sign-in.** No password, passkey, second factor or provider identity is moved. An admin gives each person a setup link; providers are configured again ([Configuration](configuration.md#sign-in-providers)), and a provider's client needs the new redirect address `<publicUrl>/api/auth/callback/<id>`.
- **Web sessions, OAuth clients and grants** are not moved. Everyone signs in again, and every MCP client that used OAuth registers and is approved again.
- **The command-line client is gone.** v1's `aperture` CLI was a client of v1's API and has no successor. `aperture-tunnel` stays, with a v2 address and credential.
- **Addresses.** The API moved from `/api/*` to `/api/control/*`, its description from `/openapi.json` to `/api/control/openapi.json`, health from `/api/health` to `/api/control/health`. A session's own routes moved from `/sessions/<id>/…` to `/n/<node>/sessions/<id>/…`, and that path changes when a session moves to another node: read `path` from the session. The console keeps `/-/sessions/<id>`, so saved links to a migrated session still open it.

## The migrator

`aperture-migrate` is run once, by hand. It reads v1 and never writes it.

```sh
nix run github:tarik02/aperture/v<version>#aperture-migrate -- plan \
  --v1-database /var/lib/aperture/aperture.db \
  --node node-a --node-store /var/lib/aperture-node \
  --tokens reissue --secrets-file ./v1-tokens.jsonl
```

`plan` moves nothing. It prints what would be made, what is left in v1 and why, what is moved and is not quite what it was, and what is in the way, and exits 1 while anything is in the way. `apply`, with the same flags, does what the plan says a step at a time; run again, it goes on where it stopped.

Before running it:

1. **Stop v1, and its sessions.** The database is read as a file nobody writes. v1's browsers run on after its server stops, and a session whose profile is still mounted is in the way until it is not.
2. v1's database is at v1's last migration.
3. Set v2 up: the control plane's database is reachable, and the node that is to take v1's snapshots and sessions has registered once.
4. Run it on the machine that has v1's files and that node's data directory, as the user the executor runs as (`aperture-node` under the module), with the control plane's own environment: `APERTURE_CONTROL_DATABASE_URL`, `APERTURE_CONTROL_MASTER_KEY`, `APERTURE_CONTROL_TICKET_KEY`, and `APERTURE_CONTROL_BOOTSTRAP_TOKEN` or its `_FILE`.

| It moves | As |
|---|---|
| Users with an email address | Accounts, with the same id, name, address, admin and disabled state, and no way to sign in until they open a setup link |
| Shared tenants | Workspaces with the tenant's id and name. A member who had `tenant:write` is its admin |
| Personal tenants | Nothing of their own: what they had becomes their owner's |
| Snapshots | Snapshots on the node named, with name, description and tags, the profile copied whole |
| Sessions, with their routing and files | **Suspended** sessions on the node named. One that was running when v1 stopped comes back as after a crash. `--sessions drop` leaves them all behind |
| API tokens | With `--tokens reissue`, **new** tokens with the old ids, scopes and restrictions, their secrets written to `--secrets-file`. With `--tokens drop`, none. Without the flag every live token is in the way |

It does not move: passwords, passkeys, second factors, provider identities, invitations, web sessions, OAuth clients and grants, session tokens and sharing capabilities, events, and whatever v1 had already deleted. v1's recordings come along as plain files of their sessions and are not in v2's list of recordings.

**Tokens cannot be carried over**, only replaced. v1 keeps a token as a bcrypt digest of part of it and v2 finds a token by the SHA-256 of all of it, so nothing v1 has can be turned into a token v2 accepts. Hand each holder their new token from the secrets file, then delete the file. A tenant's tokens, which were nobody's, are borne by a service account named `<tenant> tokens (from v1)`.

**Ids are kept.** A person, a workspace and a token have v1's UUID as it is; a snapshot and a session have it without its dashes, which is how v2 writes them everywhere.

[`apps/migrate/README.md`](../apps/migrate/README.md) has every flag, and what becomes of each thing in full.

## For an API consumer

Nothing works unchanged. In the order a script meets it:

| | v1 | v2 |
|---|---|---|
| Token | `apt_…` | `apc_…`, reissued |
| Scopes | `sessions:read/write`, `snapshots:read/write`, `tenant:write`, `tenants:write`, `system:admin` | `sessions:read/write`, `snapshots:read/write`, `workspaces:read/write`, `tokens:write`, `events:read`, `admin` |
| Base path | `/api` | `/api/control` |
| Errors | `{"error": {"code", "message"}}` | `{"_tag": "SessionNotFound", …}`, with fields of the tag's own |
| Lists | `{data, meta}` with cursors | A whole array. Events alone page, as `{events, next}` |
| Create a session | `browser.channel` required; answers `{session, cdpUrl, sessionToken}` | Every field optional; answers the session. Its `path` is where it is reached, and a ticket is a second call |
| Session state | `status` | `desiredState` and `observedState` |
| Tags | `PUT /sessions/{id}/tags` | `PATCH /sessions/{id}` with `tags` |
| Promote to a snapshot | `POST /sessions/{id}/promote`, `force` | `POST /sessions/{id}/snapshots`, `replaces` |
| DevTools | `<cdpUrl>` with the session token in the path | `<path>/cdp` with `Authorization`, on the discovery request and on the WebSocket both |
| Session socket | `/session`, `aperture-session.v1`, JSON | `/ws`, protobuf: a different protocol. Use `@aperture-browser/session-client` |
| Upload | `POST /uploads`, multipart | `PUT /uploads/{name}`, the body is the bytes |
| Tunnel | `/tunnel` | `/tunnel`: the same protocol, at the session's new address |

The OpenAPI document at `/api/control/openapi.json` is the reference for every route.

**MCP.** The endpoint is still `/mcp`. Tool names changed (`sessions.create`, `navigate`, `click`, `snapshot`; v1's `browser_*` names are gone), arguments are `snake_case`, and the session is named by `session_id`. A session's own MCP server moved to `<path>/mcp`. [`skills/aperture`](../skills/aperture/SKILL.md) is rewritten for v2; replace v1's copy wherever agents were given it.

## npm packages

| v1 package | v2 |
|---|---|
| `@aperture-browser/api-client` | [`@aperture-browser/control-api`](../packages/control-api), whose `./client` makes a typed client. A different API throughout |
| `@aperture-browser/api-schema` | Gone. The schemas are in `@aperture-browser/control-api` |
| `@aperture-browser/live-session` | [`@aperture-browser/session-client`](../packages/session-client). No name survives |
| `@aperture-browser/session-relay` | Gone, with no successor. Your backend asks for a ticket (`POST /api/control/sessions/{id}/tickets`) and hands it to the page |
| `@aperture-browser/session-react` | [Same name](../packages/session-react), different API: `<ApertureSession url token>` in place of `access` |
| `@aperture-browser/session-element` | [Same name](../packages/session-element), different attributes: `url` and `token` (a ticket) in place of `base-url` and a capability |
| | [`@aperture-browser/executor-client`](../packages/executor-client) is new |

The two packages that keep their name are not drop-in upgrades: v1 markup such as `<aperture-session token="ape_…" base-url="…">` renders nothing in v2, which needs `url`. [Using](using.md#embedding-a-session) shows the new shape.

v2's packages are published as `1.0.0-beta.N` under the dist-tag `beta`, so `npm install @aperture-browser/session-react@beta` is v2.

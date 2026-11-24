---
name: aperture
description: Operate an Aperture control plane and its browser sessions over MCP and HTTP. Use when a task creates, inspects, suspends, resumes or snapshots a session, drives a page in one, records it, moves files in or out, hands a session to a person, routes its network, or manages workspaces, service accounts and API tokens.
---

# Aperture

Aperture runs isolated browser sessions that people and agents watch and control together. One origin serves everything:

```bash
export APERTURE_URL="https://aperture.example.com"
export APERTURE_TOKEN="apc_…"   # an API token; leave unset when the MCP client signed in over OAuth
```

| Surface | Where | Source of truth |
|---|---|---|
| MCP | `$APERTURE_URL/mcp` | The server's tool list: every tool, its arguments and what it returns. Use it first. |
| Control API | `$APERTURE_URL/api/control/*` | `$APERTURE_URL/api/control/openapi.json`: every route, body and error. [control-plane.md](references/control-plane.md) adds what it leaves unsaid. |
| A session's own routes | `$APERTURE_URL<session.path>/*` | [session.md](references/session.md) |

## Credentials

- **MCP client with OAuth**: point it at `$APERTURE_URL/mcp`; it registers itself, and a person approves its scopes in the browser.
- **API token** (`apc_…`): `Authorization: Bearer $APERTURE_TOKEN` on `/mcp`, on `/api/control/*`, and on any route below a session's `path`.
- **Ticket**: a short-lived pass into one session, from `sessions.ticket`. Send it as a bearer token or as `?token=` on that session's routes.

A token does what its scopes name; writing includes reading. `sessions:read` sees sessions and watches them; `sessions:write` does everything else in one, the browser tools included; `snapshots:read`/`snapshots:write`; `workspaces:read`/`workspaces:write`; `events:read`; `tokens:write`; `admin`. Creating a session from a snapshot takes `snapshots:read` too. A refusal names the missing scope; `account.get` tells what the token in hand is for.

## Workflows

Tools are named as the MCP server lists them. Each has the same call in the control API.

### Drive a page

1. `sessions.create` (optionally `label`, `tags`, `snapshot_id`, `workspace_id`). Keep its `id`: it is the `session_id` of every tool below. Done when `observedState` is `running`; poll `sessions.get` until then.
2. `navigate` with `session_id` and `url`; keep the `tab` it returns.
3. `snapshot` the tab; act on the refs it gives with `click`, `fill`, `type`, `press`, `select`; check with `snapshot` or `screenshot`.
4. End with `sessions.suspend` to keep the session, or `sessions.delete` to drop it with its profile and files.

A session without a snapshot is signed in nowhere. The browser tools appear in the tool list once a session runs; before that, `sessions.tools` lists them and `sessions.call` calls one by name.

A session suspended with `sessions.suspend` stays suspended until `sessions.resume`.

### Keep a signed-in profile

1. Sign in inside a session (hand it to a person for that: see below).
2. `sessions.promote` with a `name`. Its `id` is the `snapshot_id` later sessions start from.
3. To refresh it, promote again with `replaces: <old snapshot id>`.

Use the exact snapshot the user names; `snapshots.list` (`name`, `tag`) finds its id.

### Record what you do

1. `recording` with `action: "start"`, the `tab`, and `capture: "bursts"`; keep its `id`.
2. Drive the page. `action: "caption"` with `text` where a viewer needs context; `focus` … `reset_focus` around what should be seen up close.
3. `action: "stop"` with the `id`.
4. Poll `action: "status"` until `edit.state` is `finished`; `edit.file` is the edited video, `file` the raw one. `failed` comes with `edit.failure`.
5. Fetch it: see the next workflow.

### Move files out and in

Out:
1. `files` lists the session's files; take the `path` (`recordings/….edited.mp4`, `screenshots/…`, `downloads/…`).
2. `sessions.file_link` with that `path` returns a `url` good for five minutes.
3. `curl -fsSLo out.mp4 "<url>"`. The URL needs no other credentials.

In:
1. `sessions.file_link` with `path: "uploads/<name>"` and `write: true`.
2. `curl -fsS -T ./report.pdf "<url>"`.
3. `files` with `directory: "uploads"` gives the file's `absolute` path; pass it as `files` to `upload` with the `tab` and the input's `ref` or `selector`.

### Hand a session to a person

- **Someone with an account, now**: `sessions.ticket` returns a `url` that opens the session's workbench. Without `access` they watch; to let them act, pass `access: {"input":"rw","tabs":"rw","lease":"rw","clipboard":"rw"}`. The link lets them in for about ten minutes; a page that is open stays open.
- **Someone without an account, or for later**: `shares.create` with `name`, `role` (`watch` or `control`) and `expires_in_hours`. Its `url` is told once. `shares.revoke` puts its guests out.

Then wait for the person to say they are done; `snapshot` shows what they left.

### Route the session's network

`sessions.set_proxy` replaces the session's routing; `sessions.proxy` reads it; `null` turns it off. The first rule whose `match` (`host`, `host:port`, `*.suffix`, `*`, an address, a network such as `10.0.0.0/8`, IPv6 with a port as `[::1]:443`) fits decides, by `via`: `direct`, `refuse`, `local`, an upstream's name, or a proxy URL.

```json
{"upstreams": {"exit": {"url": "socks5://user:pass@proxy.example:1080"}},
 "rules": [{"match": "*.internal.example", "via": "refuse"}, {"match": "*", "via": "exit"}]}
```

To reach a service on your own machine from the session's browser:
1. `sessions.set_proxy` with `{"rules": [{"match": "localhost:3000", "via": "local"}]}`.
2. Leave running: `aperture-tunnel attach --token "$APERTURE_TOKEN" "wss://<host><session.path>/tunnel"`.
3. `navigate` to `http://localhost:3000`. Done when the page loads.

### Work in a workspace

A session or snapshot made with a `workspace_id` belongs to all the workspace's members. `workspaces.list` gives the ids; `workspaces.create`, `workspaces.admit` (`account_id`, `role`: `member` or `admin`), `workspaces.dismiss` and `workspaces.members` manage one. `sessions.list` and `snapshots.list` take `workspace_id` (`none` for the account's own).

Service accounts, people and API tokens are made over the control API alone: [control-plane.md](references/control-plane.md).

## Route by branch

- Accounts, service accounts, API tokens, token resources, what an error looks like, session states: [control-plane.md](references/control-plane.md)
- A session's own HTTP routes, DevTools (CDP), storage state, screenshots, tickets and their access areas: [session.md](references/session.md)

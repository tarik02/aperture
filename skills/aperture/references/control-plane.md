# Control API

`$APERTURE_URL/api/control/openapi.json` is the reference for every route. This file holds what the document leaves unsaid.

```bash
api() { curl -fsS -H "Authorization: Bearer $APERTURE_TOKEN" -H 'Content-Type: application/json' "$@"; }
```

`GET /api/control/health` answers `{"status":"ok"}` to anyone once the control plane serves. `GET /api/control/about` answers the version it runs, `{"version":"1.0.0"}`, to any caller.

## Errors

A refusal is a JSON object with a `_tag` and that tag's own fields, with the HTTP status the document names:

```json
{"_tag": "SessionNotFound", "id": "…"}
{"_tag": "Forbidden", "message": "this token is not for sessions:write"}
```

Something that is another account's is told as not found, never as forbidden.

## Sessions

- `desiredState` is what was asked (`running`, `suspended`); `observedState` is what the node says (`starting`, `running`, `suspending`, `suspended`, `failed`, `gone`). `failure` says why a session failed.
- Deleting is final: the profile and files go with the session. Snapshots taken of it stay.
- `path` is where the session's own routes are, below `$APERTURE_URL`. It changes when the session moves to another node; read it again after a `409` with `_tag: "SessionElsewhere"`.
- Lists are whole arrays. Narrow them: `GET /sessions?tag=task=demo&state=running&label=shop&workspaceId=none`; `GET /snapshots?name=…&tag=…&workspaceId=…`. `tag=name` matches any value.
- `PATCH /sessions/{id}` sets `label` and `tags`; the tags given take the place of the tags there were.

## Accounts and tokens

An account is a person, who signs in, or a service, which has API tokens alone. Both hold sessions and snapshots and are let into workspaces. Making, changing, disabling and removing accounts takes an admin's token with the `admin` scope.

A service account with a token, let into a workspace:

```bash
BOT=$(api -X POST "$APERTURE_URL/api/control/accounts" -d '{"name":"Crawler","kind":"service"}' | jq -r .id)
api -X POST "$APERTURE_URL/api/control/accounts/$BOT/tokens" \
  -d '{"name":"ci","scopes":["sessions:write","snapshots:read"],"expiresInDays":30}' | jq -r .token
api -X PUT "$APERTURE_URL/api/control/workspaces/$WORKSPACE/members/$BOT" -d '{"role":"member"}'
```

- The `token` is told once, when it is made.
- `POST /account/tokens` makes a token of the caller's own account (`tokens:write`); it cannot have a scope the caller's token lacks.
- `resources: {"workspaces": [ids], "sessions": [ids], "snapshots": [ids]}` on a new token holds it to those: it sees and changes nothing else, makes sessions only in the workspaces named, and makes and revokes no tokens.
- `PATCH /accounts/{id}` renames an account and says whether it is an admin (`{"name": …, "admin": …}`). `POST /accounts/{id}/disable` puts it out of use and everyone in a session as it out; `enable` undoes that.
- A person is made with `{"name": …, "email": …}` and signs in after opening the setup link made from `POST /accounts/{id}/setup-token`: `$APERTURE_URL/invite#token=<token>`.

## Workspaces

- Any token is told the workspaces its account is in; who else is in one takes `workspaces:read`.
- Renaming, deleting, admitting and dismissing take `workspaces:write` and being an admin of that workspace.
- An admin (a person's console session, or a token with the `admin` scope) is told every workspace; `role` is `null` in one they are not in. There they read: the workspace, its members, its sessions and snapshots, a watching ticket, a file link that reads. Acting there (creating, changing, suspending, resuming or deleting a session, a ticket with access, an upload link, a share link, taking, changing or deleting a snapshot, a session from its snapshots) is refused with `Forbidden` until they admit themselves with `PUT /workspaces/{id}/members/{accountId}`. Another account's own sessions and snapshots, of no workspace, an admin acts on as before.
- A workspace is deleted once no session and no snapshot is of it.

## Settings

Settings are said at the instance, a workspace, an account, an account as a member of a workspace, and a session, the nearest winning; each level may also set `min`/`max` (or `allowed` for a choice) that it and the levels below cannot cross. Times are in seconds, `null` is never or no limit.

```bash
api "$APERTURE_URL/api/control/sessions/$SESSION/settings" | jq '.settings[] | {key, effective}'
api -X PUT "$APERTURE_URL/api/control/workspaces/$WORKSPACE/settings/deleteSuspendedAfter" -d '{"value":604800,"max":2592000}'
api -X PUT "$APERTURE_URL/api/control/sessions/$SESSION/pin" -d '{"pinned":true}'
```

- `effective.source` says where a value comes from (`instance`, `workspace`, `account`, `member`, `session`, `configuration`, `default`, or `node` for each node's own); `locked` is a bound of both ends alike.
- `/account/settings` (`?workspaceId=` for what the caller has in a workspace) is the caller's own: they say values there, inside bounds an admin set, and no bounds (`changeable`, `bounds` say what they may). A quota below the instance is at most what the levels above make of it: a person lowers their own, and raises it no further than an admin's. An admin says an account's at `/accounts/{accountId}/settings`, a workspace's admin a member's at `/workspaces/{id}/members/{accountId}/settings`.
- A value past a bound above is refused with `SettingOutOfBounds`, whose `level` names who set the bound.
- A pinned session is never deleted by `deleteSuspendedAfter` or `maxSessionAge`. Who pins is the `pinning` setting; one pin too many is `QuotaExceeded`.
- Quotas (`sessionsPerUser`, `sessionsPerWorkspace`, `runningSessions`) refuse creating or resuming past them with `QuotaExceeded`; `sessionMemory` and `sessionCpus` bound what each session uses.
- `clipboard`, `uploads`, `downloads` and `recording` hold every ticket into a session; a file link for what is off is `Forbidden`. A share link or an API token longer than `shareLinkMaxLifetime` / `apiTokenMaxLifetime`, or one that never runs out where those are set, is `SettingOutOfBounds`.
- Over MCP: `settings.get`, `settings.set`, `settings.clear`, `sessions.pin`.

## Events

`GET /events` (`events:read`) lists what was done, newest first, as `{events, next}`; pass `next` back as `cursor`. Filters: `kind`, `resourceKind`, `resourceId`, `workspaceId`, `actor`, `since`, `until`, `limit` (at most 200). A token reads the events of its own account and of the workspaces that is in; an admin reads all.

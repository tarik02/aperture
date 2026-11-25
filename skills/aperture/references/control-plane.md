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
- A workspace is deleted once no session and no snapshot is of it.

## Events

`GET /events` (`events:read`) lists what was done, newest first, as `{events, next}`; pass `next` back as `cursor`. Filters: `kind`, `resourceKind`, `resourceId`, `workspaceId`, `actor`, `since`, `until`, `limit` (at most 200). A token reads the events of its own account and of the workspaces that is in; an admin reads all.

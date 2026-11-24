# A session's own routes

A running session serves its own routes below its `path` (from `sessions.get`): `$APERTURE_URL<path>/…`. Prefer the MCP tools; reach for these when a task needs bytes or a protocol the tools do not carry.

```bash
SESSION_URL="$APERTURE_URL$(curl -fsS -H "Authorization: Bearer $APERTURE_TOKEN" \
  "$APERTURE_URL/api/control/sessions/$SESSION_ID" | jq -r .path)"
```

## Who gets in

- An API token with `sessions:write` reaches every route; with `sessions:read` it watches (`/targets`, previews, the session socket) and nothing else.
- A ticket reaches what its `access` says, area by area, each `r`, `w` or `rw`: `input`, `tabs`, `lease`, `sound`, `clipboard`, `uploads`, `downloads`, `recordings`, `proxy`, `mcp`, `cdp`, `tunnel`. Watching takes none.
- A link from `sessions.file_link` is a ticket good at that one file and nowhere else.
- A share link's guest gets the workbench alone: never files, routing, automation or DevTools.

Refusals here are plain text with a status: `401` no good credential, `403` the credential does not give this, `404` no such thing.

## Routes

| Route | What it is | Access |
|---|---|---|
| `GET /` | The workbench page; append `?token=<ticket>` | watching |
| `GET /targets` | The tabs: `id`, `tab`, `title`, `url`, size | watching |
| `GET /targets/{tab}/screenshot.png` | The tab as a PNG, now | watching |
| `GET /targets/{tab}/favicon` | The icon of the tab's page, as the session's browser fetches it; `204` where the page has none | watching |
| `GET /recordings`, `GET /screenshots`, `GET /downloads`, `GET /uploads` | What there is of each, as JSON | `recordings:r`, `downloads:r`, `uploads:r` |
| `POST /recordings` | Starts recording `tab` (the newest when left out); `follow: true` has it go on with the tab automation acts on | `recordings:w` |
| `POST /recordings/{id}/stop` | Stops it; the body says how its edit is made: `capture`, `idle`, `ripple`, `burst`, `motion_threshold`, `fps` | `recordings:w` |
| `POST /recordings/{id}/edit` | Makes the edit again from the same raw video, with a body as `stop` takes; `409` while one is being made or the raw video is gone | `recordings:w` |
| `GET /pace`, `PUT /pace` | How automation moves the pointer in what is recorded: `{"pace": "instant" \| "fast" \| "slow"}` | `recordings:r`, `recordings:w` |
| `GET /files/<path>` | A file's bytes, `path` as the `files` tool gives it | the area of its directory |
| `PUT /uploads/{name}` | Puts a file for a page to take; the body is the bytes | `uploads:w` |
| `POST /storage-state` | Cookies and the storage of origins, out of the browser as JSON; `PUT` puts one in, with tabs to open | `cdp:w` |
| `POST /mcp` | The session's own MCP server: the browser tools without `session_id` | `mcp:w` |
| `/cdp`, `/cdp/json/version` | The browser's DevTools endpoint | `cdp:w` |
| `/tunnel` | Where `aperture-tunnel attach` connects | `tunnel:w` |

## DevTools (CDP)

```bash
curl -fsS -H "Authorization: Bearer $APERTURE_TOKEN" "$SESSION_URL/cdp/json/version"
```

The WebSocket URLs in the answer carry no credential: send the same `Authorization` header when opening them, as Playwright's `connectOverCDP(url, {headers})` does. Input given through DevTools is not seen by people who watch; the MCP tools give input they see.

## Storage state

```bash
curl -fsS -X POST -H "Authorization: Bearer $APERTURE_TOKEN" -H 'Content-Type: application/json' \
  -d '{}' "$SESSION_URL/storage-state" > state.json
```

`{"cookies": […], "origins": […]}`. A snapshot keeps the whole profile; a storage state is the part that moves between browsers.

The body says what to take: `origins` is `"open-tabs"` (the default) or a list of origins, `cookies` is `"matching"` (those that go to these origins, the default) or `"all"`, and `indexed_db`, `cache_storage` and `opfs` each add a kind of what the origins store, which is left out otherwise. An export fails where a database holds what cannot be written down, such as a key that may not leave the browser.

`PUT` takes the same document: cookies beside those there are, each origin's local storage in place of what it had, and each database, cache and file in place of the origin's one of that name. It takes two things an export does not give:

- an origin with `ancestorOrigins`, the top one first, for what it stores while it is embedded in a page of another site, which the browser keeps apart;
- `tabs`, each opened beside the tabs that show something:

```json
{ "tabs": [
  { "url": "https://example.com/inbox", "active": true,
    "sessionStorage": [{ "origin": "https://example.com", "entries": [{ "name": "k", "value": "v" }] }],
    "document": { "scroll": { "x": 0, "y": 240 }, "windowName": "inbox" } },
  { "url": "https://example.com/compose", "opener": 0 }
] }
```

A tab's session storage and `window.name` are there before its page's scripts run; `opener` is the index of the tab that opens it. The `active` tab is opened last where its opener lets it, as the newest tab is what whoever opens the session is shown. `POST /api/control/sessions` takes the same document as `storageState`, for a session that starts with it.

## A session served on its own

A runner started with `serve` has the same routes at its root, takes its operator token, and has no control plane: files are fetched at `/files/<path>` and put at `/uploads/<name>` with that token.

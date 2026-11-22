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
| `GET /recordings`, `GET /screenshots`, `GET /downloads`, `GET /uploads` | What there is of each, as JSON | `recordings:r`, `downloads:r`, `uploads:r` |
| `GET /files/<path>` | A file's bytes, `path` as the `files` tool gives it | the area of its directory |
| `PUT /uploads/{name}` | Puts a file for a page to take; the body is the bytes | `uploads:w` |
| `POST /storage-state` | Cookies and local storage of the browser, as JSON; `PUT` puts one in | `cdp:w` |
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

## A session served on its own

A runner started with `serve` has the same routes at its root, takes its operator token, and has no control plane: files are fetched at `/files/<path>` and put at `/uploads/<name>` with that token.

# Session files

Apply the credential and tenant-selection rules from [authentication.md](authentication.md).

Session files are the regular files below one per-session files root. Every listing, signed download URL, upload response, and browser tool uses the same relative paths:

- `downloads/` — browser downloads
- `recordings/` — completed recordings
- `uploads/` — files sent to `POST /sessions/:sessionId/uploads`
- `outputs/` — Playwright MCP output such as screenshots; a browser tool file saved under an explicit name lands at that path instead

Hidden entries (in-progress uploads and recording segments) are not session files. Sessions keep their files, including while suspended, until they expire. Session files never enter a promoted snapshot, and a session created from a snapshot starts with no files.

Inside the browser sandbox the files root is mounted at `/session/files`, so each file also has a `sandboxPath` such as `/session/files/downloads/invoice.pdf`. Pass it to CDP `DOM.setFileInputFiles` while the session runs. Host paths are never returned.

The session token authorizes session-bound MCP, not the REST file routes. Session-token holders list files and create download URLs through `/sessions/:sessionId/mcp`.

## MCP

- central `session_files.list` takes `sessionId` and `tenantId` where required by the caller's authority
- central `session_files.create_download_url` takes `sessionId`, `relativePath`, optional `ttlSeconds`, and `tenantId` where required
- session-bound versions omit tenant and session identity inputs and bind them from `/sessions/:sessionId/mcp`

`session_files.list` returns `name`, `relativePath`, `size`, `modifiedAt`, `mimeType`, and `sandboxPath`. MCP returns metadata and signed URLs rather than large file contents.

Pass any session file's `relativePath` to `browser_file_upload`, for example a download to re-upload it. To bring in outside bytes, send them to `POST /sessions/:sessionId/uploads` (see [live-session.md](live-session.md#uploads)) first.

## HTTP

`GET /api/sessions/:sessionId/files` requires `sessions:read` and returns the same metadata as `session_files.list` as a JSON array. It reads the retained session directory, so it also works for suspended, stopped, and deleted sessions until they expire. Resource-restricted tokens need a grant for the session.

`POST /api/sessions/:sessionId/files/download-url` requires `sessions:read` and accepts:

```json
{
  "relativePath": "recordings/recording-019f6cf0-0000-7000-8000-000000000010.webm",
  "ttlSeconds": 900
}
```

The response contains `url` and `expiresAt`. Omit `ttlSeconds` to use the configured default.

Signed downloads use:

```text
/sessions/:sessionId/files/<relative-path>?token=...
```

The query token uses `apf_<payload>.<signature>` and is bound to the exact session and relative path. Omitting `ttlSeconds` uses `signed_file_url_ttl` (15 minutes by default); callers may request any positive lifetime up to `signed_file_url_max_ttl` (24 hours by default). The route validates the signature, expiry, path, and session file root before serving an attachment.

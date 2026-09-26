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

`session_files.list` returns files only, each with `name`, `relativePath`, `size`, `modifiedAt`, `mimeType`, and `sandboxPath`. MCP returns metadata and signed URLs rather than large file contents.

Pass any session file's `relativePath` to `browser_file_upload`, for example a download to re-upload it. To bring in outside bytes, send them to `POST /sessions/:sessionId/uploads` (see [live-session.md](live-session.md#uploads)) first.

## HTTP

`GET /api/sessions/:sessionId/files` requires `sessions:read` and returns the same metadata as `session_files.list` as a JSON array. It reads the retained session directory, so it also works for suspended, stopped, and deleted sessions until they expire. Resource-restricted tokens need a grant for the session.

Managing files needs `sessions:write`, follows the same tenant and resource-grant rules, and works in every retained state:

- `POST /api/sessions/:sessionId/files?directory=uploads` stores `multipart/form-data` file parts in a directory below the files root (default `uploads`) and returns `{ "files": [...] }`. Names are sanitized and suffixed instead of overwriting; the upload limits of the data-plane route apply (`session_file_too_large`, `session_storage_quota_exceeded`, `session_file_limit_exceeded`).
- `POST /api/sessions/:sessionId/files/directories` with `{ "relativePath": "uploads/invoices" }` creates a directory and its missing parents. An existing entry fails with `session_file_exists`.
- `DELETE /api/sessions/:sessionId/files?relativePath=downloads/invoice.pdf` deletes a file or directory and answers `204`. A directory with entries needs `&recursive=true`, otherwise it fails with `session_directory_not_empty`.
- `POST /api/sessions/:sessionId/files/move` with `{ "from": "downloads/invoice.pdf", "to": "uploads/invoices/2026-08.pdf" }` moves or renames a file or directory and returns it. An existing target fails with `session_file_exists`.

The listing includes directories as `{ "type": "directory", "name", "relativePath", "modifiedAt" }` next to `{ "type": "file", ... }` entries, so empty directories show up. Paths must stay below the files root and may not contain hidden components. Anything still being written fails with `session_file_busy`, including anything inside a directory being moved or deleted. `downloads`, `recordings`, `uploads`, and `outputs` cannot be deleted or moved (`session_directory_protected`). Changes are recorded as `session.file_uploaded`, `session.file_deleted`, `session.file_moved`, `session.directory_created`, `session.directory_deleted`, and `session.directory_moved` events.

`POST /api/sessions/:sessionId/files/download-url` requires `sessions:read` and accepts:

```json
{
  "relativePath": "recordings/recording-019f6cf0-0000-7000-8000-000000000010.webm",
  "ttlSeconds": 900
}
```

The response contains `url` and `expiresAt`. Omit `ttlSeconds` to use the configured default. Pass `"disposition": "inline"` for a URL a browser can display, such as an `<img>` source; the default is `attachment`. Downloads carry the detected `Content-Type`, support byte ranges, and get `Content-Security-Policy: sandbox` when they could run scripts (HTML, SVG, and other non-media types).

Signed downloads use:

```text
/sessions/:sessionId/files/<relative-path>?token=...
```

The query token uses `apf_<payload>.<signature>` and is bound to the exact session and relative path. Omitting `ttlSeconds` uses `signed_file_url_ttl` (15 minutes by default); callers may request any positive lifetime up to `signed_file_url_max_ttl` (24 hours by default). The route validates the signature, expiry, path, and session file root before serving an attachment.

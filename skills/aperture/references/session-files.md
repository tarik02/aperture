# Session files

Every session has one files root; a session file is a regular file below it, named everywhere by its path relative to that root. The root is mounted in the browser sandbox at `/session/files`, so each file also has a `sandboxPath` (`/session/files/downloads/invoice.pdf`) for CDP `DOM.setFileInputFiles` while the session runs. Host paths never appear.

| Directory | Contents |
|---|---|
| `downloads/` | browser downloads |
| `recordings/` | recordings, their edits and timelines |
| `uploads/` | files sent in through the uploads routes |
| `outputs/` | Playwright MCP output such as screenshots; a tool given an explicit file name writes to that path instead |

The four directories cannot be deleted or moved. In-progress uploads and recording segments are hidden and are not session files. Files outlive suspension and deletion until the session expires; they never enter a promoted snapshot, and a session created from a snapshot starts with none.

## Listing and managing

`GET /api/sessions/:id/files` (`sessions:read`) lists files and directories of any retained session; `POST …/files`, `POST …/files/directories`, `POST …/files/move` and `DELETE …/files` (`sessions:write`) manage them. Bodies, limits and error codes are in the spec. Over MCP, `session_files.list` returns the same file metadata (`name`, `relativePath`, `size`, `modifiedAt`, `mimeType`, `sandboxPath`), and a session token can use it where it cannot use `/api/*`.

## Uploads

Two multipart routes store every part that carries a filename, sanitizing names and suffixing instead of overwriting, and answer `201 {"files": [...]}` with the listing's file entries:

- `POST /sessions/:id/uploads` while the session runs, with `sessions:write` or the `aps_` token; files land in `uploads/`.
- `POST /api/sessions/:id/files?directory=<dir>` for any retained session, with `sessions:write`; `directory` defaults to `uploads`.

```bash
curl -fsS -H "Authorization: Bearer $SESSION_TOKEN" \
  -F "files=@invoice.pdf" "$APERTURE_BASE_URL/sessions/$SESSION_ID/uploads"
```

Limits: 100 files per request, 1000 uploads per session, `session_upload_max_file_bytes` per file (100 MiB by default, `413`), `session_storage_quota_bytes` per session (1 GiB by default, `507`), three concurrent uploads per session on the API route (`429`). A rejected request stores nothing. Hand the returned `relativePath` to `browser_file_upload`, which accepts any session file, downloads and recordings included.

## Download

`POST /api/sessions/:id/files/download-url` (`sessions:read`) or `session_files.create_download_url` with `relativePath` and optional `ttlSeconds` (default `signed_file_url_ttl`, 15 minutes; at most `signed_file_url_max_ttl`, 24 hours) and `disposition` (`attachment` by default, `inline` for an `<img>` source) returns `url` and `expiresAt`. The URL is

```text
$APERTURE_BASE_URL/sessions/:id/files/<relative-path>?token=apf_<payload>.<signature>
```

bound to that session and path; anyone holding it can download until it expires. Downloads carry the detected `Content-Type`, support byte ranges, and get `Content-Security-Policy: sandbox` when the type could run scripts.

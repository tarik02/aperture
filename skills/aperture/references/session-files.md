# Session files

Apply the credential and tenant-selection rules from [authentication.md](authentication.md).

Session files are limited to regular files below the session's `downloads` and `recordings` directories. Browser downloads and session recordings are included.

## MCP

- central `session_files.list` takes `sessionId` and `tenantId` where required by the caller's authority
- central `session_files.create_download_url` takes `sessionId`, `relativePath`, optional `ttlSeconds`, and `tenantId` where required
- session-bound versions omit tenant and session identity inputs and bind them from `/sessions/:sessionId/mcp`

`session_files.list` returns `name`, `relativePath`, `size`, `modifiedAt`, and `mimeType`. MCP returns metadata and signed URLs rather than large file contents.

Session-file paths under `downloads/` and `recordings/` cannot be passed directly to Playwright's `browser_file_upload`, whose allowed root is the session artifact directory. To reuse one in a browser upload, fetch it through a signed URL, upload the bytes with `POST /sessions/:sessionId/uploads` (see [live-session.md](live-session.md#uploads)), then pass the returned `uploads/<name>` path to `browser_file_upload`.

## HTTP

`GET /api/sessions/:sessionId/files` requires `sessions:read` and returns the same metadata as `session_files.list` as a JSON array. Like MCP, it reads the retained session directory, so it also works for suspended, stopped, and deleted sessions until they expire. Resource-restricted tokens need a grant for the session.

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

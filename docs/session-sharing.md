# Session sharing

Aperture session tokens can be shared as short-lived capabilities for one browser session. A capability grants browser control, CDP access, file listing and downloads, and uploads. It does not grant tenant access or session lifecycle operations such as suspend, reopen, delete, promote, tag changes, or token rotation.

## Share links

Account tokens with `sessions:write` can retrieve the session token from session creation and single-session detail responses. Session lists, bulk responses, read-only detail responses, wrapper status responses, and ordinary mutation responses do not expose it.

The web interface copies links in this form:

```text
https://aperture.example/share/#token=cdp_<session-id>_<secret>
```

The share route moves the token into tab-scoped session storage and removes it from the address bar. It uses the session ID embedded in the token to connect to the existing session routes. Opening a share link never adopts or falls back to account credentials already stored in the browser.

Rotating the session token invalidates new share, browser transport, file, and CDP authorizations. Existing direct CDP WebSockets remain connected until they close.

## Capability authentication

Session HTTP routes accept the token as a bearer credential:

```http
Authorization: Bearer cdp_<session-id>_<secret>
```

WebSocket routes use the existing bearer subprotocol:

```text
authorization.bearer.cdp_<session-id>_<secret>
```

No tenant header is required. The token's embedded session ID must match the routed `/sessions/:sessionId/...` path. Suspended sessions wake through the same activity path used by direct CDP access.

Direct CDP discovery and WebSocket URLs keep the existing path-token format:

```text
/sessions/<session-id>/cdp/<session-token>/
```

## Files

File requests use the existing session routing layer and are handled by the per-session wrapper:

```text
GET  /sessions/<session-id>/files
GET  /sessions/<session-id>/files/<kind>/<name>
POST /sessions/<session-id>/uploads
```

`kind` is one of `uploads`, `downloads`, or `artifacts`. Listings are non-recursive and include only top-level regular files. Symlinks are ignored. Downloads use attachment disposition and support HTTP byte ranges.

Uploads use `multipart/form-data` and may contain multiple files. Names are sanitized and collisions receive a numeric suffix instead of overwriting an existing file. The response includes the relative session path and absolute browser-visible path so CDP clients can use uploaded files with `DOM.setFileInputFiles`.

Each request accepts at most 100 files, and a session may retain at most 1,000 uploaded files.

File routes accept either a matching session capability or an account token with `sessions:write`.

## Limits and audit events

The default per-file upload limit is 100 MiB. Before accepting an upload, Aperture measures writable session data under the overlay upper directory, downloads, cache, and artifacts. The default admission limit is 1 GiB. The merged overlay and base snapshot are not double-counted. Browser activity can exceed the limit after admission; this is not a filesystem-enforced quota.

The limits are configurable:

```toml
session_upload_max_file_bytes = 104857600
session_storage_quota_bytes = 1073741824
```

Successful uploads append a `session.file_uploaded` event containing the relative path, size, actor kind, and client IP. The event never contains the session token or host storage path.

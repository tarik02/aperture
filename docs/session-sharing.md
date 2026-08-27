# Session sharing

Aperture exposes separate editor and viewer capabilities for one browser session. Editor capabilities can request the session-wide input lease and use browser controls. Viewer capabilities can watch the session but cannot send browser input. Neither capability grants tenant access, files, recordings, DevTools, or session lifecycle operations.

## Share links

Owner-facing session responses expose independently rotatable editor and viewer capabilities under `collaboration`.

The web interface copies links in this form:

```text
https://aperture.example/share/#token=ape_<session-id>_<secret>
https://aperture.example/share/#token=apv_<session-id>_<secret>
```

The share route moves the token into tab-scoped session storage and removes it from the address bar. It uses the session ID embedded in the token to connect to the existing session routes. Opening a share link never adopts or falls back to account credentials already stored in the browser.

Rotating one collaboration capability invalidates new connections using that role without affecting the owner session token or the other collaboration role. Existing WebSockets remain connected until they close.

## Capability authentication

Session HTTP routes accept the token as a bearer credential:

```http
Authorization: Bearer ape_<session-id>_<secret>
Authorization: Bearer apv_<session-id>_<secret>
```

WebSocket routes use the existing bearer subprotocol:

```text
authorization.bearer.ape_<session-id>_<secret>
authorization.bearer.apv_<session-id>_<secret>
```

No tenant header is required. The token's embedded session ID must match the routed `/sessions/:sessionId/...` path. Suspended sessions wake through the same activity path used by direct CDP access.

Direct CDP discovery and WebSocket URLs use the capability in the existing path-token format. Collaboration CDP connections are filtered by role, and all `Input.*` methods are rejected:

```text
/sessions/<session-id>/cdp/<collaboration-capability>/
```

## Presence and follow

Each workbench connection appears in the participant list with a persistent local display name and Gravatar identicon. Account-backed owners use their account or token display name when it is available; shared links use a randomly assigned anonymous identity.

Selecting another participant starts following them. The follower adopts that participant's active tab and highlights their cursor. Follow relationships may form chains, but the session coordinator rejects any update that would create a cycle. Presence, cursors, and follow relationships disappear when the session ends and are not written into the browser or recordings.

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

File routes accept the owner session token or an account token with `sessions:write`. Editor and viewer capabilities cannot access files.

## Limits and audit events

The default per-file upload limit is 100 MiB. Before accepting an upload, Aperture measures writable session data under the overlay upper directory, downloads, cache, and artifacts. The default admission limit is 1 GiB. The merged overlay and base snapshot are not double-counted. Browser activity can exceed the limit after admission; this is not a filesystem-enforced quota.

The limits are configurable:

```toml
session_upload_max_file_bytes = 104857600
session_storage_quota_bytes = 1073741824
```

Successful uploads append a `session.file_uploaded` event containing the relative path, size, actor kind, and client IP. The event never contains the session token or host storage path.

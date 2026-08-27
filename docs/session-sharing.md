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

Rotating one collaboration capability disconnects session clients using that role without affecting the owner session token or the other collaboration role. A resume secret cannot bypass the rotated capability.

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

No tenant header is required. The token's embedded session ID must match the routed `/sessions/:sessionId/...` path. Suspended sessions wake through the normal live-session activity path. Editor and viewer capabilities never authorize raw CDP. Owner DevTools uses the owner session token separately.

## Presence and follow

Each workbench connection appears in the participant list with a persistent local display name and Gravatar identicon. Account-backed owners use their account or token display name when it is available; shared links use a randomly assigned anonymous identity.

Selecting another participant starts following them. The follower adopts that participant's selected browser target and highlights their cursor. Follow relationships may form chains, but the live session rejects any update that would create a cycle. Presence, cursors, and follow relationships disappear when the session ends and are not written into the browser or recordings.

## Shared drawing

Owners, editors, and viewers can turn on drawing mode and mark the current target. Drawing mode captures pointer gestures for the overlay instead of sending them to the browser. Each stroke uses target-relative coordinates, so it stays aligned when participants use different viewer sizes.

The live session relays strokes to connected participants but does not store them. A stroke fades out seven seconds after its last point. Shared drawing does not change page content and does not appear in browser recordings.

## Presentation modes

The workbench tries WebRTC first and falls back to JPEG frames over the live-session WebSocket when WebRTC is unavailable. Each session client can explicitly choose JPEG or switch back to WebRTC from the Stream menu. An explicit JPEG choice disables background WebRTC retries for that client until it selects WebRTC again.

The server advertises only encoder profiles supported by its media setup. These may include VP8, hardware H.264, hardware H.264 High, and software H.264. Owners and editors can select an advertised profile, use the low, balanced, or high preset, or set a custom frame rate and maximum bitrate. The encoder profile and quality are shared across WebRTC clients, so a change is broadcast to the live session. Viewers can choose JPEG or WebRTC for their own presentation but cannot change the shared encoder settings.

Remote cursor visibility is also shared presentation state. Owners and editors may change it; public HTTP and MCP cursor controls update the same state and broadcast the result to connected clients.

Changing to an incompatible profile first hands the requesting client to WebSocket, updates the shared encoder, and then negotiates a new WebRTC transport. Other WebRTC clients use the same fallback and recovery path. Both transports carry the same live-session protocol; JPEG delivery does not restore a frontend CDP connection.

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

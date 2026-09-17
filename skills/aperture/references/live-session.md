# Aperture live session

Routes under `$APERTURE_BASE_URL/sessions/:sessionId`, forwarded to the running session
wrapper. Authorize with an API bearer token (plus tenant header for system-admin
tokens) or the bound `sessionToken`.

- `GET /session` — live-session WebSocket; editor and viewer capabilities allowed
- `GET /browser/status` — `sessions:read`
- `POST /browser/viewport` — `sessions:write`
- `GET /webrtc/signal` — WebRTC signaling WebSocket; only when
  `capabilities.liveView.transports` contains `webrtc`
- `GET|POST /recordings`, `GET /recordings/:recordingId`,
  `POST /recordings/:recordingId/stop`, `GET /recordings/:recordingId/content` —
  all `sessions:write`

## Viewport

```json
{ "width": 1280, "height": 720, "deviceScaleFactor": 1 }
```

The response reports the logical size, DPR-scaled content rectangle, `64x64`-bucketed
media canvas, and effective scale.

## Session protocol

Interactive clients use the exact `aperture-session.v1` WebSocket subprotocol on both
`/session` and `/webrtc/signal`, with the bearer credential as a second subprotocol.

A new transport sends a reliable hello first:

```json
{ "type": "session.hello", "name": "Quiet Otter", "avatarHash": "0123456789abcdef0123456789abcdef" }
```

The server answers with `session.snapshot`, including `clientId` and `resumeSecret`. A
replacement transport sends those two values instead of `name` and `avatarHash`; resume
credentials expire five seconds after transport loss.

Commands carry a nonempty `requestId` and receive a matching typed `.result`:
`target.select`, `target.create`, `target.close`, `page.navigate`, `page.history-back`,
`page.history-forward`, `page.reload`, `page.stop-loading`, `viewport.set`,
`presentation.quality.set`, `presentation.cursor.set`, `recording.start`,
`recording.stop`, `recording.cancel`. A transport failure fails outstanding commands —
reconcile from the replacement snapshot and wait for a new caller action instead of
retrying.

### Transports

WebRTC clients create an ordered `application` channel, an unordered zero-retransmit
`application-realtime` channel, and a receive-only video transceiver. The reliable
channel carries the hello, snapshots, state, commands, results, non-motion input, and
stroke boundaries; the realtime channel carries pointer motion, cursor positions, and
intermediate stroke points, each with a positive transport-local `realtimeCounter`.

The `/session` WebSocket is the fallback and carries the same JSON messages. Its
presentation frames are binary packets: four-byte big-endian JSON-header length, the
UTF-8 `presentation.frame` header, then raw JPEG bytes. Coalesce disposable realtime
messages before writing them to this ordered socket.

### WebRTC signaling

```text
wss://aperture.example.com/sessions/:sessionId/webrtc/signal
```

Subprotocols: `aperture-session.v1`, `authorization.bearer.$SESSION_TOKEN` (or an
authorized API token), and `x-aperture-tenant-id.$TENANT_ID` for system-admin tokens.
Send a version 1 SDP `offer`, then exchange `ice-candidate` messages; the server returns
an `answer` or a typed signaling `error`. The authenticated role becomes the session
client's role. Capacity never evicts an existing peer — fall back to `/session` when the
peer cannot become usable within five seconds.

## Recording

Tab recording:

```json
{ "mode": "tab", "targetId": "TARGET_ID", "fps": 60, "bitrateKbps": 6000, "codec": "vp8" }
```

Viewer recording:

```json
{ "mode": "viewer", "targetId": "TARGET_ID", "clientId": "CLIENT_UUID" }
```

`targetId` must identify a ready browser target. A tab recording stays pinned to it; a
viewer recording follows the selected target of the connected `clientId` and stops after
that client's five-second recovery window expires. Pass `clientId` with a tab recording
to stop it when that client disconnects. Recordings may run concurrently up to
`capabilities.recording.concurrencyLimit`.

Codecs are `vp8` (WebM download) and `h264-va` (Matroska download). Omitted or
non-positive FPS and bitrate use instance defaults. Omit `path` to generate a file in
the session's `recordings` directory; a supplied path must be absolute and inside that
directory, and session tokens cannot override the generated path.

When `capabilities.recording.mechanism` is `cdp`, capture is page-scoped and video-only,
and the request may add `"cdp": { "format": "jpeg", "quality": 80 }` (quality 1–100
applies to JPEG only).

Start and status return `recordingId`, `mode`, `targetId`, `captureGeneration`,
`status` (`starting`, `running`, `stopped`, `failed`), `path`, `startedAt`, `fps`,
`bitrateKbps`, and `codec`; CDP jobs add their `cdp` controls plus `acceptedFrames` and
`droppedFrames`, and completed jobs may add `stopReason`, `stoppedAt`, and `sizeBytes`.

Stopping:

- `POST /sessions/:sessionId/recordings/:recordingId/stop` finalizes and serves the
  media attachment.
- `POST /api/sessions/:sessionId/recordings/:recordingId/stop` (`sessions:write`)
  finalizes without transferring media and returns the completed session file entry.
- Interactive workbenches stop through `aperture-session.v1`, then fetch `/content`
  rather than issuing a second stop.

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $APERTURE_TOKEN" \
  -o "recording-$RECORDING_ID.webm" \
  "$APERTURE_BASE_URL/sessions/$SESSION_ID/recordings/$RECORDING_ID/stop"
```

## CDP proxy

CDP uses `session.connection.sessionToken`, not the API bearer token, appended as the
next path segment after `session.connection.cdpUrl`:

```bash
curl -fsS "$CDP_URL/$SESSION_TOKEN/json/version"
curl -fsS "$CDP_URL/$SESSION_TOKEN/json/list"
```

Discovery responses rewrite WebSocket debugger URLs onto the same tokenized public path;
connect to them with no `Authorization` header and no subprotocol.

Rotate a leaked token with `POST /api/sessions/:sessionId/session-token/rotate` —
previously issued live-session URLs stop authorizing.

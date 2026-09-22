# Recordings

Apply the credential and tenant-selection rules from [authentication.md](authentication.md). For interactive recording commands, also read [live-session.md](live-session.md).

## Live-session HTTP routes

- `GET /sessions/:sessionId/recordings` — list recordings, `sessions:write`
- `POST /sessions/:sessionId/recordings` — start a recording, `sessions:write`
- `GET /sessions/:sessionId/recordings/:recordingId` — recording status, `sessions:write`
- `POST /sessions/:sessionId/recordings/:recordingId/stop` — stop and download, `sessions:write`
- `GET /sessions/:sessionId/recordings/:recordingId/content` — download a stopped recording, `sessions:write`

Tab recording body:

```json
{
  "mode": "tab",
  "targetId": "TARGET_ID",
  "fps": 60,
  "bitrateKbps": 6000,
  "codec": "vp8"
}
```

Viewer recording body:

```json
{
  "mode": "viewer",
  "targetId": "TARGET_ID",
  "clientId": "CLIENT_UUID"
}
```

`targetId` must identify a ready top-level target. A tab recording stays pinned to it. A viewer recording follows the selected target of the connected `clientId`; `clientId` is required for viewer mode. Pass `clientId` with a tab recording when it should also stop if that client disconnects. Multiple recordings may run concurrently.

Supported codecs are `vp8` and `h264-va`. Omitted or non-positive FPS and bitrate values use instance defaults. Omit `path` to generate a file in the session's `recordings` directory. A supplied path must be absolute and inside that directory; session tokens cannot override the generated path.

Start and status return `recordingId`, `mode`, `targetId`, `captureGeneration`, `status`, `path`, `startedAt`, `fps`, `bitrateKbps`, and `codec`. Completed jobs may also include `stopReason`, `stoppedAt`, and `sizeBytes`. Status is `starting`, `running`, `stopped`, or `failed`. The list route returns an array of these objects.

The live-session HTTP stop request finalizes the recording and serves the completed media attachment. Interactive clients start and stop through `aperture-session.v1`; after `recording.stop.result`, fetch `/content` to download without issuing a second stop.

## Formal API

These routes require `sessions:write`:

- `POST /api/sessions/:sessionId/recordings` — start a tab recording
- `GET /api/sessions/:sessionId/recordings` — list recordings
- `GET /api/sessions/:sessionId/recordings/:recordingId` — get recording status
- `POST /api/sessions/:sessionId/recordings/:recordingId/retarget` — move a running tab recording to another ready target
- `POST /api/sessions/:sessionId/recordings/:recordingId/stop` — stop and return the completed `SessionFile`

Public recording results use `relativePath`; absolute host paths are never returned. The formal stop route finalizes without media transfer and returns the completed session file with `name`, `relativePath`, `size`, `modifiedAt`, and `mimeType`.

## MCP

MCP exposes `recording.start`, `recording.list`, `recording.status`, `recording.retarget`, and `recording.stop`. MCP starts tab recordings only. Central tools take `sessionId` and tenant selection where required; session-bound tools bind the session from the URL. `recording.start` takes `targetId` and optional `fps`, `bitrateKbps`, and `codec`. Status and stop take `recordingId`; retarget takes both `recordingId` and the ready destination `targetId`.

## Lifecycle

Viewer recordings belong to a live session client and follow that client's selected top-level target. They stop after the client's five-second transport recovery window expires. HTTP and MCP callers start tab recordings because they have no session-client lifecycle.

Treat `targetId` as the opaque identifier of an Aperture top-level target. Retargeting keeps the same logical recording, output path, timeline, and settings. Aperture keeps recording the current target until the destination is ready. Sending the current target is idempotent. Viewer, stopped, and failed recordings cannot be explicitly retargeted.

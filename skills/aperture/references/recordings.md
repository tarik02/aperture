# Recordings

Apply the credential and tenant-selection rules from [authentication.md](authentication.md). For interactive recording commands, also read [live-session.md](live-session.md).

## Live-session HTTP routes

- `GET /sessions/:sessionId/recordings` — list recordings, `sessions:write`, `sessionToken`, or an editor capability
- `POST /sessions/:sessionId/recordings` — start a recording, `sessions:write`, `sessionToken`, or an editor capability
- `GET /sessions/:sessionId/recordings/:recordingId` — recording status, `sessions:write`, `sessionToken`, or an editor capability
- `POST /sessions/:sessionId/recordings/:recordingId/stop` — stop and download, `sessions:write`, `sessionToken`, or an editor capability
- `GET /sessions/:sessionId/recordings/:recordingId/content` — download a stopped recording, `sessions:write`, `sessionToken`, or an editor capability

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

`targetId` must identify a ready top-level target. A continuous tab recording stays pinned to it; a bursts recording follows the target on which browser automation ends. A viewer recording follows the selected target of the connected `clientId`; `clientId` is required for viewer mode. Pass `clientId` with a tab recording when it should also stop if that client disconnects. Multiple recordings may run concurrently.

Supported codecs are `vp8` and `h264-va`; `h264-va` is rejected up front where the host's GStreamer lacks its VA-API elements (`422`, or `recording_codec_unavailable` through the API). Omitted or non-positive FPS and bitrate values use instance defaults. Omit `path` to generate a file in the session's `recordings` directory. A supplied `path` is a session file path below `recordings/`, such as `recordings/demo/intro.webm`; missing directories are created. Session tokens cannot override the generated path.

Start and status return `recordingId`, `mode`, `targetId`, `captureGeneration`, `status`, `relativePath`, `sandboxPath`, `startedAt`, `fps`, `bitrateKbps`, and `codec`; host paths are never returned. `path` repeats `relativePath` for older clients and is deprecated. Completed jobs may also include `stopReason`, `stoppedAt`, and `sizeBytes`. When a recording fails, what it captured is kept as `…-failed` files next to its target and `relativePath` points at the first one. Status is `starting`, `running`, `stopped`, or `failed`. The list route returns an array of these objects.

The live-session HTTP stop request finalizes the recording and serves the completed media attachment. Interactive clients start and stop through `aperture-session.v1`; after `recording.stop.result`, fetch `/content` to download without issuing a second stop.

## Formal API

These routes require `sessions:write`:

- `POST /api/sessions/:sessionId/recordings` — start a tab recording
- `GET /api/sessions/:sessionId/recordings` — list recordings
- `GET /api/sessions/:sessionId/recordings/:recordingId` — get recording status
- `POST /api/sessions/:sessionId/recordings/:recordingId/retarget` — move a running tab recording to another ready target
- `POST /api/sessions/:sessionId/recordings/:recordingId/stop` — stop and return the completed `SessionFile`

Public recording results use `relativePath`; absolute host paths are never returned. The formal stop route finalizes without media transfer and returns the completed session file with `name`, `relativePath`, `size`, `modifiedAt`, and `mimeType`, plus `sandboxPath`.

## MCP

MCP exposes `recording.start`, `recording.list`, `recording.status`, `recording.retarget`, and `recording.stop`. MCP starts tab recordings only. Call `browser.targets` and select a target whose `state` is `ready` before starting or retargeting a recording. Central tools take `sessionId` and tenant selection where required; session-bound tools bind the session from the URL. `recording.start` takes `targetId`, optional `fps`, `bitrateKbps`, and `codec`, plus the recording configuration below. Status and stop take `recordingId`; retarget takes both `recordingId` and the ready destination `targetId`.

## Lifecycle

Viewer recordings belong to a live session client and follow that client's selected top-level target. They stop after the client's five-second transport recovery window expires. HTTP and MCP callers start tab recordings because they have no session-client lifecycle.

Treat `targetId` as the opaque identifier of an Aperture top-level target. Retargeting keeps the same logical recording, output path, timeline, and settings. Aperture keeps recording the current target until the destination is ready. Sending the current target is idempotent. Viewer, stopped, and failed recordings cannot be explicitly retargeted.

## Browser-driven recording

Any active recording enables a short visible automation cadence. Use `presentation: true` for slower pointer motion and presentation defaults. These settings affect browser MCP automation; manual live-session input stays immediate.

The same optional configuration is accepted by recording-start surfaces:

```json
{
  "capture": "bursts",
  "presentation": true,
  "ripple": true,
  "burst": { "leadMs": 150, "tailMs": 250, "settleMs": 200, "maxTailMs": 1200 }
}
```

`capture` defaults to `continuous`. Bursts capture continuously, follow automation, and retain action windows after capture. `burst` is accepted only with `capture: "bursts"`; its durations are integers from 0 to 60000 ms. Continuous recordings may use `idle: "cut"` or `idle: "speed"`. Bursts and idle editing are mutually exclusive and rejected together at start. Presentation defaults enable click ripples; `ripple: false` overrides that default.

Browser actions accept an optional `caption`. Pointer tools expose `motion`, `arrivalDwellMs`, and `holdMs` where applicable; explicit values override cadence defaults. `browser_scroll` uses wheel deltas and visible scrolling. Targets revealed by ordinary actions also scroll smoothly, including through nested frames.

Camera focus is explicit: call `browser_focus_viewport` with one active `recordingId`, a target or viewport rectangle, `zoom` from 1.1 to 4, and optional `durationMs` up to 10000. The call blocks for the interval and leaves the cursor in place. Use `browser_cursor_attention` with a target or point, `radius`, `loops`, and `durationMs` for cursor loops. Ordinary actions never add zoom.

Stop publishes the raw recording plus `capture.json`, `actions.ndjson`, `config.json`, the finalized `timeline.json`, and an H.264 MP4 when editing applies. Read `captureRelativePath`, `actionsRelativePath`, `configRelativePath`, `timelineRelativePath`, and `editedRelativePath` from status or MCP stop; use session-file operations to download them. A failed finalizer preserves raw capture and available sources; check `finalizeError` and `warnings`. Files become visible only after finalization, and publication never overwrites an existing session file.

Each connected owner/editor may request `presentation.automation.set { pacing: "normal" | "watchable" }` independently of the input lease. The workbench's **Watchable automation** toggle defaults on. Any watchable editor enables recorded cadence; any presentation recording enables presentation cadence. Pacing disappears when its transport disconnects and is not snapshot state. Viewers cannot control it.

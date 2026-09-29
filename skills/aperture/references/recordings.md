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
  "codec": "vp8",
  "idle": "speed",
  "zoom": true,
  "ripple": true
}
```

`idle`, `zoom`, and `ripple` are optional defaults for the [effects](#effects) rendered when the recording is stopped.

Viewer recording body:

```json
{
  "mode": "viewer",
  "targetId": "TARGET_ID",
  "clientId": "CLIENT_UUID"
}
```

`targetId` must identify a ready top-level target. A tab recording stays pinned to it. A viewer recording follows the selected target of the connected `clientId`; `clientId` is required for viewer mode. Pass `clientId` with a tab recording when it should also stop if that client disconnects. Multiple recordings may run concurrently.

Supported codecs are `vp8` and `h264-va`; `h264-va` is rejected up front where the host's GStreamer lacks its VA-API elements (`422`, or `recording_codec_unavailable` through the API). Omitted or non-positive FPS and bitrate values use instance defaults. Omit `path` to generate a file in the session's `recordings` directory. A supplied `path` is a session file path below `recordings/`, such as `recordings/demo/intro.webm`; missing directories are created. Session tokens cannot override the generated path.

Start and status return `recordingId`, `mode`, `targetId`, `captureGeneration`, `status`, `relativePath`, `sandboxPath`, `startedAt`, `fps`, `bitrateKbps`, and `codec`; host paths are never returned. `path` repeats `relativePath` for older clients and is deprecated. Completed jobs may also include `stopReason`, `stoppedAt`, `sizeBytes`, `timelineRelativePath`, and, after a stop that rendered [effects](#effects), `editedRelativePath`, `editError`, and `editWarnings`. When a recording fails, what it captured is kept as `…-failed` files next to its target and `relativePath` points at the first one. Status is `starting`, `running`, `stopped`, or `failed`. The list route returns an array of these objects.

The live-session HTTP stop request finalizes the recording and serves the completed media attachment. Interactive clients start and stop through `aperture-session.v1`; after `recording.stop.result`, fetch `/content` to download without issuing a second stop.

## Formal API

These routes require `sessions:write`:

- `POST /api/sessions/:sessionId/recordings` — start a tab recording
- `GET /api/sessions/:sessionId/recordings` — list recordings
- `GET /api/sessions/:sessionId/recordings/:recordingId` — get recording status
- `POST /api/sessions/:sessionId/recordings/:recordingId/retarget` — move a running tab recording to another ready target
- `POST /api/sessions/:sessionId/recordings/:recordingId/stop` — stop and return the completed `SessionFile`

Public recording results use `relativePath`; absolute host paths are never returned. The formal stop route finalizes without media transfer and returns the completed session file with `name`, `relativePath`, `size`, `modifiedAt`, and `mimeType`, plus `sandboxPath` and, when effects were rendered, `editedRelativePath`, `editError`, and `editWarnings`.

## MCP

MCP exposes `recording.start`, `recording.list`, `recording.status`, `recording.retarget`, and `recording.stop`. MCP starts tab recordings only. Call `browser.targets` and select a target whose `state` is `ready` before starting or retargeting a recording. Central tools take `sessionId` and tenant selection where required; session-bound tools bind the session from the URL. `recording.start` takes `targetId` and optional `fps`, `bitrateKbps`, `codec`, `idle`, `zoom`, and `ripple`. Status and stop take `recordingId`; retarget takes both `recordingId` and the ready destination `targetId`.

## Timeline

A recording that stops normally gets a **recording timeline** next to its video: `demo.webm` gets `demo.webm.timeline.json` (numbered like the video when the name is taken), reported as `timelineRelativePath` once the recording is `stopped`. It is not written for failed recordings or when a capture produced no frames, and the video does not depend on it. It describes what the Playwright browser tools did while the recording ran; actions taken in other ways (the workbench, raw CDP) are not in it.

All times are milliseconds of video time, counted across target changes; coordinates are pixels of the video frame.

- `durationMs`, `segments[]` — the video's length and one entry per capture (`targetId`, `start`, `end`, `width`, `height`); retargeting starts a new segment.
- `actions[]` — every tool call that changes something: `tool`, `targetId`, `start`, `end`, `ok`, and the `caption` given to the tool. A target other than the recorded one can appear here.
- `gestures[]` — pointer tools only: `tool`, `targetId`, `start`, `end`, `hold`, the pointer `path` as `[ms, x, y]`, `clicks[]` (`t`, `x`, `y`, `button`, `count`), and for scrolls `scroll` (`t`, `deltaX`, `deltaY`, and the point scrolled at). Path, clicks and scroll exist only for pointer moves made in the compositor; a gesture made without a compositor surface (the page's own mouse was used) keeps only its timing. A gesture on a target the recording was not showing at that moment is left out.
- `activity` — `spans[]` (`start`, `end`) in which the recorded page's content changed, sampled 20 times a second. A static page stays idle however the pointer moves; the spans cover new buffer content, not repaints. When `complete` is `false`, some sample failed, so do not read gaps between spans as idle.

Each list is truncated at a fixed size (2000 actions, 1000 gestures, 5000 activity spans, 600 path points per gesture, 100000 in all).

## Effects

A recording made while an agent works can be rendered with effects when it is stopped through the API or MCP (`recording.stop`). The stop request blocks while ffmpeg renders, which takes roughly a fraction of the recording's length to a few times it, and then returns `editedRelativePath`, the session file `<video>.edited.mp4` (H.264, numbered like the video when the name is taken). The raw video and its timeline are always kept and unchanged. A render that fails never fails the stop: the recording is returned with `editError` (for example frames that changed size, which effects cannot follow) and no edited video. `editWarnings` lists what was left out. A stop by the live session protocol, or by the recording ending (target closed, session closed, client disconnected), does not render.

Effects apply only when something asks for them:

- **Captions** — the `caption` given to any tool that changes something is burned in as text near the bottom edge while the step runs, for at least a second and long enough to read.
- **Zoom** — `zoom` on `browser_click`, `browser_drag`, `browser_scroll`, and `browser_move` (`true`, a level from 1.1 to 4, or `false`) eases the view toward where the pointer works, follows it as it moves, and eases back out. `true` is 1.6. Gestures close in time share one zoom. Gestures made without a compositor have no position and are not followed.
- **Ripple** — `ripple` on `browser_click` draws a ring spreading from the click point.
- **Idle** — `idle` on `recording.start` cuts (`cut`) or plays 8x faster (`speed`) stretches of 1.5 seconds or more in which the screen does not change and nothing is done or captioned. Idle is left as it is when the timeline could not watch the screen the whole time or ran into its size limits, and this is reported in `editWarnings`.

`zoom` and `ripple` on `recording.start` are the defaults for gestures that do not say otherwise; a gesture's own `false` overrides them. Each gesture's setting is kept as given in the timeline's `gestures[]` (`zoom`, `ripple`). Effects that need ffmpeg are rejected when a recording starts on a host without it (`422`, or `recording_codec_unavailable` through the API); a host with the packaged ffmpeg needs no setup, and other hosts set `recording_ffmpeg_executable`.

## Lifecycle

Viewer recordings belong to a live session client and follow that client's selected top-level target. They stop after the client's five-second transport recovery window expires. HTTP and MCP callers start tab recordings because they have no session-client lifecycle.

Treat `targetId` as the opaque identifier of an Aperture top-level target. Retargeting keeps the same logical recording, output path, timeline, and settings. Aperture keeps recording the current target until the destination is ready. Sending the current target is idempotent. Viewer, stopped, and failed recordings cannot be explicitly retargeted.

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

`targetId` must identify a ready top-level target. A tab recording stays pinned to it. A viewer recording follows the selected target of the connected `clientId`; `clientId` is required for viewer mode. Pass `clientId` with a tab recording when it should also stop if that client disconnects. Multiple recordings may run concurrently.

Optional edit settings, accepted by the start route and by `recording.start` (see [Editing a recording](#editing-a-recording)): `capture` (`continuous` or `bursts`), `presentation`, `idle` (`cut` or `speed`), `ripple`, and `burst`.

Supported codecs are `vp8` and `h264-va`; `h264-va` is rejected up front where the host's GStreamer lacks its VA-API elements (`422`, or `recording_codec_unavailable` through the API). Omitted or non-positive FPS and bitrate values use instance defaults. Omit `path` to generate a file in the session's `recordings` directory. A supplied `path` is a session file path below `recordings/`, such as `recordings/demo/intro.webm`; missing directories are created. Session tokens cannot override the generated path.

Start and status return `recordingId`, `mode`, `targetId`, `captureGeneration`, `status`, `relativePath`, `sandboxPath`, `startedAt`, `fps`, `bitrateKbps`, and `codec`; host paths are never returned. `path` repeats `relativePath` for older clients and is deprecated. Completed jobs may also include `stopReason`, `stoppedAt`, `sizeBytes`, and, after an edit, `editedRelativePath`, `timelineRelativePath` and `editError`. When a recording fails, what it captured is kept as `…-failed` files next to its target and `relativePath` points at the first one. Status is `starting`, `running`, `stopped`, or `failed`. The list route returns an array of these objects.

Stopping blocks until the edit is done (see below). The live-session HTTP stop request finalizes the recording and serves the completed media attachment. Interactive clients start and stop through `aperture-session.v1`; after `recording.stop.result`, fetch `/content` to download without issuing a second stop.

## Formal API

These routes require `sessions:write`:

- `POST /api/sessions/:sessionId/recordings` — start a tab recording
- `GET /api/sessions/:sessionId/recordings` — list recordings
- `GET /api/sessions/:sessionId/recordings/:recordingId` — get recording status
- `POST /api/sessions/:sessionId/recordings/:recordingId/retarget` — move a running tab recording to another ready target
- `POST /api/sessions/:sessionId/recordings/:recordingId/stop` — stop and return the completed `SessionFile` of the raw video, with `editedRelativePath`, `timelineRelativePath` and `editError` when the stop made them

Public recording results use `relativePath`; absolute host paths are never returned. The formal stop route finalizes without media transfer and returns the completed session file with `name`, `relativePath`, `size`, `modifiedAt`, and `mimeType`, plus `sandboxPath`.

## MCP

MCP exposes `recording.start`, `recording.list`, `recording.status`, `recording.retarget`, and `recording.stop`. MCP starts tab recordings only. Call `browser.targets` and select a target whose `state` is `ready` before starting or retargeting a recording. Central tools take `sessionId` and tenant selection where required; session-bound tools bind the session from the URL. `recording.start` takes `targetId` and optional `fps`, `bitrateKbps`, `codec`, and the edit settings. `recording.stop` returns the recording with its edit. Status and stop take `recordingId`; retarget takes both `recordingId` and the ready destination `targetId`.

## Lifecycle

Viewer recordings belong to a live session client and follow that client's selected top-level target. They stop after the client's five-second transport recovery window expires. HTTP and MCP callers start tab recordings because they have no session-client lifecycle.

Treat `targetId` as the opaque identifier of an Aperture top-level target. Retargeting keeps the same logical recording, output path, timeline, and settings. Aperture keeps recording the current target until the destination is ready. Sending the current target is idempotent. Viewer, stopped, and failed recordings cannot be explicitly retargeted.

## Annotating a running recording

While a recording runs, Aperture journals the browser automation of its session for later editing: the pointer's travel, presses and wheel input, smooth reveal scrolls, and a span for each browser tool call that is not read-only. Automation runs at recorded pace while a recording runs (see the cadence in the live-session reference).

`recording.caption`, `recording.focus` and `recording.attention` add explicit annotations. They act on the recording named by `recordingId`, or on the only running recording; they fail when none is running, or when several are and no `recordingId` is given. Coordinates are CSS pixels of the recorded tab's viewport, and a `selector` is resolved in its top-level document.

- `recording.caption` takes `text` (1 to 200 characters) and optional `durationMs` (default 3000) and returns at once.
- `recording.focus` takes a `rect` or a `selector`, a `zoom` above 1 and up to 4, and optional `durationMs` (200 to 10000, default 2000). It blocks for the duration, and no browser tool runs meanwhile.
- `recording.attention` takes a `point` or a `selector` and optional `radius` (default 40), `loops` (default 2) and `durationMs` (default 1200). It circles the real pointer around the place and blocks for the duration. It needs a compositor session and the session's input to be free.

Starting or stopping a recording waits for a browser call that is running, and a start returns once the capture's first frame exists, so no automation happens before the video begins.

## Editing a recording

Stopping a recording publishes its raw video next to a timeline, `<name>.timeline.json`, when the recording journaled anything, and, when something is to be applied, an H.264 video, `<name>.edited.mp4`. Names are numbered like the raw video's when they exist; nothing is overwritten. The stop returns only after the edit is done, which takes about as long as the recording (at most 30 minutes). Clients should allow for that. Only a requested stop edits; a recording that stops because its tab closed, its client left or the session ended keeps its raw video alone, with no `editError`. A second stop while one is finalizing waits for the same result. Closing the session ends a running edit with `editError` `cancelled`; the raw video stays.

Edit settings on `recording.start`:

- `capture`: `continuous` (default) or `bursts`. With `bursts` the edited video keeps only the stretches around browser tool calls that are not read-only, and the recording follows the tab the automation acts on. A stretch runs from `burst.leadMs` before the call (default 500) to `burst.tailMs` after it (800), longer until the screen has stood still for `burst.settleMs` (400) but at most `burst.maxTailMs` (3000) after the call. Overlapping stretches merge. Explicit `recording.focus` and `recording.attention` are kept too. Zero or missing burst fields take the defaults.
- `idle`: `cut` or `speed` (8 times faster) for the stretches of a continuous recording in which neither the screen nor the automation changes. A little padding stays around everything that happens. `idle` is rejected with `bursts`, and so is `burst` without them.
- `ripple`: mark each click with a ripple.
- `presentation`: run automation at presentation pace while recording.

Captions from `recording.caption` are burned in, and each `recording.focus` zooms inside its window only; focus windows less than half a second apart stay zoomed in between and pan. There is no automatic zoom. A recording with none of these settings or annotations is not edited. Frames of a later segment of a recording that changed size are scaled to the first segment's size.

The raw video is always published. If the edit fails the stop still succeeds and the recording has `editError` with a `code` (`ffmpeg_unavailable`, `open_failed`, `nothing_kept`, `analysis_failed`, `plan_failed`, `render_failed`, `timeout`, `cancelled` or `timeline_failed`; `nothing_kept` is a bursts recording with no browser call to keep) and a `message`. The timeline holds `segments`, the `map` from raw to edited time when an edit exists, and `events`: the journal's tool calls, pointer glides, presses, wheel input, reveal scrolls, captions, focus and attention, with `startMs` and `endMs` in raw video milliseconds and `editedStartMs` and `editedEndMs` in the edited video's.

Edits need ffmpeg with libx264, libass and fontconfig fonts; the Nix image ships it and sets `recording_ffmpeg_executable` (`--recording-ffmpeg-executable`) to an absolute path. Without it recordings still work and report `ffmpeg_unavailable`.

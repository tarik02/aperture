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
  "presentation": true
}
```

`presentation: true` supplies presentation defaults for omitted settings: bursts capture and click ripples. Camera focus is always an explicit, recording-scoped `browser_focus_viewport` action. Explicit `capture`, `burst`, and `ripple` values override defaults independently. `idle`, focus, and `ripple` affect the [edited recording](#effects). `capture: "bursts"` keeps only the time around successful agent actions; see [Bursts](#bursts).

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

The live-session HTTP stop request finalizes the recording and serves the completed media attachment; it does not render effects. Interactive clients start and stop through `aperture-session.v1`; after `recording.stop.result`, fetch `/content` to download without issuing a second stop.

## Formal API

These routes require `sessions:write`:

- `POST /api/sessions/:sessionId/recordings` — start a tab recording
- `GET /api/sessions/:sessionId/recordings` — list recordings
- `GET /api/sessions/:sessionId/recordings/:recordingId` — get recording status
- `POST /api/sessions/:sessionId/recordings/:recordingId/retarget` — move a running tab recording to another ready target
- `POST /api/sessions/:sessionId/recordings/:recordingId/stop` — stop and return the completed `SessionFile`

Public recording results use `relativePath`; absolute host paths are never returned. The formal stop route finalizes without media transfer and returns the completed session file with `name`, `relativePath`, `size`, `modifiedAt`, and `mimeType`, plus `sandboxPath` and, when effects were rendered, `editedRelativePath`, `editError`, and `editWarnings`.

## MCP

MCP exposes `recording.start`, `recording.list`, `recording.status`, `recording.retarget`, and `recording.stop`. MCP starts tab recordings only. Call `browser.targets` and select a target whose `state` is `ready` before starting or retargeting a recording. Central tools take `sessionId` and tenant selection where required; session-bound tools bind the session from the URL. `recording.start` takes `targetId` and optional `fps`, `bitrateKbps`, `codec`, `presentation`, `idle`, `ripple`, `capture`, and `burst`. Status and stop take `recordingId`; retarget takes both `recordingId` and the ready destination `targetId`.

## Recorded browser interaction

Browser tools use immediate pointer movement and target scrolling when no recording runs. While any recording runs, omitted pointer timing uses a compact recorded tempo and every locator-driven action smoothly scrolls its target into view before acting; while any `presentation: true` recording runs, it uses the stronger presentation tempo. `browser_scroll` also animates its wheel delta under the active recording tempo. The live session resolves one tempo for its shared physical pointer, so recordings with different capture and effect settings can coexist. Explicit `motion`, `arrivalDwellMs`, and `holdMs` values on a browser tool still win.

`browser_click` is the complete focal gesture: it moves to the destination, briefly rests there under the active tempo, then presses and releases. Use `browser_move` only when hover is the action. Use `browser_cursor_attention` to point out passive evidence; its omitted loop duration is 1200 ms for an ordinary recording and 1800 ms for a presentation recording. A stop admits no new browser actions, waits for actions that began while the recording was active, then finalizes the recording timeline.

## Timeline

A recording that stops normally gets a **recording timeline** next to its video: `demo.webm` gets `demo.webm.timeline.json` (numbered like the video when the name is taken), reported as `timelineRelativePath` once the recording is `stopped`. It is not written for failed recordings or when a capture produced no frames, and the video does not depend on it. It describes what the Playwright browser tools did while the recording ran; actions taken in other ways (the workbench, raw CDP) are not in it.

All times are milliseconds of video time, counted across target changes; coordinates are pixels of the video frame.

- `durationMs`, `segments[]` — the video's length and one entry per capture (`targetId`, `start`, `end`, `width`, `height`); retargeting starts a new segment.
- `actions[]` — every tool call that changes something: `tool`, `targetId` (the tab the call ended on), `start`, `end`, `ok`, and the `caption` given to the tool. A target other than the recorded one can appear here.
- `gestures[]` — pointer tools only: `tool`, `targetId`, `start`, `end`, `hold`, the pointer `path` as `[ms, x, y]`, `clicks[]` (`t`, `x`, `y`, `button`, `count`), and for scrolls `scroll` (`t`, `deltaX`, `deltaY`, and the point scrolled at). Path, clicks and scroll exist only for pointer moves made in the compositor; a gesture made without a compositor surface (the page's own mouse was used) keeps only its timing. A gesture on a target the recording was not showing at that moment is left out.
- `focuses[]` — explicit focus calls for this recording: `targetId`, `start`, `end`, viewport rectangle (`x`, `y`, `width`, `height`) converted to video pixels, and `zoom`.
- `activity` — `spans[]` (`start`, `end`) in which the recorded page's content changed, sampled 20 times a second. A static page stays idle however the pointer moves; the spans cover new buffer content, not repaints. When `complete` is `false`, some sample failed, so do not read gaps between spans as idle.

Each list is truncated at a fixed size (2000 actions, 1000 gestures, 5000 activity spans, 600 path points and 20 clicks per gesture, 100000 path points in all).

## Effects

A recording made while an agent works can be rendered with effects when it is stopped, but only by the API or MCP stop (`recording.stop`); the live-session HTTP stop, the live session protocol, and the recording ending (target closed, session closed, client disconnected) never render. The stop request blocks while ffmpeg renders, which takes roughly a fraction of the recording's length to a few times it, and then returns `editedRelativePath`, the session file `<video>.edited.mp4` (H.264, numbered like the video when the name is taken). The raw video and its timeline are always kept and unchanged. A render that fails never fails the stop: the recording is returned with `editError` (for example frames that changed size, which effects cannot follow) and no edited video. `editWarnings` lists what was left out. `editWarnings` also reports effects dropped because a very long recording had too many of them, ripples first, then focus scenes, then idle, and never captions. A render that is still running when the session closes is cancelled. An MCP client that gives up waiting for `recording.stop` can read `editedRelativePath` or `editError` from `recording.status` once the render ends.

Effects apply only when something asks for them:

- **Captions** — the `caption` given to any tool that changes something is burned in as text near the bottom edge while the step runs, for at least a second and long enough to read.
- **Focus** — `browser_focus_viewport` targets one active `recordingId` and one element or viewport rectangle, with a `zoom` level from 1.1 to 4. `durationMs` (default 2200) includes easing in, a stable hold, and easing out. It schedules the interval and returns so a following action can happen inside it; recording stop waits for the interval to finish. It is camera-only; `browser_cursor_attention` is the separate physical pointer gesture. Ordinary gestures never move the camera.
- **Ripple** — `ripple` on `browser_click` draws a ring spreading from the click point.
- **Idle** — `idle` on `recording.start` cuts (`cut`) or plays 8x faster (`speed`) stretches of 1.5 seconds or more in which the screen does not change and nothing is done or captioned. Idle is left as it is when the timeline could not watch the screen the whole time or ran into its size limits, and this is reported in `editWarnings`.

`ripple` on `recording.start` is the default for clicks that do not say otherwise; a click's own `false` overrides it. Its setting is kept in the timeline gesture. Effects set on `recording.start` are rejected on a host without ffmpeg (`422 recording_effects_unavailable` through the API); an explicit focus, per-action ripple, or caption there is only found out at the stop and is reported as `editError`. A host with the packaged ffmpeg needs no setup, and other hosts set `recording_ffmpeg_executable`.

## Bursts

`capture: "bursts"` on `recording.start` (tab recordings only) records continuously, but the video that matters is the edited one: when the recording is stopped through the API or MCP, everything except the time around each successful browser tool call that changes something is cut. Failed calls remain in the raw timeline, are omitted from captions and burst timing, and produce an `editWarnings` entry. Nothing starts or stops per action. The raw video and timeline are kept, and focus, ripples, and captions render in the same edited video. `idle` cannot be combined with bursts, and with no successful calls there is no edited video and `editError` says why.

Around each call the video keeps `leadMs` before it starts (default 150) and a tail after it ends: `tailMs` (250), extended until the screen has been still for `settleMs` (200) but no longer than `maxTailMs` after the call ends (1200, or `tailMs` if more). Any of them may be 0. If the timeline could not watch the screen the whole time, the tail is just `tailMs`. Stretches that overlap merge, and near ones merge too if there are too many to render (a warning says so). The timeline keeps at most 2000 actions; beyond that, later calls are not kept and a warning says so.

A bursts recording follows the page the agent works on: when a call ends on another ready tab, the recording moves to that tab, as `retarget` does. Closing the recorded tab does not stop it; it waits for the call that ends on another tab. Tabs of a different size than the first cannot be rendered (see [Effects](#effects)).

## Lifecycle

Viewer recordings belong to a live session client and follow that client's selected top-level target. They stop after the client's five-second transport recovery window expires. HTTP and MCP callers start tab recordings because they have no session-client lifecycle.

Treat `targetId` as the opaque identifier of an Aperture top-level target. Retargeting keeps the same logical recording, output path, timeline, and settings. Aperture keeps recording the current target until the destination is ready. Sending the current target is idempotent. Viewer, stopped, and failed recordings cannot be explicitly retargeted.

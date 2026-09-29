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

Bursts recording body (see [Bursts recordings](#bursts-recordings)):

```json
{
  "mode": "tab",
  "targetId": "TARGET_ID",
  "capture": "bursts",
  "motion": { "durationMs": 600 },
  "burst": { "leadMs": 400, "tailMs": 600, "settleMs": 500, "maxTailMs": 4000 }
}
```

A tab recording can also carry the defaults of the effects applied to its edited video when it stops: `"idle": "speed"` or `"cut"`, `"ripple": true`, and `"zoom": true` or a magnification from 1.1 to 4 (see [Edited video](#edited-video)). They are off when omitted, and a host without ffmpeg rejects them up front (`501` from the wrapper, `422` and `recording_edit_unavailable` through the API).

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

`capture` is `continuous` (the default) or `bursts`. `motion` sets the recording's pointer motion (`"natural"`, `"fast"`, `"instant"`, `{"speed": px/s}` or `{"durationMs": ms}`): a gesture made while the recording runs uses it when the tool gave none, before the session's setting (`cursor.set`). With several running recordings of the page, the newest one's motion counts. `burst` is valid only with `capture` `bursts`.

Start and status return `recordingId`, `mode`, `capture`, `motion` (when set), `burst` (bursts recordings), `targetId`, `captureGeneration`, `status`, `relativePath`, `sandboxPath`, `startedAt`, `fps`, `bitrateKbps`, and `codec`; host paths are never returned. `path` repeats `relativePath` for older clients and is deprecated. Completed jobs may also include `stopReason`, `stoppedAt`, `sizeBytes`, `timelineRelativePath` (see [Timeline](#timeline)), and, when the recording was edited when it stopped, `editedRelativePath`, `editError`, and `editWarnings` (see [Edited video](#edited-video)). When a recording fails, what it captured is kept as `…-failed` files next to its target and `relativePath` points at the first one; each kept file has a timeline of its own. Status is `starting`, `running`, `stopped`, or `failed`. The list route returns an array of these objects.

The live-session HTTP stop request finalizes the recording and serves the completed media attachment, after rendering its edited video if it has effects to apply (it does not return before that is done). Interactive clients start and stop through `aperture-session.v1`; after `recording.stop.result`, fetch `/content` to download without issuing a second stop.

## Formal API

These routes require `sessions:write`:

- `POST /api/sessions/:sessionId/recordings` — start a tab recording, optionally with `idle`, `ripple`, and `zoom` defaults for the edited video
- `GET /api/sessions/:sessionId/recordings` — list recordings
- `GET /api/sessions/:sessionId/recordings/:recordingId` — get recording status
- `POST /api/sessions/:sessionId/recordings/:recordingId/retarget` — move a running tab recording to another ready target
- `POST /api/sessions/:sessionId/recordings/:recordingId/stop` — stop and return the completed video as a `RecordingFile`

Public recording results use `relativePath`; absolute host paths are never returned. The formal stop route finalizes without media transfer and returns the completed session file with `name`, `relativePath`, `size`, `modifiedAt`, and `mimeType`, plus `sandboxPath`, `timelineRelativePath`, and `editedRelativePath`, `editError`, and `editWarnings` as in the [Edited video](#edited-video) section. When the recording has effects to apply, the stop request waits for the edited video to be rendered, which takes from seconds to a minute or two.

## MCP

MCP exposes `recording.start`, `recording.list`, `recording.status`, `recording.retarget`, and `recording.stop`. MCP starts tab recordings only. Call `browser.targets` and select a target whose `state` is `ready` before starting or retargeting a recording. Central tools take `sessionId` and tenant selection where required; session-bound tools bind the session from the URL. `recording.start` takes `targetId` and optional `fps`, `bitrateKbps`, `codec`, `capture`, `motion`, `burst`, and the effect defaults `idle`, `ripple`, and `zoom`. Its output carries `capture`, `motion`, and `burst` like the REST status. Status and stop take `recordingId`; retarget takes both `recordingId` and the ready destination `targetId`. Every recording output carries `timelineRelativePath` once the recording has stopped, so `recording.stop` returns the paths of the video (`relativePath`) and of its timeline, and of the edited video (`editedRelativePath`) when there is one. `recording.stop` waits for the edited video to be rendered, so give the call minutes rather than seconds when the recording has effects.

## Bursts recordings

A recording made with `"capture": "bursts"` records video only around browser actions instead of the whole time it runs, so the video of an agent's session holds what happened and none of the waiting between. The recording is `running` from the start but has no capture pipeline until an action opens a burst. Each burst is its own segment; stopping the recording joins them into one video.

- **What opens a burst.** Calls to Aperture's browser tools that can change the page, while the recording is running: the pointer tools (`browser_click`, `browser_move`, `browser_drag`, `browser_scroll`), `browser_navigate`, `browser_navigate_back`, `browser_type`, `browser_press_key`, `browser_select_option`, `browser_fill_form`, `browser_file_upload`, `browser_handle_dialog`, `browser_drop`, `browser_resize`, `browser_emulate_media`, `browser_evaluate` (it can change anything, so it always counts), `browser_tabs` except `list`, and `browser_wait_for` with `text` or `textGone` (waiting for the page to change; it is bounded by the tool's own timeout). The same tools take a `caption` for the edited video (see [Edited video](#edited-video)). Reading calls (`browser_snapshot`, `browser_find`, `browser_take_screenshot`, console and network reads), cookie, storage and route tools, and `browser_wait_for` with only `time` open nothing. A wait for time only holds a burst that is already open open for as long as it lasts. Only calls made through the browser tools count; a person acting in the live session opens no burst, and neither do Aperture's own internal reads.
- **Lead.** A pointer tool's burst starts `leadMs` (default 400) before the gesture, so the video shows the page before the pointer moves; the tool waits for that lead before it acts. Other actions have no lead, but every burst waits for its first frame, so the action's first frames are in the video.
- **Tail.** After the last action of a burst ends, the burst goes on for at least `tailMs` (default 600; a pointer tool's `holdMs` counts too, and a failed action has no tail), then until the screen has stayed unchanged for `settleMs` (default 500), and at most `maxTailMs` (default 4000) after the action ended, however long the screen keeps changing (a looping animation or a playing video never settles, so its bursts end at `maxTailMs`). A `holdMs` longer than `maxTailMs` still wins: the hold is the caller's explicit request. `maxTailMs` must not be less than `tailMs`. Ranges: `leadMs` 0 to 10000, `tailMs` 0 to 30000, `settleMs` 0 to 30000, `maxTailMs` 0 to 30000.
- **Actions in a burst.** An action that starts while a burst is open, including during its tail, joins it: one burst, one segment, no new lead. An action that arrives while a burst is closing waits for the close and then opens a new burst; measured on a software-rendered session, the close (SIGINT, the pipeline finishing its file, the timeline's flush) delays such an action by at most about 15 ms on top of the new burst's own latency, so nothing is done to avoid it. An action on a page that was just opened (`browser_tabs` `new`, then `browser_navigate` or a click) waits up to 1.5 s for that page to be ready, since the page registry syncs about every 500 ms, instead of running unrecorded. After `browser_tabs` the burst moves to the tab the tool left the automation on in the background: the tool call returns at once, the burst does not close until the move is done, and the next action waits for it.
- **Latency.** The tool call returns when its action is done; the tail runs on in the background. Measured on a software-rendered session: an action that opens a burst is delayed by the capture pipeline's first frame (about 110 ms), and a pointer tool by `leadMs` more, so a click that took 270 ms takes about 790 ms; an action inside a burst is not delayed. `browser_wait_for` and `browser_evaluate` are delayed by the first frame only. When the browser has several pages, telling which one Playwright controls costs one `browser_evaluate` (about 0.5 s) per action, whether or not a recording exists; the pointer tools reuse that answer, and a burst's tail is held open while an action is still finding its page, so quick actions on a multi-tab session still make one burst. A pipeline that gets no first frame because the page's capture was replaced while it started is dropped and started again once, instead of costing the action its recording. If a burst cannot be opened (its page is not ready or its pipeline fails), the action runs anyway, `burst.skipped` counts it and `burst.lastError` says why; three capture failures in a row fail the recording (`stopReason` `pipeline_failed`, with what it captured kept).
- **Which page.** A bursts recording records the page the automation acts on: each burst records the page Playwright controls when the action starts (`browser_tabs` moves the burst to the tab it leaves the automation on). `targetId` in its status is the page of the latest burst, or the page it falls back to when that page cannot be identified. `recording.retarget` only changes that fallback, and is refused (`409`) while a burst is in progress or the recording is stopping. Closing the recorded page ends its burst but not the recording, and is not counted as a capture failure. When the page's viewport size or scale changes during a burst, the burst carries on in a new segment of the new size. Aperture does not follow a page that a click opens as a popup; the next action opens a burst on it.
- **Stopping.** Stopping waits for the actions that are still running to end (at most 30 s), then lets the burst finish its tail, so the result of the last action is in the video; a session or runtime that shuts down closes bursts at once. `stop` therefore blocks for up to the running actions' remaining time plus `maxTailMs` (or a pointer tool's `holdMs`, if longer) after the last one, at most about 30 s plus `maxTailMs`; a longer `maxTailMs` is not allowed so that a stop stays under common tool-call timeouts. Stopping a bursts recording in which no burst was recorded (no action ran, or every burst was skipped or lost; the error says which, with `burst.lastError`) fails it: `status` `failed`, `stopReason` `no_bursts`, no video and no timeline (the stop route answers `409`, MCP `recording_unavailable`). A session that closes ends running bursts at once.
- **Status.** `burst` reports the timing in force and `state` (`idle` between bursts, `burst` while one is opening, running, settling or closing), `count` (bursts recorded, including a running one), `capped` (bursts cut off by `maxTailMs`) and `skipped` (actions that ran unrecorded, and bursts whose video was lost). A running bursts recording keeps the session from suspending, like any running recording, and counts against the recording capacity.
- **Limits.** A recording keeps at most 200 segments (one per burst, more when a burst carries on in a new segment); beyond that actions run unrecorded and count as `skipped`, without failing the recording. The limit keeps the join at stop cheap: joining 200 one-second segments took 0.6 s and 400 took 1.9 s in a measurement, growing faster than linearly. Bursts recordings are tab recordings: `mode` `viewer` with `capture` `bursts` is rejected.

A bursts recording's timeline lists the bursts (see [Timeline](#timeline)); every time in it is a time of the joined video, so the wall-clock time between bursts is not in it.

## Lifecycle

Viewer recordings belong to a live session client and follow that client's selected top-level target. They stop after the client's five-second transport recovery window expires. HTTP and MCP callers start tab recordings because they have no session-client lifecycle.

Treat `targetId` as the opaque identifier of an Aperture top-level target. Retargeting keeps the same logical recording, output path, timeline file, and settings. Aperture keeps recording the current target until the destination is ready. Sending the current target is idempotent. Viewer, stopped, and failed recordings cannot be explicitly retargeted.

## Edited video

A recording can produce a second video, edited from what happened while it ran: captions burned in, a zoom toward where the pointer works, a ripple at clicks, and idle stretches sped up or cut out. Nothing is edited afterwards and there is no edit tool: the effects are declared on the actions themselves, and applied when the recording stops. The raw video and its timeline are always kept and returned as they are.

**Declaring effects.**

- `caption` (up to 500 characters) on every tool that can change the page, which are exactly the tools that can open a burst in a bursts recording (see [Bursts recordings](#bursts-recordings)): the pointer tools `browser_click`, `browser_move`, `browser_drag`, and `browser_scroll`, and Playwright's `browser_navigate`, `browser_navigate_back`, `browser_type`, `browser_press_key`, `browser_select_option`, `browser_fill_form`, `browser_file_upload`, `browser_handle_dialog`, `browser_drop`, `browser_tabs`, `browser_evaluate`, `browser_resize`, `browser_emulate_media`, and `browser_wait_for`. Reading tools take none, and `browser_tabs` with `action` `list` ignores it. It is shown from the start of the tool call to its end, and for at least a reading time (1.2 s, up to 5 s for long text), and ends when the next caption begins. A call that fails adds none.
- `zoom` on `browser_click`, `browser_drag`, `browser_scroll`, and `browser_move`: `true` (a magnification of 1.6), a number from 1.1 to 4, or `false`.
- `ripple` on `browser_click`: a boolean.
- On `recording.start` (and the REST start body): `idle` (`"speed"` or `"cut"`), and the defaults `ripple` and `zoom` for clicks, drags and scrolls that do not say otherwise. All are off when omitted. A move zooms only when it asks to: hovering is as often incidental as a place to look at. Drags do not ripple; the cursor already shows them.

An action's own `zoom` or `ripple`, including `false`, wins over the recording's default. The effective values are stored on the gesture in the timeline, so the edit can be reproduced from the timeline alone.

**What each effect does.**

- *Zoom* eases in over 0.6 s so that the view is centred on the place by the time the pointer gets there (at the press of a click or drag, at the end of a move, as a scroll's wheel starts), stays 0.8 s after the gesture, and eases out. Gestures less than 2 s apart share one zoom that pans between them. The view never leaves the frame, so a place near an edge sits off-centre. Captions are not zoomed.
- *Ripple* is a white ring with a dark halo that spreads from the click point over 0.6 s and fades, centred on the cursor's tip; each press of a multi-click makes one.
- *Idle* finds stretches of at least 1.5 s in which the screen did not change (see `activity` in the timeline) and no gesture, caption, ripple or zoom happens, keeps 0.3 s of each at normal speed on the busy side, and plays the rest at 8x (`speed`) or removes it (`cut`). The beginning and the end of the recording are treated the same way. A recording whose screen could not be watched is left as it is.
- *Captions* are burned in near the bottom edge, in white on a dark box.
- *Frames of different sizes.* When the viewport is resized while recording, or between the bursts of a bursts recording (each burst keeps the size the page had), the edited video has the size of the first frame and every other frame is fitted into it: scaled by the largest factor that keeps it inside, centred, with black bars where the shape differs, in an extra encoding pass before the effects. Zoom and ripple points follow the fitting. `editWarnings` say so.

**Bursts recordings.** Edits work on them: every time in the timeline is a time of the joined video, so captions, zooms and ripples land on the right moment of the burst they were made in. `idle` is accepted but has no effect (a warning says so), since a bursts recording captures nothing between its actions. A caption belongs to the burst its tool opens, so one on a call that opens none (`browser_wait_for` for time only, while no burst is open) is not in the video. A bursts recording that captured nothing (`no_bursts`) has no video and no edit.

**When it runs.** `recording.stop` (MCP, the formal API, and the live-session HTTP stop) blocks until the edited video is rendered. The video is rendered only if there is something to apply: a caption, a zoomed gesture, a rippled click, or an idle stretch to shorten. A recording with none of them has no edited video and stops as fast as ever. Rendering takes about a third of the recording's length at 1280x720 with 30 frames per second, more with many zooms or ripples, and is limited to 30 seconds plus ten times its length (at least 2 minutes, at most 30). A recording that stopped by itself (its target closed, its client left) or from the live session's websocket is not rendered when it stops, since nobody waits for it; it has `editState` `pending` and the next stop request over REST or MCP renders it. A stop request that comes while another one renders the same recording's edit does not wait: it returns at once with `editState` `rendering`, and the recording's status shows the result when the render is done. Closing the session ends a render, and a cancelled render leaves the edit `pending`. A recording whose pipeline failed keeps what it captured as it was: with effects requested it has `editState` `failed` and `recording_failed`.

**The result.** `editedRelativePath` is the edited video, `recording-<id>.edited.mp4` next to the raw video (`recording-<id>-1.webm` has `recording-<id>-1.edited.mp4`), H.264 without audio, at a constant frame rate of the recording's `fps` (at most 60) and the raw video's size. A name that is taken is numbered (`recording-<id>.edited-1.mp4`); nothing is replaced. It has no timeline of its own: times in the raw video's timeline are not times in the edited video once idle time is cut or sped up.

`editState` says where the edit stands once the recording has stopped: `none` (nothing to apply, or the effects found nothing to change), `pending`, `rendering`, `done` (`editedRelativePath` is set) or `failed`. Rendering can fail without failing the stop: the raw video and timeline are returned with `editState` `failed` and `editError` (`code`, `message`), and `editedRelativePath` is absent.

- `unavailable`: the host has no ffmpeg configured.
- `source_unreadable`: the raw video is missing or is not a video ffmpeg can read.
- `recording_failed`: the recording's pipeline failed and its captured video was kept as it was, without its effects.
- `ffmpeg_failed` (the message ends with ffmpeg's last error output), `timeout`, and `internal`.

`editWarnings` say what of the effects could not be applied or was left as it was, without failing: clicks and other gestures made with Playwright input have no position in the video and get no ripple or zoom (see the pointer tools in [mcp.md](mcp.md)); idle was left as it was because nothing was idle, or the screen could not be watched; effects beyond what fits into one ffmpeg filter (200 ripples and 120 zoomed scenes at most, fewer of them when the filter would get too long) are left out; gestures, captions or screen changes that the timeline had no room for (`truncated`) are missing from the edit, and idle is then left as it was; captions that all fall after the end of the video are not burned in. A recording that has effects but nothing they could act on has no edited video and only the warnings.

## Timeline

Every recording is saved with a timeline file next to its video, for editing: cutting out idle time, zooming toward what was clicked, drawing click effects, and making subtitles. Aperture itself edits from it when a recording stops (see [Edited video](#edited-video)). `recordings/recording-<id>.webm` has `recordings/recording-<id>.webm.timeline.json`: the timeline's name is the published video's whole name, extension included, followed by `.timeline.json`, so `intro.webm` and `intro.mkv` never share one, and a video whose name was already taken and numbered (`intro-1.webm`) has a numbered timeline (`intro-1.webm.timeline.json`). A recording saved under a supplied `path` follows the same rule (`recordings/demo/intro.webm` has `recordings/demo/intro.webm.timeline.json`). A timeline never replaces a file: if its name is taken, it is numbered (`intro.webm.1.timeline.json`). Read the actual path from `timelineRelativePath` instead of deriving it. The file is written atomically, just after the video is published, when the recording stops. Status and stop return its session file path as `timelineRelativePath`; it is absent while the recording runs and when no timeline could be written, which never fails the recording. Each `…-failed` video kept from a failed recording has a timeline of its own that covers just that video (`recording.salvaged` is `true`).

```json
{
  "version": 1,
  "recording": {
    "id": "550e8400-e29b-41d4-a716-446655440000", "video": "recordings/recording-550e8400-e29b-41d4-a716-446655440000.webm",
    "mode": "tab", "capture": "continuous", "codec": "vp8", "fps": 30, "width": 1280, "height": 720,
    "startedAt": "2026-08-01T12:00:00.123Z", "durationMs": 17379, "containerStartMs": 0,
    "edit": { "idle": "speed", "ripple": true, "zoom": 1.6 }
  },
  "segments": [
    { "index": 0, "targetId": "TARGET_A", "startMs": 0, "endMs": 10193, "width": 1280, "height": 720, "scaleX": 1, "scaleY": 1,
      "firstFrameAt": "2026-08-01T12:00:00.263Z", "clock": "pipeline" }
  ],
  "gestures": [
    { "id": 4, "kind": "click", "tool": "browser_click", "mode": "compositor", "segment": 0, "targetId": "TARGET_A",
      "startMs": 2434, "endMs": 2976, "holdMs": 300, "caption": "Click Save", "zoom": 1.6, "ripple": true,
      "path": [ { "t": 2469, "x": 200.8, "y": 649.7 }, { "t": 2868, "x": 650, "y": 400 } ],
      "clicks": [ { "t": 2929, "x": 650, "y": 400, "button": "left", "count": 1 } ] }
  ],
  "captions": [
    { "startMs": 2434, "endMs": 3276, "text": "Click Save", "gesture": 4 },
    { "startMs": 6040, "endMs": 6390, "text": "Type a name", "gesture": 0, "tool": "browser_type" }
  ],
  "activity": { "available": true, "sampleIntervalMs": 50, "mergeGapMs": 250, "spans": [ { "startMs": 3040, "endMs": 3077 } ] },
  "truncated": { "gestures": false, "pathPoints": false, "activity": false }
}
```

The schema is versioned: `version` is `1` and changes only when a change would break readers of the old one, so ignore fields you do not know. Go code reads it with `internal/recording/timeline` (`timeline.Read`), which also has the types.

**Time.** Every time is an integer number of milliseconds on the video's own clock, which is 0 at the video's first frame, the clock ffmpeg and players use, so a time can be passed to `-ss` or a `trim` filter as it is. `recording.durationMs` runs from the first frame to the end of the last. A recording of one segment is published as it was written, so its container timestamps, as ffprobe reports them, start a few tens of milliseconds after zero: `recording.containerStartMs` is that offset, and is 0 for a recording of several segments, which is joined and starts at zero. A time is where the moment lands on the frames captured at that moment. What a gesture causes takes longer to show than the gesture itself: measured on a software-rendered session, the cursor appears in the video about 20 to 40 ms after its path time, and a page's reaction to a click (the frame that shows it) about 50 to 90 ms after the click's time. The frame rate is variable, with at most `fps` frames per second, and frames are not evenly spaced.

**Accuracy.** Video time is the capture pipeline's running time, and a pipeline takes 0.1 to 0.3 seconds to start, so Aperture has each pipeline report its frames as they enter the encoder and pairs them with the wall time it read the reports. This places a segment's first frame within a few milliseconds (in one measurement, the two sides of a switch between segments agreed within 3 ms) instead of the tens or hundreds of milliseconds that assuming the pipeline's start time would be off. The segment's `clock` is then `pipeline`. If the pipeline reported nothing, `clock` is `estimated`, the first frame is assumed to be at the pipeline's start, and everything in that segment is early by its start-up time, but no more: the error does not grow.

**Segments.** A segment is one continuous capture of one target at one size. A recording has a new segment whenever it is retargeted (or its viewer follows another target), the target's output is replaced, or the viewport size or device pixel ratio changes; a bursts recording has one for each burst. Segments follow each other without a gap in the video, so `segments[n].endMs` equals `segments[n+1].startMs`. The video of a segment whose size differs from the first has that size: read `width` and `height` from the segment, not from `recording`. While a new segment starts up, the old one keeps recording until the new one produces frames; the video repeats that short stretch (typically under 100 ms), and events during it belong to the new segment. There is no time in the timeline where the video shows nothing.

**Bursts.** A recording made with `capture` `bursts` has a `bursts` array, in order: each burst has `firstSegment` and `lastSegment` (its segments; more than one when the page's capture was replaced or resized during it), `startMs` and `endMs` (video times), `leadMs` (video before its first action started) and `tailMs` (video after its last action ended), `closedBy`, and its `actions`. `closedBy` is `settled` (the screen stopped changing), `max_tail` (it was still changing at `maxTailMs`), `stopped` (the recording was stopped), `target_closed`, `target_changed` (the automation moved to another page, or the page's capture was replaced) or `pipeline_failed`. An action has `tool`, `kind` (`pointer`, `change`, or `observe`), `targetId`, `startMs` and `endMs` (the tool call, hold included; the physical gesture is in `gestures`), and `gesture` (the ID of the gesture it made, for pointer tools). Segments of different bursts follow each other in video time with no gap, and `segments[n].firstFrameAt` is far apart in wall time; use it, not the segment order, to tell when a burst happened. Gestures, captions and activity outside every burst are not in the timeline, because nothing was recorded then. `truncated.bursts` is set when actions beyond 5000 were left out. Segments of a burst recording can differ in size (a viewport change between bursts); the joined video changes frame size at those points, the same as a continuous recording whose viewport changes, so read `width` and `height` from the segment.

**Coordinates.** Cursor path points, click points, and scroll positions are pixels of the video frame, origin top left. Aperture takes them from the page's CSS pixels (at default zoom) and multiplies by the segment's `scaleX` and `scaleY`, the device pixel ratio the target was captured at, then keeps them inside the frame. A `scroll` object holds the requested wheel movement (`dx`, `dy`) in CSS pixels, not scaled, and `at`, the point the wheel turned over, in frame pixels like the others; `at` is absent when the position is not known.

**Gestures.** A gesture appears if it was made with an Aperture pointer tool (`browser_click`, `browser_move`, `browser_drag`, `browser_scroll`) on the target being recorded while it was recorded. Gestures on other targets are left out. Gestures that reached the page through the browser's debugging protocol (`mode` `cdp`) have no cursor path and no click points, and a click, move or drag among them does not name its target, so it is mapped to whatever was recorded when it happened. A scroll always goes this way: it has no cursor path either, but names its target and carries its `scroll.at` point. A gesture that began before the recording or ended after its segment is cut to the segment (`clipped` is `true`, and path and click points outside it are dropped); one that spans two segments of its target appears once in each, with the `segment` it belongs to. `startMs` and `endMs` are the physical gesture, and `holdMs` is the wait requested after it. `path` is where the cursor was, thinned so that replaying it by interpolating in time between the points stays within about half a pixel of the recorded positions, and to at most 240 points; a gesture lists the first and last position of the part inside the segment.

**Captions.** A gesture's `caption` becomes a caption from `startMs` to `endMs + holdMs`, with the `gesture` it came with. The caption of another page-changing tool (`browser_type`, `browser_navigate`, ...) spans the tool call, has `gesture` 0, and names the `tool`; such a tool does not say which target it acted on, so its caption goes to every segment it overlaps. Captions are sorted by start. A gesture without a hold gives a short span, so anything that displays captions should keep them on screen for a minimum time and end them when the next begins.

**Effects.** `recording.edit` holds the effect defaults the recording was started with (`idle`, `ripple`, `zoom`) and is absent when there were none. A gesture's `zoom` is the magnification its edited video zooms to and its `ripple` marks a click that gets a ripple, both absent when off: they are the gesture's own arguments or else the recording's defaults, already resolved, and only gestures that could be zoomed or rippled (see [Edited video](#edited-video)) carry them.

**Activity.** `activity.spans` are the intervals in which the recorded page changed, in order and without overlap; a single change is a span of length zero. While the recording runs, Aperture asks the compositor about 20 times a second (`sampleIntervalMs`) how long ago the recorded screen last changed and how many changes it has seen, and places each change at its own time, not the time it noticed it, so timing is much finer than the interval. Changes less than `mergeGapMs` (250 ms) apart are one span, so a pause shorter than that is not idle time. A change is content damage: a page surface committed new pixels to the compositor, or a page was put on the screen. The compositor's repaints are not counted, so a page that stays still has no activity however often the output was repainted (a recording starting or the live stream reconnecting repaints it), and moving the mouse does not count either, because the cursor is drawn by the compositor: use the gestures for that. Damage is not a pixel comparison, so a page that repaints identical pixels shows up as an isolated zero-length span. `activity.unknown` lists intervals in which the compositor could not be asked, where the absence of activity means nothing, and `activity.available` is `false` when it could not be asked at all.

**Limits.** A timeline keeps at most 2000 gestures, 2000 captions of other tools than the pointer tools, 240 points per gesture, 100000 path points and 20000 activity spans; `truncated` says when a limit cut something (`captions` is absent unless it did), so a very long recording is missing its later gestures rather than growing without bound.

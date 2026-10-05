# Recordings

A recording captures one browser target of a running session into a session file under `recordings/`. Stopping it on request also makes the recording edit: a timeline of what the automation did and, when the recording asked for cuts, captions, zooms or ripples, an H.264 video. The raw video is always kept.

## One recording, three surfaces

| | Live-session HTTP (`/sessions/:id/recordings…`) | API (`/api/sessions/:id/recordings…`) | MCP |
|---|---|---|---|
| Credentials | API `sessions:write`, `aps_`, `ape_` | API `sessions:write` | API token or `aps_` |
| Start | `POST …/recordings` | `POST …/recordings` | `recording.start` |
| List, status | `GET …/recordings`, `GET …/recordings/:rid` | same paths | `recording.list`, `recording.status` |
| Retarget | — | `POST …/recordings/:rid/retarget {targetId}` | `recording.retarget` |
| Stop | `POST …/recordings/:rid/stop` answers with the raw media bytes | `POST …/recordings/:rid/stop` answers with the recording | `recording.stop` answers with the recording |
| Download later | `GET …/recordings/:rid/content` of a `stopped` recording | a signed URL for the `relativePath` ([session-files.md](session-files.md#download)) | same |
| Annotate | `POST …/recordings/annotations/{caption,focus,reset_focus,attention}` | `POST …/recordings/:rid/{caption,focus,reset-focus,attention}` | `recording.caption`, `recording.focus`, `recording.reset_focus`, `recording.attention` |

Interactive clients use the `recording.start`, `recording.stop` and `recording.cancel` commands of the [session protocol](live-session.md#session-protocol) instead, with the same fields; after `recording.stop.result`, fetch `/content` rather than stopping again. The API routes and their bodies are in the spec; the live-session and MCP bodies are the same fields.

**Start body.** `targetId` of a ready top-level target (from `browser.targets` or `browser/status`), with optional `fps`, `bitrateKbps`, `codec` (`vp8` or `h264-va`; the latter is refused where the host lacks VA-API, `422` / `recording_codec_unavailable`), `path` below `recordings/` (ignored for `aps_` and `ape_` callers), the [edit settings](#edit-settings), and over live-session HTTP `mode` (`tab`, or `viewer` with the `clientId` of a connected client, which then follows that client's selected target and stops when the client is gone for five seconds) and an optional `clientId` for a tab recording that should stop with that client. API and MCP start tab recordings only. Several recordings may run at once.

**Recording object.** `recordingId`, `mode`, `targetId`, `captureGeneration`, `status` (`starting`, `running`, `stopped`, `failed`), `relativePath`, `sandboxPath`, `startedAt`, `fps`, `bitrateKbps`, `codec`, `editing`; once over, `stopReason`, `stoppedAt`, `sizeBytes`, and once `editing` is false again, `editedRelativePath`, `timelineRelativePath` or `editError {code, message}`. Host paths never appear. A failed recording keeps what it captured as `…-failed` files, and `relativePath` points at the first.

**Targets.** `targetId` is an opaque Aperture target id; it survives navigation and ends when the page closes. Retargeting keeps the recording, its path, timeline and settings, records the old target until the new one is ready, is idempotent for the current target, and is refused for viewer, stopped and failed recordings.

## Gate and journal

Browser automation calls, recording start and stop, and `attention` share one gate: a start waits for a running browser call and returns only after the capture's first frame, so nothing happens before frame 0; a stop leaves the gate before the render begins. While a recording runs, automation goes at the recorded or presentation [cadence](live-session.md#automation-pacing) and is journaled: pointer glides, presses and wheel input, smooth reveal scrolls, a span for every browser tool whose `readOnlyHint` is not true, and the explicit annotations.

### Annotations

They act on the recording named by `recordingId`, or on the only running one; with none or several running and no id, they fail. Coordinates are CSS pixels of the recorded tab's viewport; a `selector` is resolved in its top-level document.

- `caption`: `text` (1 to 200 characters), `durationMs` (200 to 30000, default 3000). Returns at once; the text is burned in from that moment.
- `focus`: `rect {x, y, width, height}` or `selector`, `zoom` (above 1, up to 4), optional `durationMs` (200 to 10000). A recording holds one focus: it zooms in and holds until `reset_focus`, the next `focus` (the view moves and zooms from one to the other) or the recording's end, and zooms out after 60 s if nothing ended it. Without `durationMs` the call returns at once; with it, the focus zooms out after that long and the call returns then. Browser tools run meanwhile, so the usual flow is `focus`, act, `reset_focus`. A `selector` focus follows its element as automation scrolls or the layout moves. Only the part of the rect inside the viewport is shown, and the zoom is lowered so that part fits the frame.
- `reset_focus`: zooms out of the recording's focus; does nothing without one.
- `attention`: `point {x, y}` or `selector`, `radius` (8 to 300, default 40), `loops` (1 to 5, default 2), `durationMs` (300 to 5000, default 1200). Circles the real pointer around the place, so it needs a compositor session and the session's input to be free; blocks for the duration.

## Edit settings

On every start surface:

| Setting | Values | Effect |
|---|---|---|
| `capture` | `continuous` (default), `bursts` | `bursts` keeps only the stretches around non-read-only browser tool calls and follows the tab the automation acts on |
| `burst` | `{leadMs, tailMs, settleMs, maxTailMs}`, each 0 to 60000, 0 meaning the default | a stretch runs from `leadMs` (500) before the call to `tailMs` (800) after it, extended until the screen has stood still for `settleMs` (400) but never past `maxTailMs` (3000); `tailMs` may not exceed `maxTailMs`; overlapping stretches merge; focus and attention windows are kept too; only with `bursts` |
| `idle` | `cut`, `speed` | removes, or plays at ×8, the stretches of a continuous recording where neither the screen nor the automation changes (a little padding stays); not with `bursts` |
| `ripple` | bool | draws a ripple on every click |
| `presentation` | bool | runs automation at presentation cadence while recording |

Contradictory settings are refused at start (`validation_failed` over the API, `400` from the session). Idle detection counts only changes at 5 fps or more as activity, so a slow spinner is idle.

## What a stop produces

Only a requested stop edits; a recording that ends because its tab closed, its client left or the session ended keeps the raw video alone, without `editError`. The stop returns as soon as the raw video is published: the recording is `stopped` with `editing: true`, and the edit runs on its own for about as long as the recording, at most 30 minutes. Poll status (or watch `recordings.state` on the live session) until `editing` is false. A second stop meanwhile returns the current state; `recording.cancel`, suspending, deleting or closing the session ends the edit with `editError.code` `cancelled`. A running edit counts as session activity, so the session does not idle-suspend under it.

Next to the raw video, named like it and never overwriting: `<name>.timeline.json` whenever the journal has anything, and `<name>.edited.mp4` when something is to be applied (cuts, captions, focus, ripples). A recording with no settings and no annotations is not edited. Segments recorded after a resize are scaled to the first segment's size.

The timeline holds `segments`, the `map` from raw to edited time when a video was made, and `events`: tool calls, glides, presses, wheel input, reveals, retries (`retry` with the `reason` a check of the running action failed, after which Playwright scrolled and tried again), captions, focus and attention, each with `startMs` and `endMs` in raw time and `editedStartMs` and `editedEndMs` in edited time.

`editError.code` is one of `ffmpeg_unavailable`, `open_failed`, `nothing_kept` (a bursts recording with no call to keep), `analysis_failed`, `plan_failed`, `render_failed`, `timeout`, `cancelled` or `timeline_failed`. The raw video is there whatever the code.

Edits need `recording_ffmpeg_executable` on the instance (the Nix image sets it). Without it, `capture: bursts`, `idle` and `ripple` are refused at start; `presentation` alone still works, since it only paces.

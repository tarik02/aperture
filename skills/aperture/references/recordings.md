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
  "presentation": true,
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

`targetId` must identify a ready top-level target. A tab recording stays pinned to it unless `presentation` is true; presentation recordings follow the target on which browser automation ends. A viewer recording follows the selected target of the connected `clientId`; `clientId` is required for viewer mode. Pass `clientId` with a tab recording when it should also stop if that client disconnects. Multiple recordings may run concurrently.

Supported codecs are `vp8` and `h264-va`; `h264-va` is rejected up front where the host's GStreamer lacks its VA-API elements (`422`, or `recording_codec_unavailable` through the API). Omitted or non-positive FPS and bitrate values use instance defaults. Omit `path` to generate a file in the session's `recordings` directory. A supplied `path` is a session file path below `recordings/`, such as `recordings/demo/intro.webm`; missing directories are created. Session tokens cannot override the generated path.

Start and status return `recordingId`, `mode`, `targetId`, `captureGeneration`, `status`, `relativePath`, `sandboxPath`, `startedAt`, `fps`, `bitrateKbps`, and `codec`; host paths are never returned. `path` repeats `relativePath` for older clients and is deprecated. Completed jobs may also include `stopReason`, `stoppedAt`, and `sizeBytes`. When a recording fails, what it captured is kept as `…-failed` files next to its target and `relativePath` points at the first one. Status is `starting`, `running`, `stopped`, or `failed`. The list route returns an array of these objects.

The live-session HTTP stop request takes the same `edit` object as MCP, finalizes the recording, and serves the completed media attachment. Interactive clients start and stop through `aperture-session.v1`; after `recording.stop.result`, fetch `/content` to download without issuing a second stop.

## Formal API

These routes require `sessions:write`:

- `POST /api/sessions/:sessionId/recordings` — start a tab recording
- `GET /api/sessions/:sessionId/recordings` — list recordings
- `GET /api/sessions/:sessionId/recordings/:recordingId` — get recording status
- `POST /api/sessions/:sessionId/recordings/:recordingId/retarget` — move a running tab recording to another ready target
- `POST /api/sessions/:sessionId/recordings/:recordingId/stop` — stop and return the completed `SessionFile`

Public recording results use `relativePath`; absolute host paths are never returned. The formal stop route finalizes without media transfer and returns the completed session file with `name`, `relativePath`, `size`, `modifiedAt`, and `mimeType`, plus `sandboxPath`.

## MCP

MCP exposes `recording.start`, `recording.list`, `recording.status`, `recording.retarget`, and `recording.stop`. MCP starts tab recordings only. Call `browser.targets` and select a target whose `state` is `ready` before starting or retargeting a recording. Central tools take `sessionId` and tenant selection where required; session-bound tools bind the session from the URL. `recording.start` takes `targetId`, optional capture settings, and optional `presentation`. `recording.stop` takes `recordingId` and the one-time `edit` policy below. Retarget takes both `recordingId` and the ready destination `targetId`.

## Lifecycle

Viewer recordings belong to a live session client and follow that client's selected top-level target. They stop after the client's five-second transport recovery window expires. HTTP and MCP callers start tab recordings because they have no session-client lifecycle.

Treat `targetId` as the opaque identifier of an Aperture top-level target. Retargeting keeps the same logical recording, output path, timeline, and settings. Aperture keeps recording the current target until the destination is ready. Sending the current target is idempotent. Viewer, stopped, and failed recordings cannot be explicitly retargeted.

## Browser-driven recording

Any active recording enables a short visible automation cadence. Use `presentation: true` for slower pointer motion, click ripples by default, and target following across browser automation. This affects browser MCP automation; manual live-session input stays immediate.

Use this workflow for a demonstration or bug-reproduction video:

1. **Reproduce without recording.** Establish the shortest reliable reproduction and inspect its final state. Name the evidence anchor: the smallest visible point, edge, value, or element that proves the bug.
2. **Rehearse with recording active.** Reset the app, start a disposable presentation recording, and run the intended shot plan. Active recording changes browser-tool cadence, so an unrecorded run cannot validate timing. Rehearse at least once when the flow contains frames, scrolling, dynamic layout, or combined focus and cursor attention; repeat only until the acceptance checks below pass.
3. **Freeze the shot plan.** Record the exact actions, checkpoints, evidence anchor, focus rectangle, attention point, radius, delay, and duration. Do not discover selectors or coordinates during the final take.
4. **Record from reset state.** Execute only the frozen plan, present the evidence, then stop immediately. Do not retry inside the final recording.
5. **Review the actual video.** Watch the complete edited video and inspect full-resolution frames around scrolling, layout changes, and the final evidence. Do not accept a take from tool success or a sparse contact sheet alone.

Start each rehearsal or final capture before reproducing the flow:

```json
{
  "targetId": "TARGET_ID",
  "presentation": true
}
```

Stop once, selecting the edited output then:

```json
{
  "recordingId": "RECORDING_ID",
  "edit": {
    "trim": "actions",
    "cutStyle": "tight",
    "ripple": true
  }
}
```

`trim` is `none`, `idle`, or `actions`; action trimming retains successful browser actions plus explicit focus and attention intervals. For action trimming, `cutStyle` is `natural` or `tight`; tight follows real gesture and activity windows closely while preserving cursor, scroll, and page motion at their natural speed. It removes an invisible pause between an automatic reveal and the following gesture when that pause is not part of either visible interval. Omitted values use `none`, `natural`, and the recording's presentation ripple default. Capture-window durations are worker policy rather than caller tuning knobs. Finalization is part of stop and is not repeatable.

Browser actions accept an optional `caption`. Pointer tools expose `motion`, `arrivalDwellMs`, and `holdMs` where applicable; explicit values override cadence defaults. `browser_scroll` uses wheel deltas and visible scrolling. Targets revealed by ordinary actions also scroll smoothly, including through nested frames.

A rehearsal passes only when:

- every required browser action succeeds and the bug is visibly reproduced;
- automatic and explicit scrolling is smooth and ends at the intended state;
- menus, tooltips, and transient overlays appear only when the shot needs them;
- focus and cursor attention compose as planned;
- the evidence remains visible long enough to understand;
- there is no unexplained idle tail or visible encoding artifact.

If an edited frame looks corrupted, compare the same timestamp in the raw recording. Corruption present in raw capture belongs to capture or encoding; corruption appearing only after editing belongs to finalization.

### Presenting the visible problem

Before adding focus or cursor attention, take a snapshot of the reproduced final state and name the **evidence anchor** in one sentence. The evidence anchor is the smallest visible point, edge, value, or element whose state demonstrates the bug. The step is complete only when its exact selector, point, or rectangle can be identified from that snapshot.

Keep these roles separate:

- The evidence anchor proves the bug. For spatial defects, use the exact intersection, clipped boundary, gap, overlap, or displaced edge. For state defects, use the incorrect value or control. Explanatory text is the anchor only when that text is itself wrong.
- The focus rectangle provides enough surrounding context to understand the anchor. Keep the anchor visible with margin; the component center is not a substitute for the anchor.
- Cursor attention points to the evidence anchor. Choose its point and radius from the final-state snapshot, after all layout and scrolling have settled.

For example, when a plotted line is clipped by the chart viewport, the anchor is the line-boundary intersection—not the chart center or an error message elsewhere in the chart.

Present the evidence with two concurrent browser calls:

- `browser_focus_viewport` frames the evidence and its necessary context. It is non-blocking and records a future camera interval.
- `browser_cursor_attention` points at the evidence anchor. Set `delayMs` to place its motion inside the focus interval, and `durationMs` to control the attention movement itself.

Issue both calls in the same parallel tool batch. Never wait for focus and then call attention: that places the cursor near the end of the focus instead of its middle. For example, pair a `5000ms` focus with attention using `delayMs: 1500` and `durationMs: 1800`. Account for the cursor's short approach when reviewing the rehearsal; adjust timing from the video, not from arithmetic alone.

After finalization, inspect full-resolution frames throughout the overlap. Accept the take only when focus has settled before the cursor starts drawing attention, cursor motion occupies the middle of the focused hold, the cursor visibly moves around the evidence anchor, and focus remains until the movement finishes. Hover effects must not obscure or replace the evidence. Otherwise adjust the point, radius, delay, duration, or focus rectangle, rehearse again, and make a fresh final take.

Camera focus is explicit: call `browser_focus_viewport` with one active `recordingId`, a target or viewport rectangle, `zoom` from 1.1 to 4, and optional `durationMs` up to 10000. It records the focus interval without moving the cursor or blocking concurrent cursor attention. Use `browser_cursor_attention` with a target or point, `radius`, `loops`, `delayMs`, and `durationMs`. Its path uses small bounded per-call variations so repeated takes feel natural while remaining centered on the selected evidence. Ordinary actions never add zoom.

Stop publishes the raw recording plus `capture.json`, `actions.ndjson`, `config.json` containing the edit policy, the finalized `timeline.json`, and an H.264 MP4 when editing applies. Read `captureRelativePath`, `actionsRelativePath`, `configRelativePath`, `timelineRelativePath`, and `editedRelativePath` from status or MCP stop; use session-file operations to download them. A failed finalizer preserves raw capture and available sources; check `finalizeError` and `warnings`. Files become visible only after finalization, and publication never overwrites an existing session file.

Each connected owner/editor may request `presentation.automation.set { pacing: "normal" | "watchable" }` independently of the input lease. The workbench's **Watchable automation** toggle defaults on. Any watchable editor enables recorded cadence; any presentation recording enables presentation cadence. Pacing disappears when its transport disconnects and is not snapshot state. Viewers cannot control it.

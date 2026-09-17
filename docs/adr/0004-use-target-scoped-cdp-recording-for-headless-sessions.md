---
status: accepted
---

# Use target-scoped CDP recording for headless sessions

Headless sessions will persist recordings from CDP `Page.startScreencast` frames through the existing wrapper and target-scoped recording API. This extends ADR 0002: recording start still requires a `targetId`, returns a `recordingId`, and selects `tab` or `viewer` mode. CDP recording captures page pixels rather than pretending to provide compositor window semantics.

## Context

ADR 0002 replaced the singular, no-target screencast API with concurrent target-scoped recording jobs. Its compositor implementation records one target's managed Chromium window from PipeWire, including transient browser UI associated with that window. A headless session has no compositor or PipeWire capture target.

CDP `Page.startScreencast` emits encoded image frames for one page target. It does not capture browser-owned transient windows or audio. Target changes, frame acknowledgement, image decoding, video encoding, overload, and process failure therefore need explicit semantics before CDP frames can back the recording API.

## Decision

Headless recording preserves every public identity and consumer rule from ADR 0002:

- `targetId` is required. The removed no-target screencast start API is not restored.
- A `tab` recording remains pinned to its target.
- A `viewer` recording follows one recording client's confirmed target.
- Each recording has its own `recordingId`; multiple recordings may run within the advertised capacity.
- Closing the selected target finalizes a nonempty recording with `target_closed`. An empty recording fails without publishing a session file.

Headless sessions preserve ADR 0002's one-user-page-target-per-managed-window invariant. The bundled Aperture extension enforces the window layout without preparing compositor bindings. A live user page becomes ready for CDP media after the extension settles, the wrapper verifies a distinct Chromium window for its `targetId`, and the wrapper establishes its target-scoped viewport. The shared target registry omits Wayland surface and capture identities for headless targets.

The headless recording capability reports `mechanism: "cdp"`, `scope: "page"`, and `audio: false`. A compositor-backed configuration can report different scope and audio support. Recording behavior is read from capabilities and is not inferred from browser mode.

The wrapper owns the CDP connection, target attachment, recording lifecycle, activity inhibition, output path, and encoder. CDP image frames enter GStreamer through `appsrc` and reuse the existing output encoders. VP8 produces `video/webm`; H.264 produces `video/x-matroska`. Capabilities advertise valid codec and media-type pairs rather than treating every recording as WebM.

Common recording controls remain codec, target bitrate, and maximum FPS. CDP-backed recording also accepts an optional `cdp` object:

```json
{
  "cdp": {
    "format": "jpeg",
    "quality": 80
  }
}
```

`format` is `jpeg` or `png`; `quality` applies only to JPEG. Target viewport controls dimensions. CDP `maxWidth`, `maxHeight`, and `everyNthFrame` are not exposed because they would compete with target viewport and maximum FPS.

CDP recordings use variable frame rate. FPS is a maximum, not a guarantee. Accepted frames receive monotonic timestamps, gaps display the last frame, and the final frame extends to the actual stop time so media duration matches elapsed recording time.

Each recording has a bounded frame queue. The wrapper promptly acknowledges CDP frames after accepting or dropping them, discards older queued work in favor of current frames when overloaded, and never blocks Chromium rendering on encoder throughput. Recording status reports accepted and dropped frame counts.

A viewer target change rotates the recording segment. The wrapper stops the previous page frame stream, finalizes that segment, starts a segment for the newly confirmed target, preserves wall-clock continuity, and joins all segments during finalization. Target viewport or output-format changes that require new encoder dimensions use the same segment boundary. Tab recordings never change targets.

Recording metadata remains wrapper memory. Orderly session shutdown, including explicit suspend, delete, and service drain, finalizes all active recordings before stopping the wrapper. Active recordings inhibit automatic suspension. Starting a recording wakes a suspended session and waits for its wrapper and target registry; status and stop do not wake a session.

A wrapper, browser, or encoder crash fails every affected active recording. Aperture removes its partial segments, publishes no session file, and never resumes or salvages the recording. Recording metadata remains in wrapper memory only; after a wrapper restart its recording IDs, status, target, controls, counters, and stop reason disappear.

## Considered options

- Resolving an omitted target would conflict with ADR 0002's target identity and make headless recording differ from headed recording at the API boundary.
- Following a session-global active tab would reintroduce the mutable media selection ADR 0002 removed.
- Treating CDP capture as window-scoped would hide its omission of browser-owned transient UI.
- Keeping several user page targets in one headless Chromium window would freeze every background target's CDP frame stream. In Chromium 149, simultaneous screencasts in one window produced about 95 to 99 active-target frames and zero or one background-target frame per four seconds; separate windows produced about 94 to 100 frames for both targets. A shared window cannot preserve ADR 0002's pinned recordings or independent consumers.
- Adding FFmpeg or an in-process video stack would duplicate the packaged GStreamer encoders and codec probing.
- Delaying CDP acknowledgement until encode completion would couple page rendering to encoder throughput.
- An unbounded queue would trade dropped frames for unbounded memory and stale video.
- Constant-frame-rate output would manufacture frames Chromium did not produce.
- Resuming after a process restart cannot preserve CDP target identity or frame timestamps.
- Salvaging partial segments after a crash would add recovery semantics for media that Aperture cannot guarantee is complete or playable.
- Persisting recording jobs in the central database or session metadata would preserve status across restarts, but that durability is not required; only recordings finalized before a crash persist.
- Silently falling back between compositor and CDP capture would change recording scope during one job.

## Consequences

- The headless wrapper needs window enforcement, a CDP target registry, per-recording CDP sessions, image decoding, bounded queues, GStreamer `appsrc` pipelines, segment rotation, and partial-media cleanup.
- Headless recording is video-only and page-scoped. Capabilities make both limits visible before start.
- Live CDP viewing and concurrent CDP recordings can consume the same target independently, subject to the advertised recording capacity.
- Slow encoders reduce temporal detail instead of slowing Chromium or exhausting memory; counters expose the loss while the wrapper is alive.
- Viewer recordings retain ADR 0002's client-following behavior across target changes without claiming compositor-wide capture.
- Orderly lifecycle operations produce finalized session files. Crashes discard affected recordings and their partial media.

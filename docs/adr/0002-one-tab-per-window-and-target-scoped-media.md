# ADR 0002: one tab per window and target-scoped media

- Status: accepted
- Date: 2026-07-31

## Context

Aperture presents CDP page targets as tabs in its own frontend. Chromium still owns the native windows behind those targets. A normal Chromium window can contain several tabs, while the Wayland compositor sees only one top-level window and only the active tab produces that window's pixels. The compositor therefore cannot reliably associate a captured window with one CDP target.

The current compositor media path has one Weston output, one PipeWire target, one WebRTC video source, and one session-wide recording. Selecting a different frontend tab changes the CDP target used for commands, but it does not select an independent compositor media source. This prevents target-specific recording, concurrent consumers, and predictable media switching.

The current resize path mutates a live output's mode and scale while its window, PipeWire node, encoders, and consumers remain attached. A resize can leave those components observing different generations of size and DPR state. Recovering from a partial failure requires more mutation of the same live objects.

Chromium does not provide a supported flag, policy, or CDP command that enforces one tab per normal window. `Target.createTarget` with `newWindow: true`, kiosk mode, and app windows only affect specific creation paths. They do not establish a lasting invariant.

## Decision

Aperture will enforce one user page target per managed Chromium window with a required extension. It will maintain one target registry that joins CDP targets, Chromium windows, Wayland top-level windows, and capture outputs. Recording and streaming will consume entries from this registry by CDP `targetId`.

Media selection belongs to each consumer. The server will not maintain one session-wide current target. A frontend tab click will select a target for that frontend's media consumer without retargeting recordings or other viewers.

Weston outputs will be immutable after they become active. A viewport size, DPR, pixel format, refresh rate, or other output property change will create a replacement output and move the target to it. Consumers will follow the target to the replacement before Aperture retires the old output.

### Identities and invariants

`targetId` is the public identity used by browser control, streaming, recording, and the frontend. Other identifiers remain internal and exist only for joining subsystem state.

| Identifier | Owner | Lifetime | Purpose |
| --- | --- | --- | --- |
| `targetId` | CDP | page target lifetime | Public target identity |
| `windowId` | Chromium | browser window lifetime | Join key shared by the extension and CDP |
| `surfaceId` | Aperture compositor | Wayland top-level lifetime | Compositor routing and parent for transient surfaces |
| `captureId` | Aperture media runtime | immutable output generation lifetime | PipeWire and encoder routing |
| `consumerId` | Aperture media runtime | stream or recording lifetime | Independent target selection |

The following invariants apply after a target becomes ready:

- Each managed Chromium top-level window contains exactly one user page target.
- Each ready user page target maps to exactly one `windowId`, `surfaceId`, and `captureId`.
- A `windowId` maps to at most one ready user page target.
- An active capture output never changes its size, scale, format, or refresh rate.
- Extension marker pages, DevTools windows, and internal Chromium targets never become public media targets.
- Aperture does not expose a new top-level window to media consumers until the complete mapping is ready.

Chrome extension `windowId` and CDP `Browser.WindowID` currently use the same Chromium `SessionID`. Aperture will rely on this packaged-Chromium behavior and verify it when upgrading Chromium.

### Required extension

Compositor-backed sessions will load a bundled Aperture extension that uses `chrome.tabs`, `chrome.windows`, and `nativeMessaging`. A native messaging host will connect the extension to a session-local wrapper socket. The host will accept only the bundled extension ID and will not expose tenant or session credentials to the extension.

The extension will reconcile all existing windows at startup and then process `tabs.onCreated`, `tabs.onAttached`, `tabs.onDetached`, `tabs.onRemoved`, and window lifecycle events. Reconciliation will be serialized and idempotent so service worker restarts and event bursts produce the same final state.

All stable managed windows will use Chromium's popup window type. Popup windows do not present a tab strip and normal new-tab navigation does not add another tab to them. Any normal Chromium window is a staging window and remains hidden from media consumers until the extension has moved its user tabs into managed popup windows.

For each user tab that needs a managed window, the extension will:

1. Generate a random binding nonce.
2. Create a popup window containing an extension-owned marker page.
3. Report the nonce, returned Chrome `windowId`, and pending tab through native messaging.
4. Wait for the wrapper to acknowledge the matching Wayland top-level.
5. Move the existing tab into the popup window, preserving its WebContents and CDP `targetId`.
6. Close the marker tab.
7. Report that enforcement has settled for the source and destination windows.

The marker page places the binding nonce in its title. New Chromium top-level windows start hidden in the Aperture shell. The compositor reports the marker title and its allocated `surfaceId` to the wrapper. The wrapper joins the nonce reported by the extension with the nonce observed by the compositor, then acknowledges the binding.

The temporary marker tab is an internal implementation detail. The target registry excludes its extension URL. A managed window becomes ready only after the marker is gone and CDP reports exactly one user page target for its `windowId`.

Extension enforcement is asynchronous inside Chromium. Aperture provides the stronger external guarantee that pending or unstable windows are not recordable or streamable. If the extension or native host disconnects, existing verified mappings may continue, but new and changed windows remain unavailable until reconciliation succeeds.

### CDP and window mapping

The wrapper will discover page targets through CDP and resolve their current Chromium window with:

```text
Target.getTargets
    targetId
        -> Browser.getWindowForTarget(targetId)
        -> windowId
```

Moving a tab preserves its `targetId` but changes its `windowId`. Extension attach and detach events will trigger a CDP reconciliation. Aperture will not depend on `Target.targetInfoChanged` for tab moves because a move may not change target metadata.

The complete mapping is:

```text
CDP targetId -> Chrome windowId <- extension binding
                                      |
                                 binding nonce
                                      |
Weston surfaceId -> captureId <- wrapper target registry
```

The wrapper owns this registry. The frontend, recording API, MCP tools, and WebRTC protocol use only `targetId` and readiness state. They never address PipeWire object serials or Wayland objects directly.

### Per-target compositor capture

Each managed window will receive an isolated virtual Weston output before it becomes ready. The PipeWire backend will expose one video node for that output, and the target registry will store its active `captureId`.

The compositor will place the target's top-level view and its related surface tree on the same output. This includes subsurfaces, `xdg_popup` menus, and transient dialogs associated with the top-level. Other Chromium windows, the compositor background, and unbound staging windows must not appear in that output.

The requested viewport size and DPR are target properties. The active output generation is an immutable realization of those properties. Stream encoding quality remains a consumer property and does not change the target's browser viewport.

The compositor control protocol will become target-aware. Surface lifecycle events, focus, viewport changes, and input routing will carry `surfaceId` internally. The wrapper translates public `targetId` commands through the registry.

### Immutable output replacement

An output specification contains its logical size, scale, physical size, pixel format, transform, and refresh rate. Aperture fixes this specification before enabling the output. It never changes the specification of an active output.

A viewport or DPR change uses a replacement transaction:

1. Coalesce the requested target specification and allocate output generation N+1 with its final properties.
2. Enable the new Weston output and wait for its PipeWire node.
3. Freeze each consumer on generation N's last valid frame and suspend input for the target.
4. Move the target's top-level view and related surface tree to generation N+1, then send Chromium the new output and window configuration.
5. Wait for Chromium to acknowledge the configure, commit a matching buffer, and produce the first PipeWire frame from generation N+1.
6. Update the target registry's active `captureId` and switch every consumer of that target to generation N+1.
7. Preserve RTP and recording timestamp continuity, force an encoder keyframe, and resume input with the new coordinate space.
8. Retire generation N after the window has left it and every consumer lease has drained.

If the successor fails before cutover, Aperture destroys it and keeps generation N active. If the window has already moved, Aperture moves it back to generation N before consumers resume from the old capture. A failed replacement does not change the target's active `captureId`.

Only one successor transaction may exist for a target. Aperture coalesces rapid changes before creating an output. If a newer specification supersedes a successor under construction, Aperture discards that successor and builds the latest requested specification while the old active generation remains available.

Chromium sees replacement as display hotplug. Aperture must add and configure the new output before removing the old one so Chromium always has a valid destination for the window. During continuously dragged frontend resizing, the frontend scales the current video locally and requests one replacement after resizing settles. Explicit viewport and DPR selections request a replacement immediately.

### Universal media consumers

Streaming and recording will use the same target registry and capture source abstraction. Each consumer has an independent selected `targetId`.

- A WebRTC peer is a switchable consumer.
- A recording job is a pinned consumer by default.
- CDP screencast fallback follows the selecting frontend's target.
- Future consumers such as snapshots can use the same registry without creating another mapping mechanism.

The runtime may enforce resource limits, but it must return an explicit capacity error. It must not stop or retarget another consumer to satisfy a new request.

The wrapper will expose registry snapshots and lifecycle events keyed by `targetId`. CDP remains the source of page title, URL, and loading metadata. The registry is the source of compositor media readiness. The frontend merges both views instead of inferring readiness from CDP attachment or document visibility.

### WebRTC target switching

The WebRTC control channel will add a request and result pair for target selection:

```json
{
  "version": 4,
  "id": "target-17",
  "type": "target.select",
  "target_id": "CDP_TARGET_ID"
}
```

A successful result identifies the selected `targetId`, current viewport metadata, and a monotonically increasing selection generation. Selection is scoped to that peer. The server validates that the target is ready, switches the existing video sender to the target's capture source, and forces a keyframe. The switch uses the existing video transceiver and does not renegotiate SDP.

Replacing the selected target's output generation uses the same source-switch path. It does not change the peer's selected `targetId` or selection generation. The peer receives updated viewport metadata when the new output becomes active.

The client hides or curtains the previous video after sending `target.select`. The server acknowledges success only when it has accepted a frame from the new capture source and queued the new keyframe. This prevents an old target frame from being displayed under the newly selected frontend tab.

Rapid selections use request IDs and generations. The latest accepted selection wins. A late response for an older generation does not change frontend state.

Media selection and input ownership are separate:

- Selecting a target for viewing does not steal the compositor input seat from another consumer.
- A peer must hold the existing input lease before it can send input.
- Acquiring input focuses that peer's selected target.
- Switching or losing the selected target releases pressed keys, pointer buttons, and text input state before focus changes.
- Input is rejected while selection is pending or the selected target is unavailable.

### Frontend behavior

The frontend will distinguish the requested target from the confirmed media target.

When the user selects an Aperture tab, the frontend will:

1. Set the requested `targetId` in client-local state.
2. Send `target.select` to the live WebRTC consumer, or restart `Page.startScreencast` for CDP fallback.
3. Show a switching state and suspend viewport input.
4. Confirm the tab's media selection after the target result and first new-target frame.
5. Resume input only when the media target and requested target match.

Frontend selection will not use `Target.activateTarget` as the WebRTC media switch. Browser commands already carry an explicit `targetId`. CDP fallback may activate a target when Chromium requires it to produce screencast frames, but activation does not define the consumer's selected target. Compositor focus changes only when an input owner needs focus.

Different frontends connected to the same session may select different targets. Closing a selected target produces a target-unavailable event. The server does not choose a replacement. Each frontend decides which remaining tab to select.

### Recording

Recording becomes a collection of jobs instead of one session-wide screencast. Starting a recording requires a ready `targetId` and returns a `recordingId`. Listing, status, and stop operations address that recording ID. Multiple recordings may run concurrently within configured resource limits.

A recording remains pinned to its target when a frontend switches tabs. It follows verified window rebindings and immutable output replacements for the same `targetId`, preserves its timeline, and inserts a keyframe at each source change. If the target closes, Aperture finalizes the recording with `target_closed` as its stop reason. It never switches the recording to another target.

The HTTP API and MCP tools will expose `targetId` and `recordingId`. The existing singular start, status, and stop state will be replaced rather than overloaded with an implicit current target.

This ADR covers video. Target-scoped audio needs a separate decision because Chromium and desktop audio do not have the same one-window identity.

### Failure and lifecycle behavior

The registry will expose explicit target states:

- `pending`: CDP, extension, compositor, or capture mapping is incomplete.
- `ready`: the complete one-target window mapping is verified and capture is available.
- `unavailable`: a previously known target cannot currently serve media.
- `closed`: the CDP target ended and consumers have been notified.

PipeWire-backed consumers can select only ready targets. A target remains ready while a replacement output is prepared because its old generation stays active. CDP fallback may attach to any live user page target because it does not consume a compositor capture output. A compositor or PipeWire restart moves affected entries to unavailable until their identities are rebuilt. The wrapper never guesses a mapping from window title, creation order, PID, geometry, or focus alone.

## Consequences

- Aperture gets one public identity for control, streaming, and recording.
- Frontend tab selection no longer changes session-global media state.
- Recordings can stay pinned while viewers switch targets.
- Independent viewers and recordings can consume different targets concurrently.
- Popup and transient content is captured with its parent window instead of being lost by tab-only capture.
- Chromium remains unmodified, but the bundled extension and native messaging host become required runtime components.
- The design depends on the packaged Chromium implementation sharing window `SessionID` between extension and CDP APIs.
- Resize and DPR changes no longer mutate active Weston or PipeWire objects.
- Per-target outputs and concurrent encoders increase GPU, PipeWire, and memory use.
- Output replacement temporarily doubles the render and PipeWire resources for one target.
- Chromium observes replacement outputs as display hotplug, so interactive resizing must be coalesced.
- The compositor, wrapper API, WebRTC protocol, recording API, MCP tools, and frontend all require coordinated changes.

## Rejected alternatives

### Rely on kiosk, app mode, or `Target.createTarget`

These options create particular windows but do not prevent later tab insertion through every Chromium path.

### Move extra tabs after creation without hiding pending windows

The final layout is correct, but a compositor consumer can observe the wrong active tab during the move. New top-level windows must remain hidden until extension and CDP reconciliation has settled.

### Map CDP targets directly to Wayland windows

CDP does not expose a Wayland object or native handle. Wayland titles, app IDs, PIDs, focus, geometry, and creation order are not unique and stable join keys.

### Keep one global compositor output and switch it

A global switch makes one viewer's tab selection retarget every stream and recording. It cannot support independent consumers or concurrent target recording.

### Mutate an active output

Changing a live output's mode or scale couples Weston configuration, Chromium buffers, PipeWire negotiation, encoders, and consumers into one partial update. Immutable replacement keeps the previous generation usable until the complete successor is ready.

### Use `Page.startScreencast` as the primary media source

CDP screencast remains a useful fallback, but it does not capture browser-owned transient windows and does not use the compositor's rendering and input path.

### Patch Chromium to reject extra tabs

A Chromium patch could provide an atomic internal invariant, but it creates a long-lived browser maintenance burden. The extension plus hidden pending-window protocol provides the required external invariant without a fork.

## Delivery order

1. Add the extension, native host, window reconciliation, and binding protocol.
2. Add target registry state and default-hidden top-level handling to the wrapper and compositor.
3. Add isolated per-target outputs, immutable output generations, and transactional replacement.
4. Replace session-wide recording with target-scoped recording jobs.
5. Add per-peer WebRTC target selection and target-aware input routing.
6. Connect frontend tab selection and CDP fallback to consumer-local target state.
7. Remove the session-wide current media target and singular screencast state.

---
status: accepted
---

# Persist browser mode and resolve launch capabilities

Aperture will persist `browser.mode` as immutable session intent with `headed` and `headless` values. Browser mode is independent of browser channel, GPU policy, live-view transport, and Weston's backend. Each session launch resolves one capability-driven launch plan from the persisted browser choices and current deployment support; the API, wrapper, and routing consume that plan instead of deriving behavior from global media-mode checks.

## Context

The deployment-wide `webrtc_media_mode` currently controls compositor startup, the WebRTC producer, and the media state reported for every session. Chromium headless execution can instead enter through channel defaults such as `--headless=new`. Those two controls allow stored session state, Chromium launch behavior, and reported media behavior to disagree.

Browser channels identify trusted Chromium executables and their deployment defaults. Snapshots retain profile files. Neither concept should own whether a session launches Chromium headed or headless. Weston's `headless` backend is also unrelated to Chromium headless execution.

## Decision

Session creation and responses use one nested browser object:

```json
{
  "browser": {
    "channel": "chromium",
    "mode": "headless",
    "args": []
  }
}
```

`browser.mode` may be omitted at creation, in which case Aperture persists `headed`. It cannot change during the session's lifetime. Suspend, wake, delete, and reopen preserve it. Snapshot creation does not copy browser mode into the snapshot, and creating a session from any snapshot chooses a new browser mode.

Aperture owns Chromium's headless launch argument. Channel defaults and caller arguments cannot contain any `--headless` form. `headed` launches Chromium through Aperture's compositor. `headless` launches Chromium with Aperture-owned `--headless=new` and no compositor. Existing session rows are backfilled as `headed` without inferring previous channel or deployment behavior.

GPU policy remains deployment-owned and independent of browser mode. Headless execution does not imply `--disable-gpu`.

`browser.args` remains a persisted advanced launch override and is not part of browser configuration identity. Aperture rejects channel defaults and caller arguments in every category that can change supervisor-owned behavior or an advertised capability. These categories include browser mode, profile mode, required extensions, CDP, managed storage, display and compositor integration, and GPU policy. Accepted overrides may change Chromium or page behavior but cannot change Aperture capabilities.

The deployment explicitly lists allowed browser modes. Aperture combines those modes with configured browser channels, removes combinations it cannot realize, and returns the remaining concrete choices from `GET /api/browser/configurations`. The MCP equivalent is `browser.configurations`. These replace the channel-only endpoint and tool. A configuration is the typed channel and browser-mode pair, not an opaque profile name or an arbitrary argument vector.

Each returned browser configuration includes the capabilities a new session would receive. Configuration discovery and session responses use the same typed capability schema and include only configuration-dependent behavior. Session-specific connection URLs, tokens, ICE servers, and credentials remain separate connection data.

Live-view capability contains transports in preference order. A headed configuration can advertise `webrtc` followed by `cdp`; a headless configuration advertises only `cdp`. Traefik renders a WebRTC signaling route for a retained session only when its active or prospective capabilities contain the WebRTC transport. A headless session has no WebRTC route.

Recording capability reports its mechanism, observable capture scope, recording modes, audio support, valid codec and media-type pairs, concurrency limit, and supported mechanism-specific options. Each browser configuration has at most one recording mechanism. Aperture never silently changes recording mechanism while starting or running a recording.

Capabilities are not persisted. A session response labels them `active` when they come from its running launch plan, `prospective` when the retained session's persisted browser choices can resolve against current deployment support, and `unavailable` when those choices cannot resolve. Suspended, deleted, and failed sessions can therefore report what a wake or reopen would provide without claiming an active runtime. Connection data remains the authority for routes and credentials that can reach or wake a retained session.

Create, wake, and reopen resolve a fresh launch plan. They may fail even after a prospective response because deployment support can change between the read and the operation. Optional capabilities such as WebRTC, recording codecs, and concurrency may change between launches while browser mode remains fixed.

One resolved launch plan controls browser arguments, compositor and WebRTC processes, wrapper behavior, routes, required Aperture extensions, runtime isolation, and operation capabilities. Subsystems do not inspect `browser.mode` or deployment flags independently.

Every running session retains the wrapper as its gateway for CDP, activity, targets, viewport, recordings, files, and uploads. Both browser modes enforce ADR 0002's one-user-page-target-per-managed-window invariant with the bundled Aperture extension. A compositor-backed target becomes ready after the registry joins its CDP, Chromium window, Wayland surface, and capture identities. A headless target becomes ready after the extension settles and the wrapper verifies its distinct Chromium window; it has no Wayland surface or capture identity. Profile-installed extensions run in both browser modes; Aperture force-loads only extensions required by the resolved launch plan.

Headed and headless targets share one deployment default viewport. Viewport remains target-scoped as decided by ADR 0002 and lasts for the target's process lifetime. Downloads, uploads, session files, snapshots, and lifecycle operations keep the same contracts in both modes.

Headless sessions use a dedicated sandbox profile. It exposes no host display, Wayland socket, desktop D-Bus, or audio server. It retains the browser sandbox's read-only system mounts, adds explicit session and configured-extension paths, and exposes only the selected GPU devices when hardware acceleration is active. Local and container runners implement the same public browser configurations; runner type is not a client-selectable dimension.

`webrtc_media_mode` is removed. Deployment support, persisted browser choices, and resolved capabilities replace it.

## Considered options

- Making headless execution a browser channel property would conflate the Chromium distribution with session execution and let changed channel defaults alter a retained session.
- Persisting an execution-profile name would make retained sessions depend on a mutable deployment object and hide the actual browser choices.
- Treating arbitrary launch overrides as a configuration dimension would make configuration discovery impossible to enumerate.
- Replacing launch overrides with an allowlist of named presets would make capabilities exact but remove useful Chromium customization that does not conflict with Aperture.
- Keeping only the current narrow denylist would let callers change browser mode, profile behavior, required extensions, and other capability assumptions behind the resolver.
- Deriving browser mode on every launch would let the same retained session change between headed and headless execution.
- Persisting every capability would make routine deployment and codec changes block session wake and reopen.
- Omitting capabilities outside a running session would force clients to reconstruct launchability by joining the session's persisted browser choices to configuration discovery.
- Returning the last launch's capabilities after stop would present stale support as current support.
- Letting each subsystem derive behavior would preserve the contradictory global checks this decision removes.
- Advertising routes instead of capabilities would require clients to probe failures and would make an absent WebRTC route indistinguishable from a broken one.

## Consequences

- Browser mode needs a persisted session column, API fields, migration, and launch validation.
- Existing sessions become headed even if a previous channel default launched them headless.
- Operators must remove headless and conflicting GPU flags from channel defaults and session arguments.
- Operators and callers must also remove profile, extension, CDP, storage, and display flags that conflict with Aperture-owned behavior.
- Browser configuration discovery becomes a matrix of valid typed combinations and their prospective capabilities.
- Session capability responses can change after wake or reopen while browser mode remains fixed.
- A prospective capability response can become unavailable before wake or reopen; launch always revalidates it.
- Headless sessions avoid compositor, PipeWire, WebRTC producer, and host desktop runtime costs, but retain the window-enforcement extension.
- Capability resolution becomes the single input for session APIs, wrapper runtime, and Traefik routing.

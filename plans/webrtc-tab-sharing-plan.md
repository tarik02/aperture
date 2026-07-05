# WebRTC tab sharing plan

## Scope

Use a Chromium MV3 extension with an offscreen document as the first-choice tab
video producer. Keep CDP for tab state, navigation, viewport emulation, input,
clipboard, and the existing API CDP proxy. Keep CDP screencast as the fallback
media path whenever WebRTC cannot produce a live video track.

Go remains the coordinator. It owns auth, session lookup, lifecycle, per-session
runtime files, signaling, and feature state. It must not become a video encoder
or long-term media relay in this plan.

Do not add new tests for this work. Use existing checks, type checks, builds,
and live validation against an already running service. Do not start the dev
server.

## Hard constraints

- WebRTC replaces only the primary frame transport.
- CDP stays the source of truth for browser targets and all control messages.
- The UI must be usable through CDP screencast when WebRTC fails.
- WebRTC work stays behind a disabled-by-default or auto-fallback feature path
  until the full validation set passes.
- The extension must not require a human to click the Chrome toolbar in the
  controlled browser. Aperture can drive browser state through its own UI and
  CDP, but the remote-control workflow cannot depend on manual browser chrome
  actions.
- Extension credentials must be per session, short lived, and scoped to WebRTC
  signaling only.
- Public CDP compatibility must not regress.

## Bailout rules

Stop the WebRTC path and keep CDP screencast as the only shipped media transport
if any of these blockers holds after the named validation stage:

- `chrome.tabCapture` cannot start from an Aperture-controlled flow without a
  manual Chrome toolbar action.
- The extension cannot capture the active target selected by CDP with reliable
  tab switching.
- The launched Chromium channel refuses the bundled extension or offscreen
  document under the session wrapper.
- ICE cannot connect for the deployment shape Aperture needs, and the project is
  not ready to run or configure TURN.
- The fallback path cannot switch from WebRTC failure to CDP screencast without
  losing input control or leaving stale capture state.
- The extension credential model would expose API tokens or session CDP tokens
  to captured pages.

When a bailout happens, leave the codebase in one of two states: no WebRTC code
merged, or WebRTC disabled by config with CDP screencast still default.

## Stage 1, capture proof

Goal: prove the extension can capture the tab Aperture wants before building
signaling or UI work.

Work:

- Create a minimal MV3 extension prototype outside the product path.
- Include `tabCapture` and `offscreen` permissions.
- Use a service worker to create one offscreen document.
- Use `chrome.tabCapture.getMediaStreamId()` in the service worker, then consume
  the stream ID with `getUserMedia()` inside the offscreen document.
- Use CDP to activate the target first, then capture the current active tab
  rather than trying to map CDP target IDs to extension tab IDs.
- Record capture state only in extension memory for the proof.

Validation:

- The supervised Chromium session loads the extension.
- Existing `/api/cdp/{sessionId}/json/version` and browser WebSocket control
  still work with the extension loaded.
- Capture starts from an Aperture-driven action, without a manual click on the
  Chrome extension action button.
- The offscreen document receives a live video track.
- The track survives same-tab navigation.
- Capture stops when the target tab closes.
- A target switch can stop the old capture and start a capture for the newly
  activated target.

Bail out if:

- Chrome requires a manual extension invocation that Aperture cannot trigger in
  a product-grade way.
- Capture only works for one tab and cannot follow the active CDP target.
- The offscreen document cannot be used in the launched Chromium channel.

## Stage 2, extension packaging contract

Goal: make extension loading deterministic for one session without wiring media
yet.

Work:

- Add a packaged extension template to the browser wrapper assets.
- Generate a per-session extension directory during runtime preparation.
- Write a generated config file into that directory containing only:
  - session id
  - local signaling URL
  - one per-session extension signaling token
  - feature flags needed by the extension
- Load only the generated extension directory through supervisor-owned Chromium
  args.
- Keep arbitrary user browser args blocked from changing extension loading.
- Remove the generated extension directory on session expiry.

Validation:

- Extension ID is stable across session starts for the same packaged extension.
- Per-session generated config changes do not invalidate extension loading.
- The extension can read its config and connect to a local coordinator endpoint.
- Session create, reopen, delete, and expire still clean up runtime files.
- Existing CDP routes and Traefik reconciliation output stay unchanged unless a
  later stage explicitly adds WebRTC routes.

Bail out if:

- Extension identity changes across builds or sessions in a way that breaks
  extension messaging or storage.
- Chromium blocks the unpacked extension in the supported package/channel setup.
- Runtime cleanup cannot reliably remove session-scoped extension secrets.

## Stage 3, signaling coordinator

Goal: add signaling without media risk.

Work:

- Add an authenticated signaling WebSocket under the API, for example
  `/api/webrtc/{sessionId}/signal`.
- Support two roles:
  - `producer`, the session extension.
  - `viewer`, the Aperture web UI.
- Authenticate viewers with normal API auth and `sessions:write`.
- Authenticate producers with the generated extension signaling token only.
- Route SDP offers, SDP answers, ICE candidates, selected target id, and producer
  health through Go.
- Track producer presence in memory. Do not persist SDP or ICE candidates.
- Limit one active producer per running session.
- Allow multiple viewers only after single-viewer validation passes.

Validation:

- Unauthorized viewers cannot open signaling.
- A producer token for one session cannot signal for another session.
- Producer disconnect removes producer presence.
- Viewer disconnect does not stop the browser session.
- Signaling messages are bounded in size and rejected if malformed.
- Existing session create, delete, reopen, token rotation, and CDP proxy behavior
  still work.

Bail out if:

- The extension cannot authenticate without exposing normal API or CDP tokens.
- Signaling state leaks across tenants or sessions.
- The coordinator needs to inspect or modify encoded media to make the design
  work.

## Stage 4, WebRTC media path

Goal: stream captured tab video from the extension to the UI.

Work:

- In the offscreen document, create an `RTCPeerConnection`.
- Add the captured video track with `addTrack`.
- Keep audio out of the first implementation unless product requirements change.
- Use a data channel for producer health and media metadata only, not browser
  input.
- Send stream status from extension to Go:
  - `idle`
  - `capturing`
  - `negotiating`
  - `connected`
  - `failed`
- Include failure codes that map directly to fallback decisions.
- Keep CDP screencast idle while WebRTC is healthy.

Validation:

- A UI viewer receives a remote video track.
- `connectionState` reaches `connected`.
- First decoded frame appears in the UI within an agreed timeout.
- Frame dimensions match the current emulated viewport closely enough for input
  coordinate mapping.
- Target switch tears down the old video track and starts the new one.
- Navigation does not require a new browser session or UI reconnect.
- Closing the UI closes only the viewer peer connection.
- Stopping or deleting the session closes producer capture and peer connections.

Bail out if:

- ICE fails in the target deployment and there is no accepted TURN plan.
- Video dimensions cannot be aligned with CDP viewport/input coordinates.
- Target switching leaves stale tracks or leaks capture state.

## Stage 5, frontend dual media

Goal: make WebRTC primary in auto mode while CDP screencast remains the fallback.

Work:

- Keep the current CDP control connection for targets, navigation, viewport,
  input, and clipboard.
- Add a separate media connection state machine:
  - `cdp`
  - `webrtc-connecting`
  - `webrtc-live`
  - `webrtc-failed`
  - `fallback-cdp`
- Render WebRTC with a `<video>` element.
- Render CDP screencast with the existing frame path.
- Preserve the same pointer and keyboard coordinate mapping for both media
  paths.
- Start CDP screencast automatically if WebRTC fails before first frame.
- Switch to CDP screencast if WebRTC disconnects after becoming live.
- Retry WebRTC only on explicit reconnect, target switch, or bounded background
  retry.

Validation:

- With WebRTC disabled, behavior matches the current CDP screencast path.
- With extension unavailable, the UI falls back to CDP screencast without user
  action.
- With ICE failure, fallback happens within the timeout and input still works.
- With WebRTC live, CDP screencast is not running.
- Target switch works in both WebRTC and fallback modes.
- Browser toolbar, tab strip, viewport presets, mouse, wheel, keyboard,
  clipboard paste, reload, and navigation still use CDP.

Bail out if:

- Fallback is visibly unreliable or leaves the user with no media.
- Dual media state makes input target selection ambiguous.
- WebRTC retry loops create repeated capture prompts, repeated extension errors,
  or excessive signaling churn.

## Stage 6, lifecycle and cleanup

Goal: make the new media path behave like a session resource.

Work:

- Start the producer only for running sessions.
- Stop capture when the session stops, deletes, expires, or reopens.
- Clear producer presence on browser unit failure.
- Close peer connections before removing runtime files.
- Make reconnect idempotent from the UI and extension.
- Keep session lease semantics unchanged. Raw media traffic must not extend
  leases unless the existing product decision changes.

Validation:

- Session delete stops capture and removes generated extension secrets.
- Reopen creates a fresh producer token.
- Expiry removes generated extension files.
- Browser crash clears producer state.
- Go shutdown does not leave persistent secrets outside session runtime paths.
- Existing GC behavior still removes CDP token seals and session runtime state.

Bail out if:

- Capture can continue after the session is no longer running.
- A stale extension token can reconnect after delete, expiry, or reopen.
- Cleanup requires manual browser or profile intervention.

## Stage 7, security review gate

Goal: decide whether WebRTC can be enabled outside local development.

Review:

- Extension permissions are the minimum set needed for capture and signaling.
- Captured pages cannot read extension config or signaling tokens.
- Extension token cannot call normal API endpoints.
- Signaling rejects tenant/session mismatches.
- SDP and ICE candidate logging does not expose private network details unless
  debug logging is explicitly enabled.
- Public Traefik routes do not expose producer endpoints without auth.
- The fallback CDP path does not leak the session CDP token into the web UI.

Validation:

- Manual request attempts with wrong tenant, wrong session, and wrong producer
  token fail.
- Browser devtools on a captured page cannot access extension config.
- Logs contain session ids and failure codes, not bearer tokens or SDP bodies.

Bail out if:

- The extension requires broad host permissions without a narrow reason.
- Producer auth cannot be separated from user API auth.
- The browser page can read session-scoped extension secrets.

## Stage 8, rollout

Goal: ship gradually without breaking the existing workbench.

Work:

- Keep default media mode as `auto`.
- In `auto`, try WebRTC first only when the session advertises producer support.
- Fall back to CDP screencast on all WebRTC setup or health failures.
- Expose enough UI state to distinguish `webrtc-live` from `fallback-cdp`.
- Keep a config switch to force CDP screencast.
- Add operational notes to installation docs only after the feature survives the
  security gate.

Validation:

- Build output includes the extension assets.
- Go embed and packaging include the extension template.
- Production build works without a development server.
- A session can be controlled start to finish with WebRTC disabled.
- A session can be controlled start to finish with WebRTC live.
- A session can be controlled start to finish after WebRTC fails and fallback
  takes over.

Bail out if:

- Packaging cannot include the extension deterministically.
- WebRTC support changes the behavior of users who stay on CDP screencast.
- The operational setup requires undocumented external services.

## Open decisions

- Whether remote deployments need TURN on day one. If yes, add explicit TURN
  config before enabling WebRTC outside local networks.
- Whether audio capture is required. Leave it out until video is stable.
- Whether multiple simultaneous viewers matter for the first release.
- Whether the fallback retry policy should be manual-only or bounded automatic.
- Whether extension capture should run only for the active UI viewer or stay
  warm while a session workbench is open.

## References

- Chrome `tabCapture` API: https://developer.chrome.com/docs/extensions/reference/api/tabCapture
- Chrome `offscreen` API: https://developer.chrome.com/docs/extensions/reference/api/offscreen
- Chrome extension screen capture guide: https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture

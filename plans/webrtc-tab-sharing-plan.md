# WebRTC viewport streaming plan

## Scope

Use a nested compositor as the first-choice viewport video producer. Launch the
browser inside that compositor in kiosk/fullscreen mode, stream the compositor
viewport through PipeWire/WebRTC, and keep CDP for tab state, navigation,
viewport emulation, input, clipboard, and the existing API CDP proxy. Keep CDP
screencast as the fallback media path whenever the compositor/WebRTC path cannot
produce a live video track.

Go remains the coordinator. It owns auth, session lookup, lifecycle, per-session
runtime files, compositor/browser launch, signaling, and feature state. It must
not become a long-term media relay in this plan.

The earlier MV3 `tabCapture`/`desktopCapture` direction is superseded unless a
later stage proves the nested-compositor path is a blocker. The extension proof
remains useful only as a fallback research artifact.

Do not add new tests for this work. Use existing checks, type checks, builds,
and live validation against an already running service. Do not start the dev
server.

## Hard constraints

- WebRTC replaces only the primary frame transport.
- CDP stays the source of truth for browser targets and all control messages.
- The UI must be usable through CDP screencast when WebRTC fails.
- WebRTC work stays behind a disabled-by-default or auto-fallback feature path
  until the full validation set passes.
- The media path must not require a human to click browser or desktop chrome.
  Aperture can drive browser state through its own UI and CDP, but the
  remote-control workflow cannot depend on manual host UI actions.
- Media producer credentials must be per session, short lived, and scoped to
  WebRTC signaling only.
- Public CDP compatibility must not regress.
- Hardware acceleration must remain enabled for both the nested compositor and
  Chromium. Any path that silently falls back to SwiftShader/software
  compositing is a blocker for the primary media path.

## Validated pivot, 2026-07-05

Chrome capture API results:

- `chrome.tabCapture` from an extension/offscreen proof is blocked in the
  controlled flow by Chrome's activeTab invocation requirement.
- `chrome.desktopCapture(["tab"])` can be auto-selected with Chromium flags and
  produces a real `MediaStream`, but it still depends on picker-shaped browser
  capture behavior.
- `chrome.desktopCapture(["window"])` returned an empty stream id under the
  controlled window proof, so it is not a reliable route for decoration-free
  viewport capture.

Nested compositor results on `polygon`, without touching `aperture.service`:

- Weston headless backend with `--renderer=gl` starts on `/dev/dri/renderD128`
  with Mesa Intel UHD Graphics 730 and OpenGL ES 3.2.
- Weston kiosk shell removes desktop/browser decorations from the captured
  viewport.
- Chromium launched inside Weston with `--ozone-platform=wayland --kiosk`
  reports `innerWidth=960`, `innerHeight=720`, `outerWidth=960`,
  `outerHeight=720`, and `devicePixelRatio=1`.
- Chrome GPU status reports ANGLE on Intel UHD Graphics 730, GPU compositing
  enabled, OpenGL enabled, forced rasterization enabled, video decode enabled,
  WebGL enabled, WebGPU enabled, and Vulkan enabled.
- Weston PipeWire backend publishes a `weston.pipewire` node with
  `media.class = "Stream/Output/Video"`.
- GStreamer consumed that node through `pipewiresrc` and produced a 960x720 PNG
  frame. Pixel probes matched page content at the top border, left border, and
  body background, with no host desktop or browser chrome.

Current separate-deployment blocker:

- A fully independent second Aperture API deployment cannot safely create normal
  browser sessions yet because the sudo overlay helpers trust only
  `/etc/aperture/aperture.toml`. Until that is changed, compositor validation
  must use isolated user units/manual proof commands or a direct-mount proof
  harness rather than a second `aperture serve` that starts full sessions.

## Bailout rules

Stop the WebRTC path and keep CDP screencast as the only shipped media transport
if any of these blockers holds after the named validation stage:

- Weston, another nested compositor, or the selected capture backend cannot run
  per session without touching the host desktop or the main Aperture service.
- The compositor path cannot preserve hardware acceleration for Chromium.
- PipeWire or the selected frame source cannot produce a continuous exact-size
  viewport stream.
- ICE cannot connect for the deployment shape Aperture needs, and the project is
  not ready to run or configure TURN.
- The fallback path cannot switch from WebRTC failure to CDP screencast without
  losing input control or leaving stale capture state.
- The media credential model would expose API tokens or session CDP tokens to
  captured pages.

When a bailout happens, leave the codebase in one of two states: no compositor
WebRTC code merged, or compositor WebRTC disabled by config with CDP screencast
still default.

## Stage 1, compositor capture proof

Status: passed for the Weston headless/PipeWire proof on `polygon`.

Goal: prove a decoration-free compositor viewport can be produced and consumed
without Chrome capture APIs.

Work:

- Launch Weston per proof/session with a unique Wayland socket.
- Use `--backend=headless` for screenshot validation and `--backend=pipewire`
  for stream-source validation.
- Use `--renderer=gl` and reject software compositor fallback.
- Use `--shell=kiosk` to remove compositor shell decorations.
- Launch Chromium inside the nested Wayland socket with kiosk mode and CDP.
- Keep the proof outside the main `aperture.service` deployment.

Validation:

- Weston reports GL renderer on a render node.
- Chromium reports GPU compositing, OpenGL/WebGL, GPU rasterization, and video
  decode enabled.
- Chromium viewport and outer window dimensions match the compositor output.
- Captured frame dimensions match the requested viewport.
- Captured pixels prove page content reaches the output edges without host
  desktop, compositor panel, titlebar, or browser toolbar.
- GStreamer can consume the PipeWire node as `video/x-raw`.

Bail out if:

- Weston cannot start with GL renderer.
- Chromium falls back to SwiftShader/software compositing.
- Kiosk shell still leaves decorations in the captured frame.
- PipeWire cannot expose the compositor output as a consumable video node.

## Stage 2, isolated deployment contract

Status: in progress. The helper path now supports a supervisor-selected trusted
config file under `/etc/aperture`, which allows a proof deployment to use a
separate root-owned config without editing the main `/etc/aperture/aperture.toml`.

Goal: make the nested-compositor proof runnable through an isolated Aperture-like
deployment without touching `aperture.service`.

Work:

- Add support for a supervisor-selected trusted helper config path, or add a
  proof-only direct mount path that does not use sudo.
- Install separate user units for proof deployment, for example:
  - `aperture-webrtc-proof.service`
  - `browser-session-webrtc-proof@.service`
- Use separate listen address, runtime root, store root, database path, dynamic
  config path, and browser unit template.
- Ensure the main `aperture.service`, `browser-session@.service`, and
  `/etc/aperture/aperture.toml` are not modified during validation.
- Add explicit runtime cleanup for nested compositor sockets, PipeWire nodes,
  browser profile, and media helper processes.

Validation:

- Main Aperture remains active and unchanged before, during, and after the proof.
- The proof service can create and delete a session using only proof roots and
  proof units.
- Sudo/helper config trust does not allow an unprivileged user to redirect
  privileged overlay mounts to arbitrary paths.
- CDP for proof sessions remains reachable on the proof deployment only.
- Stopping the proof service stops Weston, Chromium, PipeWire consumers, and
  browser units.

Bail out if:

- A second deployment requires editing the main config or main user units.
- Helper trust cannot be separated safely.
- Proof cleanup can leave privileged mounts, browser units, or compositor
  processes behind.

## Stage 3, compositor session wrapper

Status: passed for an isolated manual wrapper proof on `polygon`, 2026-07-05.

Goal: make the browser wrapper own the nested compositor and Chromium lifecycle.

Work:

- Extend `browser-session-wrapper` with a gated nested-compositor mode.
- Generate a unique Wayland socket name per session.
- Start Weston before Chromium and wait for the socket.
- Pass only the nested Wayland socket to Chromium.
- Keep `/dev/dri/renderD*` and required Wayland/PipeWire runtime access
  available in the sandbox.
- Stop both Chromium and Weston on unit stop.
- Preserve the existing direct Chromium launch path when compositor mode is off.

Validation:

- Existing sessions still launch without compositor mode.
- Compositor-mode sessions launch Chromium, expose CDP, and stop cleanly.
- Weston and Chromium both report hardware acceleration.
- The nested viewport dimensions match the requested session viewport.
- Session delete and expiry remove sockets and runtime files.
- The wrapper binds render nodes and read-only sysfs into bwrap. Without sysfs,
  Chromium can see the render device but still falls back to llvmpipe because
  libdrm cannot enumerate DRM devices.
- In compositor mode, bwrap mounts only the generated nested Wayland socket
  from `XDG_RUNTIME_DIR`, plus the GL driver path needed for hardware
  acceleration. It does not mount the whole host runtime directory.
- Compositor mode fails before Chromium launch if render nodes or sysfs are
  unavailable, or if renderer/shell config tries to move away from `gl` and
  `kiosk`.
- Compositor mode rejects Chromium args that disable GPU/compositing, force
  headless mode, or override compositor-owned display flags.
- Manual proof details:
  - Weston `pipewire` backend started with `--renderer=gl`, kiosk shell, and a
    unique `aperture-<session>` Wayland socket.
  - Weston reported `/dev/dri/renderD128`, Mesa Intel UHD Graphics 730, and
    OpenGL ES 3.2.
  - Chromium exposed CDP on the proof-only port and reported ANGLE on Intel UHD,
    GPU compositing enabled, OpenGL/WebGL/WebGPU enabled, video decode enabled,
    Vulkan enabled, and forced rasterization.
  - Chromium reported `innerWidth=960`, `innerHeight=720`, `outerWidth=960`,
    `outerHeight=720`, and `devicePixelRatio=1`.
  - PipeWire exposed `weston.pipewire` while the proof ran.
  - `SIGTERM` to the wrapper stopped Chromium and Weston, removed the Wayland
    socket, and removed the `weston.pipewire` node.
  - Main `aperture.service` remained active, and the proof browser unit remained
    inactive.
- The manual proof had to prepend the Nix bubblewrap store path to `PATH`.
  A proof user unit or package wrapper must provide `bwrap` on `PATH` before
  Stage 2 can be called complete.

Bail out if:

- The wrapper cannot supervise both processes reliably under systemd.
- The sandbox cannot preserve GPU/PipeWire access without weakening isolation
  too broadly.
- Non-compositor sessions regress.

## Stage 4, PipeWire media producer

Status: passed for a gated GStreamer VP8/RTP producer proof on `polygon`,
2026-07-05. This stage proves capture and encoding, not viewer signaling.

Goal: turn the compositor PipeWire node into a WebRTC video source.

Work:

- Start a per-session media producer after Weston publishes its PipeWire node.
- Consume `weston.pipewire` with GStreamer or an equivalent proven media stack.
- Encode video for WebRTC without routing raw frames through Go.
- Keep audio out of the first implementation unless product requirements
  change.
- Report media health and frame metadata to Go:
  - `idle`
  - `starting`
  - `streaming`
  - `negotiating`
  - `connected`
  - `failed`
- Include failure codes that map directly to fallback decisions.
- Stage 4 implementation boundary:
  - The wrapper can optionally supervise an external `gst-launch-1.0` producer
    after Chromium starts.
  - The producer consumes `weston.pipewire`, converts the exact-size raw frame,
    encodes VP8, payloads it as RTP, and sends it to `fakesink`.
  - Go supervises process lifecycle only. It does not read raw frames or encoded
    media.
  - Actual `webrtcbin` signaling and peer connection setup remain Stage 5 and
    Stage 6 work.

Validation:

- Producer receives exact-size frames from PipeWire.
- First encoded frame is available within an agreed timeout.
- CPU and GPU usage are acceptable for one session.
- Producer exits when Weston or Chromium exits.
- CDP screencast remains idle while WebRTC is healthy.
- Manual proof details:
  - GStreamer negotiated `video/x-raw` at 960x720 from `pipewiresrc
    target-object=weston.pipewire`.
  - The pipeline produced `video/x-vp8` at 960x720 and `application/x-rtp` with
    `encoding-name=VP8`.
  - Chrome remained on ANGLE Intel UHD with GPU compositing, OpenGL, GPU
    rasterization, video decode, WebGL, and WebGPU enabled while the producer
    ran.
  - `SIGTERM` to the wrapper stopped GStreamer, Chromium, Weston, removed the
    Wayland socket, and removed the `weston.pipewire` node.
  - Main `aperture.service` remained active, and the proof browser unit remained
    inactive.

Bail out if:

- PipeWire output cannot be consumed continuously.
- Encoding requires Go to act as a long-term media relay.
- Frame dimensions cannot be aligned with CDP input coordinates.

## Stage 5, signaling coordinator

Goal: add signaling without media risk.

Work:

- Add an authenticated signaling WebSocket under the API, for example
  `/api/webrtc/{sessionId}/signal`.
- Support two roles:
  - `producer`, the per-session media producer.
  - `viewer`, the Aperture web UI.
- Authenticate viewers with normal API auth and `sessions:write`.
- Authenticate producers with a generated per-session media token only.
- Route SDP offers, SDP answers, ICE candidates, viewport metadata, and producer
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

- The producer cannot authenticate without exposing normal API or CDP tokens.
- Signaling state leaks across tenants or sessions.
- The coordinator needs to inspect or modify encoded media to make the design
  work.

## Stage 6, WebRTC media path

Goal: stream the compositor viewport from the media producer to the UI.

Work:

- In the media producer, create an `RTCPeerConnection` or equivalent proven
  WebRTC sender.
- Add the PipeWire compositor video source as the only first-stage track.
- Keep audio out of the first implementation unless product requirements change.
- Use a data channel for producer health and media metadata only, not browser
  input.
- Send stream status from producer to Go:
  - `idle`
  - `starting`
  - `streaming`
  - `negotiating`
  - `connected`
  - `failed`
- Include failure codes that map directly to fallback decisions.
- Keep CDP screencast idle while WebRTC is healthy.

Validation:

- A UI viewer receives a remote video track.
- `connectionState` reaches `connected`.
- First decoded frame appears in the UI within an agreed timeout.
- Frame dimensions exactly match the compositor viewport.
- Browser navigation does not require a new browser session or UI reconnect.
- Closing the UI closes only the viewer peer connection.
- Stopping or deleting the session closes producer capture and peer connections.

Bail out if:

- ICE fails in the target deployment and there is no accepted TURN plan.
- Video dimensions cannot be aligned with CDP viewport/input coordinates.
- Producer restarts leave stale tracks or leak capture state.

## Stage 7, frontend dual media

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
- With compositor or producer unavailable, the UI falls back to CDP screencast
  without user action.
- With ICE failure, fallback happens within the timeout and input still works.
- With WebRTC live, CDP screencast is not running.
- Target switch works in both WebRTC and fallback modes.
- Browser toolbar, tab strip, viewport presets, mouse, wheel, keyboard,
  clipboard paste, reload, and navigation still use CDP.

Bail out if:

- Fallback is visibly unreliable or leaves the user with no media.
- Dual media state makes input target selection ambiguous.
- WebRTC retry loops create repeated producer restarts or excessive signaling
  churn.

## Stage 8, lifecycle and cleanup

Goal: make the new media path behave like a session resource.

Work:

- Start the producer only for running sessions.
- Stop compositor capture when the session stops, deletes, expires, or reopens.
- Clear producer presence on browser unit failure.
- Close peer connections before removing runtime files.
- Make reconnect idempotent from the UI and media producer.
- Keep session lease semantics unchanged. Raw media traffic must not extend
  leases unless the existing product decision changes.

Validation:

- Session delete stops capture and removes generated media secrets.
- Reopen creates a fresh producer token.
- Expiry removes generated media runtime files.
- Browser crash clears producer state.
- Go shutdown does not leave persistent secrets outside session runtime paths.
- Existing GC behavior still removes CDP token seals and session runtime state.

Bail out if:

- Capture can continue after the session is no longer running.
- A stale producer token can reconnect after delete, expiry, or reopen.
- Cleanup requires manual browser or profile intervention.

## Stage 9, security review gate

Goal: decide whether WebRTC can be enabled outside local development.

Review:

- The compositor, PipeWire, and media producer run with minimum practical access.
- Captured pages cannot read media config or signaling tokens.
- Producer token cannot call normal API endpoints.
- Signaling rejects tenant/session mismatches.
- SDP and ICE candidate logging does not expose private network details unless
  debug logging is explicitly enabled.
- Public Traefik routes do not expose producer endpoints without auth.
- The fallback CDP path does not leak the session CDP token into the web UI.
- GPU, render-node, PipeWire, and runtime-directory sandbox bindings are scoped
  narrowly enough for the deployment model.

Validation:

- Manual request attempts with wrong tenant, wrong session, and wrong producer
  token fail.
- Browser devtools on a captured page cannot access media config.
- Logs contain session ids and failure codes, not bearer tokens or SDP bodies.

Bail out if:

- The compositor/media producer requires broad host permissions without a narrow
  reason.
- Producer auth cannot be separated from user API auth.
- The browser page can read session-scoped media secrets.

## Stage 10, rollout

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

- Build output includes the compositor/media producer dependencies.
- Packaging includes Weston and the selected PipeWire/WebRTC media stack.
- Production build works without a development server.
- A session can be controlled start to finish with WebRTC disabled.
- A session can be controlled start to finish with WebRTC live.
- A session can be controlled start to finish after WebRTC fails and fallback
  takes over.

Bail out if:

- Packaging cannot include the compositor/media stack deterministically.
- WebRTC support changes the behavior of users who stay on CDP screencast.
- The operational setup requires undocumented external services.

## Open decisions

- Whether remote deployments need TURN on day one. If yes, add explicit TURN
  config before enabling WebRTC outside local networks.
- Whether audio capture is required. Leave it out until video is stable.
- Whether multiple simultaneous viewers matter for the first release.
- Whether the fallback retry policy should be manual-only or bounded automatic.
- Whether the media producer should run only for the active UI viewer or stay
  warm while a session workbench is open.
- Whether to use GStreamer `webrtcbin`, a WHIP-compatible sender, or another
  proven WebRTC sender around the PipeWire source.
- Whether hardware video encode is required for the first rollout, or whether
  preserving compositor/browser GPU acceleration is enough for the first gated
  proof.

## References

- Chrome `tabCapture` API: https://developer.chrome.com/docs/extensions/reference/api/tabCapture
- Chrome `offscreen` API: https://developer.chrome.com/docs/extensions/reference/api/offscreen
- Chrome extension screen capture guide: https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture
- Weston `headless`, `pipewire`, and `vnc` backends: `weston --help`
- Weston VNC backend details: `man weston-vnc`
- GStreamer PipeWire source: `gst-inspect-1.0 pipewiresrc`

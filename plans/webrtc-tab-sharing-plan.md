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

Status: passed for the authenticated coordinator implementation after local
validation and review. This stage does not add the WebRTC sender or UI viewer
media path.

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
- Stage 5 implementation boundary:
  - Go owns signaling auth, session lookup, room membership, bounded message
    relay, and producer-token lifecycle.
  - Producer tokens are generated only when the media producer is enabled,
    stored as hashes under the session runtime root, passed to the wrapper via
    the runtime environment, and removed on delete, expiry, failed start, and
    failed reopen.
  - Chromium is launched through `bwrap --clearenv` with an empty bwrap process
    environment plus explicit browser `--setenv` entries, so wrapper secrets are
    not inherited by the browser.
  - Viewer peers use normal API auth plus `sessions:write`; producer peers use
    only the per-session media token.
  - The coordinator accepts one producer and one viewer per session, relays only
    known message types with object payloads, and does not persist SDP or ICE.
  - WebRTC peer creation, ICE connectivity, and decoded video validation remain
    Stage 6 work.

Validation:

- Unauthorized viewers cannot open signaling.
- A producer token for one session cannot signal for another session.
- Producer disconnect removes producer presence.
- Viewer disconnect does not stop the browser session.
- Signaling messages are bounded in size and rejected if malformed.
- Existing session create, delete, reopen, token rotation, and CDP proxy behavior
  still work.
- Local validation:
  - `mise x go@latest -- go test ./...`
  - `git diff --check`
  - `mise x go@latest -- go build ./cmd/aperture ./cmd/browser-session-wrapper`

Bail out if:

- The producer cannot authenticate without exposing normal API or CDP tokens.
- Signaling state leaks across tenants or sessions.
- The coordinator needs to inspect or modify encoded media to make the design
  work.

## Stage 6, WebRTC media path

Status: passed for the producer sender implementation after local validation,
package validation, and review. Live browser viewer decode remains a Stage 7
UI integration validation item.

Goal: stream the compositor viewport from the media producer to the UI.

Work:

- In the media producer, create an `RTCPeerConnection` with Pion.
- Keep GStreamer as the PipeWire capture, colorspace conversion, VP8 encode,
  and RTP payload stack.
- Forward encoded RTP packets from a local UDP socket into a
  `TrackLocalStaticRTP`; do not route raw frames through Go.
- Add the PipeWire compositor video source as the only first-stage track.
- Keep audio out of the first implementation unless product requirements change.
- Keep producer health and viewport metadata on the signaling channel for the
  first sender implementation; do not put browser input on WebRTC data channels.
- Have viewers send `viewer-ready` after their peer connection is prepared, so
  producer offers are not dropped before a viewer exists.
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
- Local validation so far:
  - `mise x go@latest -- go test ./...`
  - `git diff --check`
  - `mise x go@latest -- go build ./cmd/aperture ./cmd/browser-session-wrapper ./cmd/webrtc-media-producer`
  - `nix build .#aperture`

Bail out if:

- ICE fails in the target deployment and there is no accepted TURN plan.
- Video dimensions cannot be aligned with CDP viewport/input coordinates.
- Producer restarts leave stale tracks or leak capture state.

## Stage 7, frontend dual media

Status: passed after local validation and review.

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
- Stage 7 implementation boundary:
  - The UI keeps the existing CDP control socket for all browser state and
    input.
  - A separate viewer signaling socket negotiates a WebRTC video track after
    CDP connects.
  - The viewport renders WebRTC video when the peer connection is live.
  - CDP screencast starts automatically when WebRTC fails or times out.
  - CDP screencast stops when WebRTC becomes live.
  - The first UI integration attempts WebRTC whenever the workbench has a
    session and API credentials. A producer capability signal remains a Stage
    10 rollout item.

Validation:

- With WebRTC disabled, behavior matches the current CDP screencast path.
- With compositor or producer unavailable, the UI falls back to CDP screencast
  without user action.
- With ICE failure, fallback happens within the timeout and input still works.
- With WebRTC live, CDP screencast is not running.
- Target switch works in both WebRTC and fallback modes.
- Browser toolbar, tab strip, viewport presets, mouse, wheel, keyboard,
  clipboard paste, reload, and navigation still use CDP.
- Local validation:
  - `git diff --check`
  - `mise x node@22.18.0 pnpm@11.9.0 -- pnpm --filter @aperture/web format:check`
  - `mise x node@22.18.0 pnpm@11.9.0 -- pnpm --filter @aperture/web typecheck`
  - `mise x node@22.18.0 pnpm@11.9.0 -- pnpm --filter @aperture/web build`

Bail out if:

- Fallback is visibly unreliable or leaves the user with no media.
- Dual media state makes input target selection ambiguous.
- WebRTC retry loops create repeated producer restarts or excessive signaling
  churn.

## Stage 8, lifecycle and cleanup

Status: passed after local lifecycle implementation and validation.

Goal: make the new media path behave like a session resource.

Work:

- Start the producer only for running sessions.
- Stop compositor capture when the session stops, deletes, expires, or reopens.
- Clear producer presence on browser unit failure.
- Close peer connections before removing runtime files.
- Make reconnect idempotent from the UI and media producer.
- Keep session lease semantics unchanged. Raw media traffic must not extend
  leases unless the existing product decision changes.
- Stage 8 implementation boundary:
  - The app now owns one signaling coordinator and wires it into session and GC
    cleanup.
  - Session delete, startup reconciliation failure, browser-unit failure,
    orphan runtime cleanup, stale runtime cleanup, reopen, and GC expiry revoke
    the media producer token hash, close the signaling room, and then remove
    runtime env files.
  - Create and reopen mark the DB row running before starting the browser unit,
    so the wrapper-started producer can authenticate only against a running
    session.
  - Reopen first revokes stale producer auth, closes signaling, stops any stale
    browser unit, and removes stale runtime env before creating the next media
    token.
  - The signaling coordinator replaces same-role stale producer/viewer sockets
    idempotently and ignores relays from replaced peers.
  - The media producer restarts its active peer cleanly on each `viewer-ready`,
    so a reconnect receives a fresh offer instead of reusing stale peer state.

Validation:

- Session delete stops capture and removes generated media secrets.
- Reopen creates a fresh producer token.
- Expiry removes generated media runtime files.
- Browser crash clears producer state.
- Go shutdown does not leave persistent secrets outside session runtime paths.
- Existing GC behavior still removes CDP token seals and session runtime state.
- Local validation:
  - `git diff --check`
  - `mise x go@latest -- go test ./...`
  - `mise x go@latest -- go build ./cmd/aperture ./cmd/browser-session-wrapper ./cmd/webrtc-media-producer`

Bail out if:

- Capture can continue after the session is no longer running.
- A stale producer token can reconnect after delete, expiry, or reopen.
- Cleanup requires manual browser or profile intervention.
- Bailout notes:
  - No bailout triggered in local validation.
  - Live compositor validation was not run in this stage because the existing
    service/dev server must not be started from this worktree.

## Stage 9, security review gate

Status: passed for local security review, narrow hardening, and build
validation on 2026-07-05. Live negative request probes and browser-devtools
inspection were not run from this worktree because the existing service/dev
server must not be started here.

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
- Stage 9 implementation/review boundary:
  - No new host permissions, service units, TURN config, rollout defaults, or
    deployment docs were added.
  - Producer auth remains separate from normal API auth: producers authenticate
    only through the per-session `media_` token hash under the runtime root,
    while normal API endpoints continue to require `apt_` API tokens and
    scopes.
  - WebRTC signaling now requires the `aperture-webrtc.v1` WebSocket
    subprotocol before accepting the socket.
  - The coordinator now validates signaling direction by role: producers may
    send SDP offers, ICE candidates, producer health, and viewport metadata;
    viewers may send viewer-ready, SDP answers, and ICE candidates.
  - Producer health payloads now allow only stable status/code fields, and the
    media producer reports failure codes instead of raw SDP, ICE, network, or
    process error strings.
  - Browser launch still uses `bwrap --clearenv`; compositor mode still binds
    only the generated nested Wayland socket from `XDG_RUNTIME_DIR` into the
    browser sandbox, plus the existing scoped GPU/sysfs bindings needed for
    hardware acceleration.
  - Media token hashes and runtime env files remain `0600` under the session
    runtime root, and the browser process does not receive the media producer
    token, signaling URL, or wrapper environment.
  - The workbench CDP fallback path continues to use `/api/cdp` with normal API
    auth, not the session CDP bearer token. The separate connection panel still
    intentionally displays CDP credentials after create/reopen/rotate for
    external CDP clients.
  - Public Traefik routing continues to send `/api` to the API service and CDP
    paths through CDP forward-auth; there is no direct unauthenticated producer
    route.

Validation:

- Live validation to run against an already-running deployment:
  - Manual request attempts with wrong tenant, wrong session, and wrong producer
    token fail.
  - Browser devtools on a captured page cannot access media config.
  - Logs contain session ids and failure codes, not bearer tokens or SDP bodies.
- Local validation:
  - `git diff --check`
  - `mise x go@latest -- go test ./...`
  - `mise x go@latest -- go build ./cmd/aperture ./cmd/browser-session-wrapper ./cmd/webrtc-media-producer`
  - `nix build .#aperture` was not run because packaging files were not
    changed.
  - Web format/type/build checks were not run because web files were not
    changed.

Bail out if:

- The compositor/media producer requires broad host permissions without a narrow
  reason.
- Producer auth cannot be separated from user API auth.
- The browser page can read session-scoped media secrets.
- Bailout notes:
  - No bailout triggered in local review or validation.
  - Keep WebRTC disabled and use CDP fallback if a deployment moves the session
    runtime root into a path mounted into the browser sandbox or otherwise makes
    media/signaling secrets readable by captured pages.

## Stage 10, rollout

Status: implemented locally after validation on 2026-07-05. Live session
validation was not run from this worktree because the existing service/dev
server must not be started here.

Goal: ship gradually without breaking the existing workbench.

Work:

- Keep default media mode as `auto`.
- In `auto`, try WebRTC first only when the session advertises producer support.
- Fall back to CDP screencast on all WebRTC setup or health failures.
- Expose enough UI state to distinguish `webrtc-live` from `fallback-cdp`.
- Keep a config switch to force CDP screencast.
- Add operational notes to installation docs only after the feature survives the
  security gate.
- Stage 10 implementation boundary:
  - Added `webrtc_media_mode` with default `auto` and allowed values `auto` and
    `cdp`.
  - In `cdp` mode, session runtime generation disables the compositor and media
    producer path, does not mint producer credentials, and keeps the existing
    direct Chromium/CDP screencast workflow.
  - In `auto` mode, sessions advertise WebRTC producer support only when the
    running session runtime env contains both compositor and media producer
    enablement and the per-session media token hash exists.
  - Session API responses now include `media.mode` and
    `media.webrtcProducer`.
  - The workbench attempts WebRTC only when the selected running session reports
    `media.mode = auto` and `media.webrtcProducer = true`.
  - The existing fallback path remains the CDP screencast path and is selected
    immediately for CDP-only sessions, or after WebRTC setup, signaling,
    connection, timeout, or producer-health failure.
  - The existing viewport status badge now distinguishes `webrtc-live` from
    `fallback-cdp` without redesigning the workbench.
  - Packaging files were not changed in this stage. The existing flake already
    builds the `webrtc-media-producer` Go binary; Weston/GStreamer runtime
    packaging remains outside this Stage 10 code boundary unless packaging is
    touched in a later rollout change.

Validation:

- Build output includes the compositor/media producer dependencies.
- Packaging includes Weston and the selected PipeWire/WebRTC media stack.
- Production build works without a development server.
- A session can be controlled start to finish with WebRTC disabled.
- A session can be controlled start to finish with WebRTC live.
- A session can be controlled start to finish after WebRTC fails and fallback
  takes over.
- Local validation:
  - `git diff --check`
  - `mise x go@latest -- go test ./...`
  - `mise x go@latest -- go build ./cmd/aperture ./cmd/browser-session-wrapper ./cmd/webrtc-media-producer`
  - `mise x node@22.18.0 pnpm@11.9.0 -- pnpm --filter @aperture/web format:check`
  - `mise x node@22.18.0 pnpm@11.9.0 -- pnpm --filter @aperture/web typecheck`
  - `mise x node@22.18.0 pnpm@11.9.0 -- pnpm --filter @aperture/web build`
  - `nix build .#aperture` was not run because packaging/package files were not
    changed.
  - Live session control validation was not run from this worktree because the
    existing service/dev server must not be started here.

Bail out if:

- Packaging cannot include the compositor/media stack deterministically.
- WebRTC support changes the behavior of users who stay on CDP screencast.
- The operational setup requires undocumented external services.
- Bailout notes:
  - No bailout triggered in local validation.
  - CDP-only sessions no longer attempt WebRTC because producer support must be
    advertised by the session API.
  - `webrtc_media_mode = "cdp"` is the rollout kill switch for the nested
    compositor/WebRTC runtime path.
  - No TURN configuration, new external service, or operational documentation
    was added.
  - If a later packaging change cannot include Weston, PipeWire, and GStreamer
    deterministically, keep `webrtc_media_mode = "cdp"` or keep producer support
    disabled.

## Open decisions

- Whether remote deployments need TURN on day one. If yes, add explicit TURN
  config before enabling WebRTC outside local networks.
- Whether audio capture is required. Leave it out until video is stable.
- Whether multiple simultaneous viewers matter for the first release.
- Whether the fallback retry policy should be manual-only or bounded automatic.
- Whether the media producer should run only for the active UI viewer or stay
  warm while a session workbench is open.
- Whether to keep the current Pion sender around the PipeWire/GStreamer source
  or switch to a WHIP-compatible sender before rollout.
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

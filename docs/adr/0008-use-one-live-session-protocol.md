---
status: accepted
---

# Use one live session protocol

Aperture will use one semantic protocol for browser target state and commands, collaboration, input, and presentation control. Each session client has one active session transport: WebRTC carries native video and the protocol, while WebSocket fallback carries raster presentation and the same protocol. A planned transport change waits until that client has no pressed input, text composition, or active overlay stroke; it then briefly pauses commands and direct input, drains the old reliable lane, sends a fresh session snapshot on the replacement, activates it, and retires the previous transport. If the active transport fails first, Aperture blocks new input while preserving the session client's identity and explicit lease for a five-second recovery window. Other clients see it as recovering; its selected target and follow relationships remain, while its cursor and active overlay stroke clear. Keeping one contract and authority across these concerns prevents transport-specific behavior and replaces ADR 0006's narrower proposal for a collaboration-only WebRTC fast path.

Activating a session transport sends a complete session snapshot followed by ordered state events that the frontend reduces locally. The protocol has no state revisions, retained event history, or offset-based resume. Direct input, cursor activity, and overlay strokes are not snapshot state, and Aperture never replays them after handover.

Transport loss fails every command whose result has not reached the client. The client does not retry those commands on the replacement transport, even when the server may already have applied them. The fresh session snapshot reconciles observable state; another user action creates a new command.

Every reliable command carries a request ID scoped to its active session transport and receives exactly one typed success or error result. State changes remain separate ordered events rather than serving as implicit command acknowledgements. Request IDs correlate results only; they do not provide cross-transport retries or idempotency.

The protocol has two delivery classes. Its reliable ordered lane carries snapshots, state events, commands and results, pointer buttons and wheel input, keyboard and text input, and overlay-stroke boundaries. Its realtime lane carries coalescible pointer motion, cursor positions, and intermediate stroke points without delivery or replay guarantees. WebSocket fallback preserves these semantics by coalescing queued realtime messages before sending them on its reliable byte stream.

Each realtime sender includes a transport-local monotonic counter so receivers can discard stale or duplicate arrivals. The counter resets on handover and never acts as a session-state revision, resume offset, or replay position.

Reliable pointer-button and wheel messages carry their browser target and normalized content coordinates. They never depend on an earlier realtime pointer-motion message arriving first. Browser integrations convert those normalized coordinates without exposing CDP pixels, compositor surfaces, or media-canvas padding to the protocol.

A new session client uses WebSocket immediately when its session does not offer WebRTC. Otherwise, it gives WebRTC five seconds to produce a usable session transport and does not start a WebSocket session transport or raster capture in parallel. WebSocket becomes active when that deadline expires, WebRTC setup fails, or an active WebRTC transport is lost. This avoids duplicate capture work and a transport handover during every successful startup while bounding the initial blank viewport.

WebRTC peer capacity does not reduce the session-client limit. A client uses WebSocket when no WebRTC slot is available and may upgrade when capacity opens; Aperture never evicts an existing peer to admit a new one.

While WebSocket fallback is active, the client retries WebRTC in the background with capped backoff. A prepared WebRTC connection does not become the active session transport until its video is ready and it has received the handover snapshot; it then replaces WebSocket through the same atomic handover.

Transport selection is automatic. The workbench reports WebRTC, WebSocket, and recovering states and may restart connection setup, but it does not expose a CDP fallback action or a persistent transport selector.

The protocol does not expose a headful or headless execution mode. Sessions backed by CDP screencast or future headless execution differ here only by not offering WebRTC and therefore always using WebSocket. Modeling other headless behavior is outside this decision.

Both session transports select the exact `aperture-session.v1` protocol during setup and reject a mismatch. Individual messages do not carry version-negotiation machinery. Semantic protocol messages use strict JSON envelopes; WebSocket raster presentation uses binary frames rather than base64 JSON, while WebRTC video remains an RTP media track. Aperture will keep Go and TypeScript decoders explicit instead of introducing a protocol code-generation workflow for this story.

Creating a session client issues a public client ID and an opaque resume secret. A replacement transport must present both normal session authorization and that secret before it can inherit the client's presence, follow state, selected browser target, or input lease. The secret grants no session access by itself and expires when the client disconnects after its recovery window.

The wrapper's live-session module replaces the existing collaboration hub and its WebSocket protocol. Browser control, collaboration, and presentation do not remain as independent authorities behind a translation layer, and Aperture will delete the old frontend transport and duplicate input translations when the workbench switches to the new protocol.

Recording jobs and their live state also belong to the live-session module. The workbench starts, observes, and stops recordings through its active session transport; HTTP API and MCP callers invoke the same module through their own interfaces. The separate recording-client WebSocket is removed, and completed recordings remain session files handled by the existing file and download interfaces.

## Delivery order

1. Land the glossary and architectural decisions without protocol scaffolding.
2. Extend `webdesktop` with generic authenticated peer metadata, lifecycle, and reliable and realtime application-channel hooks.
3. Move browser control, collaboration, recording jobs, and automation input leasing into Aperture's final live-session authority while existing callers still reach that authority through their current interfaces.
4. Add WebRTC and WebSocket session transports together, migrate the workbench, and delete the old collaboration WebSocket, recording-client WebSocket, duplicate input translations, and ordinary frontend CDP control path.

Aperture will not ship an intermediate WebSocket-only session protocol. Owner DevTools and privileged raw CDP remain as decided by ADR 0007.

---
status: proposed
---

# Add an authenticated WebRTC fast path for collaboration

Aperture should use WebRTC data channels for latency-sensitive input, cursor, and painting messages when the peer is authenticated and bound to its collaboration client ID. The collaboration WebSocket remains available as the fallback transport.

The current WebRTC server cannot make that binding. Its input controller receives only an internal numeric peer ID, and its data-channel handler rejects application-defined channels. Enabling the existing input channel would bypass the session-wide lease from ADR 0003 and restore independent target-scoped input ownership.

## Required changes

- Extend `webdesktop` so Aperture can authenticate a WebRTC peer, bind it to a collaboration client ID, and handle an application-defined collaboration channel.
- Keep the WebSocket authoritative for connection setup, presence, input claims and releases, and follow state.
- Send input, cursor, and painting messages over WebRTC when its collaboration channel is ready. Send them over the WebSocket otherwise.
- Use one sequence and deduplication domain across both transports so failover cannot apply an event twice or reorder it.

## Consequences

- WebRTC failure does not remove input or collaboration because the WebSocket stays connected.
- Input authorization remains session-wide and identical across both transports.
- This remains proposed until the WebRTC server exposes authenticated peer metadata and custom data-channel handling.

---
status: accepted
---

# Coordinate collaboration and input per session

Aperture will add one server-authoritative collaboration coordinator to each running browser session. It will own presence, client-selected targets, follow relationships, temporary annotations, and one session-wide input lease. WebRTC remains a target-scoped media transport and no longer grants independent input leases.

This supersedes ADR 0002's per-target input ownership decision. Independent media selection remains useful, but independent input lets two people mutate the same browser session at once and cannot support explicit control, owner override, or read-only participation.

## Consequences

- A collaboration client must hold the session input lease before the wrapper accepts its pointer or keyboard events.
- The lease survives target changes. Implicit leases follow interaction boundaries, while explicit leases require release, disconnect, expiry, or owner override.
- Collaboration fails closed. Shared clients may keep viewing media when the coordinator is unavailable, but they cannot send browser input.
- Cursor, follow, and annotation state remain ephemeral and do not alter recordings or browser content.

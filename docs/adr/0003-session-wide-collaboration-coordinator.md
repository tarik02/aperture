---
status: accepted
---

# Coordinate collaboration and input per session

Aperture's live session will be the server authority for presence, client-selected targets, follow relationships, overlay strokes, and one session-wide input lease. A session transport never grants an independent input lease.

This supersedes ADR 0002's per-target input ownership decision. Independent media selection remains useful, but independent input lets two people mutate the same browser session at once and cannot support explicit control, owner override, or read-only participation.

## Consequences

- A session actor must hold the session input lease before the wrapper accepts its pointer or keyboard events.
- The input lease gates direct browser input, including clipboard shortcuts and paste, but does not gate target or navigation commands authorized by the actor's capability.
- The lease survives target changes. Implicit leases follow interaction boundaries, while explicit leases require release, disconnect, expiry, or owner override.
- Losing the active session transport immediately releases every pressed key and pointer button, cancels text composition, and releases an implicit lease. Aperture blocks new input while preserving the client and its explicit lease for a five-second recovery window; expiry disconnects the client and releases that lease.
- Each automation browser tool call is a short-lived session actor. It acquires the explicit input lease for the duration of the call, fails as busy when another actor holds the lease, and releases the lease on every completion or error path.
- While an automation tool call holds the lease, presence shows a short-lived robot avatar with the authenticated principal name and explicit-lock indicator. The avatar disappears when the call releases the lease.
- Live-session input fails closed. Shared clients may keep their last presentation frame when the live session is unavailable, but they cannot send browser input.
- Cursor, follow, and overlay-stroke state remain ephemeral and do not alter recordings or browser content.

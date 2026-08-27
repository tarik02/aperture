---
status: accepted
---

# Separate editor and viewer capabilities

Aperture will issue independently rotatable editor and viewer capabilities for each session. The existing share experience will use the editor capability, while a second link will use the viewer capability. The owner session token remains separate and keeps unrestricted CDP, recording, file, and session-management authority.

The earlier session token was too broad for collaboration because it exposed CDP and file operations that the share UI did not advertise. UI-only restrictions also could not enforce read-only access for a caller using the underlying routes directly.

## Consequences

- Editor capabilities permit media, collaboration state, and browser control through the coordinator.
- Viewer capabilities permit media, presence, follow, and annotations, but the server rejects browser input.
- Rotating one capability disconnects clients using that role without affecting the other role or the owner.
- Capability URLs remain session-scoped and place the secret in the URL fragment before moving it to session storage.

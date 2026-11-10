---
status: accepted
---

# Separate editor and viewer capabilities

Aperture will issue independently rotatable editor and viewer capabilities for each session. The existing share experience will use the editor capability, while a second link will use the viewer capability. The owner session token remains separate and keeps unrestricted CDP, recording, file, and session-management authority.

The earlier session token was too broad for collaboration because it exposed CDP and file operations that the share UI did not advertise. UI-only restrictions also could not enforce read-only access for a caller using the underlying routes directly.

## Consequences

- Editor capabilities permit presentation, collaboration state, and browser control through the live session.
- Viewer capabilities permit media, presence, follow, and annotations, but the server rejects browser input.
- Rotating one capability disconnects clients using that role without affecting the other role or the owner.
- Capability URLs remain session-scoped and place the secret in the URL fragment before moving it to session storage.

## Addendum: editors manage session files

Editors are trusted with the browser itself: they navigate anywhere, download into the files root, and start and download recordings. Session files are what that browser produces and consumes, so keeping their routes owner-only protected little and kept editors from features that move data through files, such as large clipboard transfers. Editor capabilities therefore have the same file access as the owner session token:

- The `/api/sessions/:sessionId/files` routes (listing, upload, directories, move, delete, and signed download URLs) accept the session token and an editor capability of that session. Viewer capabilities are rejected.
- `POST /sessions/:sessionId/uploads` accepts editors as well as owners.

As with other capability access, this holds while the session runs or is suspended; account credentials keep access in every retained state.

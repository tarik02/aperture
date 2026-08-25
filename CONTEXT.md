# Aperture

Aperture supervises isolated browser sessions and retains the state and files they produce.

## Language

**Session file**:
A regular file retained with a browser session and identified by a path relative to that session. Browser downloads and completed recordings are session files.
_Avoid_: Retained file, recording file

**Collaboration client**:
One active browser connection participating in a session. Two windows from the same person are separate collaboration clients because each has its own cursor, selected target, and input claim.
_Avoid_: Viewer, user, peer

**Input lease**:
The session-wide right held by one collaboration client to send pointer and keyboard input to the browser. A lease is either implicit and tied to active interaction, or explicit and retained until released or revoked.
_Avoid_: Input lock, tab lock, control ownership

**Editor capability**:
A rotatable session secret that permits collaborative browser control without session management, recording, file, or unrestricted CDP authority.
_Avoid_: Share token, session token

**Viewer capability**:
A rotatable session secret that permits observing and visual collaboration but never browser input.
_Avoid_: Read-only session token, guest token

## Example dialogue

Developer: "What should stopping a recording return?"

Domain expert: "Return the session file. Its relative path can be used to create a signed download URL."

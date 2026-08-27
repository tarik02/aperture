# Aperture

Aperture supervises isolated browser sessions and retains the state and files they produce.

## Language

**Live session**:
The active, transient browser state and shared activity available while a browser session runs, including browser targets, session clients, presentation, input leases, collaboration, and recording jobs. Interactive clients and automation act on the same live session.
_Avoid_: Collaboration hub, browser transport, wrapper runtime

**Session file**:
A regular file retained with a browser session and identified by a path relative to that session. Browser downloads and completed recordings are session files.
_Avoid_: Retained file, recording file

**Browser target**:
A live browser page exposed by Aperture as an independently selectable destination for viewing, control, and recording. Its identity survives navigation and internal remapping, but ends when the page closes or the browser restarts.
_Avoid_: CDP target, tab

**Presentation**:
The live visual output of one browser target delivered to one session client. Selecting a presentation is client-local and neither focuses the browser nor retargets another client or recording.
The session client chooses WebRTC or WebSocket raster delivery locally. The compositor encoder profile, frame rate, and bitrate are shared by all WebRTC presentations in the live session.
_Avoid_: Active tab, screen share, media target

**Session actor**:
An interactive session client or one automation operation authorized to act on a live session. Only one session actor may hold the input lease at a time.
_Avoid_: User, peer, API token

**Session client**:
One active workbench instance participating in a browser session as a persistent session actor. It retains its identity briefly while replacing a failed session transport; two windows from the same person remain separate session clients.
_Avoid_: Collaboration client, viewer, user, peer

**Resume secret**:
An ephemeral credential proving that a replacement session transport belongs to an existing session client. It grants no browser-session access by itself and expires when that client disconnects.
_Avoid_: Client ID, editor capability, viewer capability

**Session transport**:
The single active live connection of a session client, carrying both its presentation and session protocol. Replacing it preserves the session client's identity through an atomic handover or a five-second failure recovery window.
_Avoid_: Transport attachment, collaboration socket, media connection

**Session snapshot**:
The complete recoverable state delivered when a session transport becomes active, including browser targets, presentation, presence, input lease, follow relationships, and recording jobs. Direct input, cursor positions, and overlay-stroke activity never belong to the snapshot.
_Avoid_: Shell snapshot, revision, event log

**Realtime message**:
A disposable update whose newest value matters more than guaranteed delivery, such as pointer motion, cursor position, or an intermediate overlay-stroke point. Realtime messages are never replayed after session transport replacement.
_Avoid_: State event, command

**Input lease**:
The session-wide right held by one session actor to send direct input such as pointer, wheel, keyboard, text, and clipboard actions through the live session. It does not restrict authorized target and navigation commands or privileged owner CDP access.
_Avoid_: Input lock, tab lock, control ownership

**Editor capability**:
A rotatable session secret that permits collaborative browser control without session management, recording, file, or unrestricted CDP authority.
_Avoid_: Share token, session token

**Viewer capability**:
A rotatable session secret that permits observing and visual collaboration but never browser input.
_Avoid_: Read-only session token, guest token

**Follow relationship**:
An ephemeral directed edge from one session client to another. The follower adopts the followed client's selected browser target and highlights that client's cursor. Chains are allowed; cycles are rejected.
_Avoid_: Screen share, control transfer

**Overlay stroke**:
An ephemeral visual mark attached to one browser target. Any session client may create one, including clients using a viewer capability. It never becomes browser input or retained session state.
_Avoid_: Annotation document, whiteboard object

## Example dialogue

Developer: "What should stopping a recording return?"

Domain expert: "Return the session file. Its relative path can be used to create a signed download URL."

Developer: "Does following another client give me control?"

Domain expert: "No. A follow relationship changes your selected browser target; an input lease permits browser input."

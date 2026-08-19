# Aperture

Aperture supervises isolated browser sessions and retains the state and files they produce.

## Language

**Browser mode**:
A browser session's choice of `headed` or `headless` Chromium execution. Browser mode belongs to the session and is independent of its browser channel, live-view transport, and the compositor's backend.
_Avoid_: Headless mode, media mode, compositor mode

**Browser configuration**:
One valid combination of a browser channel and browser mode, together with the capabilities that combination provides. Browser launch overrides do not create additional configurations.
_Avoid_: Execution profile, browser profile

**Browser launch override**:
A persisted caller-supplied Chromium argument that may change browser or page behavior without changing Aperture's browser configuration or capabilities. It cannot control behavior Aperture owns.
_Avoid_: Browser configuration, channel default

**Session capabilities**:
The configuration-dependent behavior available from a session's active launch plan or from its current launch projection. Capability state distinguishes `active`, `prospective`, and `unavailable`; connection data separately identifies usable routes and credentials.
_Avoid_: Media mode, connection details

**Browser target**:
A user page addressed by its CDP `targetId`. Viewport, live view, input, and recording select browser targets independently.
_Avoid_: Current tab, active page

**Managed browser window**:
A Chromium top-level window that contains exactly one ready browser target. Headed mode may map the window to compositor capture; headless mode identifies it only through Chromium.
_Avoid_: Tab, capture window

**Live view**:
A transient view of a browser target delivered through an available transport. Live views are not retained as session files.
_Avoid_: Screencast, recording

**Recording**:
A target-scoped video capture job identified by a recording ID. A completed recording produces a session file.
_Avoid_: Screencast

**Session file**:
A regular file retained with a browser session and identified by a path relative to that session. Browser downloads and completed recordings are session files.
_Avoid_: Retained file, recording file

## Example dialogue

Developer: "Can a headless session record what this live view shows?"

Domain expert: "Start a recording for the same browser target. The live view remains transient, while stopping the recording produces a session file."

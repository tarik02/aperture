# Aperture

Aperture supervises isolated browser sessions and retains the state and files they produce.

## Language

**Session file**:
A regular file retained with a browser session and identified by a path relative to that session. Browser downloads and completed screencasts are session files.
_Avoid_: Retained file, recording file

## Example dialogue

Developer: "What should stopping the screencast return?"

Domain expert: "Return the session file. Its relative path can be used to create a signed download URL."

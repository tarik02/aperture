---
status: accepted
---

# Use ephemeral strokes for shared drawing

Aperture will relay target-scoped overlay strokes through the session collaboration coordinator and discard them after delivery. It will not embed Excalidraw or maintain a shared drawing document. The requested interaction is temporary visual guidance over a live browser target, while a whiteboard model would add persistent scene state, editing tools, conflict handling, and a separate document lifecycle.

## Consequences

- Owners, editors, and viewers may draw without acquiring the browser input lease.
- Drawing mode consumes pointer gestures instead of forwarding them to the browser.
- Clients normalize stroke coordinates to the target and fade strokes locally.
- Strokes do not change browser content, session state, or recordings.
- Persistent annotations, selectable shapes, and collaborative whiteboard editing require a separate decision and data model.

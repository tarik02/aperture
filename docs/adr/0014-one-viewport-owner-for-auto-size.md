---
status: accepted
---

# Arbitrate auto-size through one viewport owner

Auto-size resizes a browser target to the client's presentation area. Browser viewports are shared by every session client, so two auto-sizing clients with different window sizes overwrote each other on every resize. The live session now arbitrates auto-size with one session-wide viewport owner instead of letting the last resize win.

## Rules

- Only owners and editors can hold auto-size ownership; viewers and automation never do.
- A client that enables auto-size while nobody owns the viewport becomes the viewport owner. Other auto-sizing clients are suspended and see the shared viewport scaled into their presentation area.
- Only the viewport owner's auto-size resizes apply. The server rejects auto-size resizes from other clients with `viewport_not_owned`.
- When the owner disables auto-size or leaves after its transport recovery window, ownership passes to the client that enabled auto-size most recently. A recovering owner keeps ownership.
- An explicit viewport change by anyone other than the owner is applied as before and leaves ownership vacant. This includes a preset, a `viewport.set` from an older client, and the HTTP viewport API used by automation, even when automation resizes a target the owner is not presenting. Nobody inherits ownership automatically, since the next auto-size resize would undo the explicit size.
- After an explicit change, the viewport stays explicitly set until a client toggles auto-size on or takes over. A client that joins, or reconnects after its recovery window, with auto-size on in its hello, such as from its stored default, stays suspended instead of claiming the vacant viewport. When ownership is vacant for any other reason, such as nobody having enabled auto-size yet or the owner leaving with no other auto-sizing client, the next client with auto-size on becomes the owner, including one that joins with the default.
- Any owner or editor may take over explicitly, which enables its auto-size and makes it the owner.

Ownership is session-wide rather than per target: auto-size follows one person's window, and the owner resizes whichever target it presents.

## Protocol

The `aperture-session.v1` identifier stays, because current clients remain compatible. Clients decode server messages strictly, so the server sends ownership state only to clients that include `autoSize` in `session.hello`. This field is the client's auto-size preference, not a version number. Those clients receive `viewportOwnerClientId` and `autoSize` in their snapshot, followed by `viewport.state` events. They change their preference with `viewport.auto-size.set`, take over with `viewport.owner.claim`, and mark auto-size resizes with `autoSize: true` on `viewport.set`.

Clients that omit `autoSize` from their hello never receive ownership state, and every `viewport.set` they send counts as explicit. Their auto-size still resizes the viewport and ends the current ownership, but new clients never resize it back, so the clients do not alternate.

Aperture does not negotiate this in the other direction: a server that predates viewport ownership rejects a hello that carries `autoSize`. Embedders using newer `live-session` or `session-react` packages need a matching server.

## Consequences

- The workbench stores the default auto-size preference in `localStorage` (`aperture.viewport.auto-size-default`) and sends it with each hello.
- The viewport menu shows who controls the size and offers to take over. While a client's auto-size is suspended, a toolbar indicator shows the same and offers to take over.
- An automation resize pauses every client's auto-size until someone takes over. This is deliberate: the explicit size is what the automation asked for.

# Aperture

Aperture runs isolated browser sessions that people and agents watch and control together, and keeps what the sessions produce.

## Language

**Session**:
One browser with its own profile, files and network route, and everything around it that lets it be watched and controlled. It has no use for an id of its own: its routes (`/ws`, `/mcp`, `/cdp`, `/tunnel`, `/targets`, `/files` and the rest) are the same wherever it runs, at the root when it serves itself and below `/sessions/{id}` on an executor.
_Avoid_: Instance, container, workspace

**Runner**:
The process that runs one session: its compositor, its sandboxed browser, and its live endpoints, automation, recordings and sound. It knows nothing of sessions other than its own. It runs under an executor, or on its own with `serve`.
_Avoid_: Wrapper, supervisor, worker

**Executor**:
The process that runs the sessions of one node: it keeps their profiles and snapshots, starts and stops their runners, holds them to limits, and lets callers in. It needs no control plane.
_Avoid_: Server, daemon, agent

**Gateway**:
The way into sessions from outside: it decides who a request comes from and passes it on to the session's own sockets. An executor mounts it for each of its sessions; a runner that serves itself mounts it at the root.
_Avoid_: Proxy, router, API layer

**Control plane**:
What stands above executors: tenants, access, and which node a session runs on. It signs tickets. Not built yet.

**Target**:
A page of the session and the window that shows it. Each page has a window of its own, so a target is what a client watches, records and gives input to. Its id is the page's DevTools target id, which lasts for one run of the session.
_Avoid_: Window, surface, view

**Tab**:
A target's number, which no other tab of the session gets and which stays the same when the session is suspended and resumed. It is how a target is named: in the live protocol, in leases, automation and recordings. The session's HTTP routes and automation take a target id in its place, for whoever speaks DevTools.

**Live protocol**:
The messages a client and a session exchange on the session socket (`aperture.live.v1`): targets, input, clipboard, files, presence, and the target's pixels as WebRTC video, encoded frames or tiles.
_Avoid_: Collaboration protocol, transport

**Lease**:
The right to give a tab input, held by one person or agent at a time. A person takes it from an agent at once; equals ask and wait for an answer. Watching needs none.
_Avoid_: Lock, control, focus

**Presence**:
Who is connected to a session, which tab each watches, and who holds which lease.

**Operator token**:
The secret of whoever serves the sessions. Its holder may do anything there.

**Ticket**:
A signed, expiring pass for one person into one session. It lets its holder watch, and says what else they may do as access. Whoever stands above the executor signs it; the gateway only checks it.
_Avoid_: Session token, share link

**Access**:
What a caller may do in a session, area by area: `input`, `tabs`, `lease`, `sound`, `clipboard`, `uploads`, `downloads`, `recordings`, `proxy`, `mcp`, `cdp`, `tunnel`, each read, written, both or neither. Watching takes none. The operator token gives all of it; a ticket gives what it says, and a feature that is off gives nothing to anyone.
_Avoid_: Role, permission, scope

**Snapshot**:
A session's profile as it was at one moment, kept as a read-only layer. A session created from a snapshot starts with that profile and writes its own changes above it. Snapshots are the executor's; a runner that serves itself has a plain profile directory.

**Snapshot store**:
Where executors keep snapshots together, so that a session is created on one node from a snapshot taken on another: an S3 bucket, or a directory the nodes share. A node brings a snapshot's layers to its own storage when it first builds a session on them. Without one, snapshots are their node's alone.

**Session store**:
Where executors put a session whenever it is suspended, so that another node resumes it: its record, and what its profile had above its layers with its files. A node asked to resume a session it does not have, or has another state of, brings it from there. Which node runs a session is for whoever tells the nodes what to do. Executors can be set up to say in the store which sessions they have as well, and then refuse one another node has unless asked to take it over. A session whose node died is resumed elsewhere as it was last suspended.

**Session file**:
A file under the session's files directory: downloads, uploads and recordings. Session files are not part of the profile and never enter a snapshot.

**Recording**:
A target's video and sound from start to stop, written as it is encoded for those who watch, with a journal of what automation did meanwhile. That is the raw recording.

**Recording edit**:
What is made of a raw recording once it stops: a second video with the cuts, speed-ups, captions, zooms and click ripples the recording asked for, and a timeline that maps one to the other. The raw recording stays.
_Avoid_: Post-processing, render

**Tap**:
The session's extension taking one tab's sound apart from the others, so each listener hears the tab they watch. A tapped tab plays into its tap and nowhere else.

**Feature**:
Something a session offers only where whoever starts it turns it on: `sound`, `uploads`, `downloads`, `recordings`, `clipboard`, `mcp`, `cdp`, `tunnel`. A session tells its clients which it has; what is off is refused, and a client does not show it. On an executor a session offers what the executor does unless it says itself which, and never more than the executor does; the same goes for its network.
_Avoid_: Capability, permission

**Egress**:
How the session's browser reaches the network. It has no network of its own: every connection goes through the runner, which refuses local and private addresses unless allowed and routes the rest by the session's proxy rules.

**Network**:
What network the browser has in its sandbox besides its egress, said apart for TCP and for UDP. TCP is _proxied_, the default, or _direct_: pages still go through egress then, but nothing holds the browser to it. UDP, which egress does not carry, is _none_, the default, or _direct_, for WebRTC and whatever else takes it. What is direct is held to no rules and reaches the local network too.

**Names**:
How the session resolves names, by its own records first and then by its resolvers, which are the node's unless the session names others. The connections egress makes from the node and the questions a browser with a network of its own asks get the same answers. A proxy or a tunnel resolves what goes through it.

**Session certificate**:
A certificate the session makes for a name whose TLS a rule has it answer itself, so that a server that speaks no TLS is `https://` to the session's pages. All have one key, made when the session starts and kept nowhere; only the session's own browser takes them.
_Avoid_: Certificate authority, MITM

**Follow**:
A member watching whichever tab another member watches, until it selects a tab itself or the other leaves. It gives no input and takes no lease. Nobody is followed around a circle of followers.

**Mark**:
Something a member shows the others who watch the same tab, and nothing the session keeps: where its pointer is, and the strokes it draws over the picture, which fade once they end. Anyone in the session makes marks, also who may only watch. A mark is no input to the page.
_Avoid_: Annotation, cursor (the browser's own)

**Tunnel**:
A route a client attaches to a session so that connections the rules send `via: local` are made from the client's machine.

**Limits**:
What a session may use (memory, swap, processor time, tasks) and how long it may sit idle. Resource limits take an executor that runs sessions as systemd scopes.

**Asleep**:
Suspended by the executor for sitting idle, and resumed when someone reaches the session again. A session suspended on request stays suspended.
_Avoid_: Hibernated, paused

**Workbench**:
A session shown as a browser to work in: tab strip, toolbar, menus and the picture. It is made of parts that stand on their own, and of slots.

**Slot**:
A named place of the workbench: a menu, the toolbar's ends, the title bar's ends, the picture's overlay.

**Contribution**:
One thing in one slot. Everything the workbench shows in its slots is a contribution, its own included, so an embedder adds, replaces and leaves out by the same means.
_Avoid_: Plugin, extension

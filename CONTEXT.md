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
A page of the session and the window that shows it. Each page has a window of its own, so a target is what a client watches, records and gives input to. Its id lasts for one run of the session.
_Avoid_: Window, surface, view

**Tab**:
A target's number, which stays the same when the session is suspended and resumed. Leases, automation and recordings name a tab; the target id is for one run only.

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
A signed, expiring pass for one person into one session with one role: `view`, `control` or `admin`. Whoever stands above the executor signs it; the gateway only checks it.
_Avoid_: Session token, share link

**Snapshot**:
A session's profile as it was at one moment, kept as a read-only layer. A session created from a snapshot starts with that profile and writes its own changes above it. Snapshots are the executor's; a runner that serves itself has a plain profile directory.

**Session file**:
A file under the session's files directory: downloads, uploads and recordings. Session files are not part of the profile and never enter a snapshot.

**Recording**:
A target's video and sound from start to stop, written as it is encoded for those who watch, with a journal of what automation did meanwhile. That is the raw recording.

**Recording edit**:
What is made of a raw recording once it stops: a second video with the cuts, speed-ups, captions, zooms and click ripples the recording asked for, and a timeline that maps one to the other. The raw recording stays.
_Avoid_: Post-processing, render

**Tap**:
The session's extension taking one tab's sound apart from the others, so each listener hears the tab they watch. A tapped tab plays into its tap and nowhere else.

**Egress**:
How the session's browser reaches the network. It has no network of its own: every connection goes through the runner, which refuses local and private addresses unless allowed and routes the rest by the session's proxy rules.

**Tunnel**:
A route a client attaches to a session so that connections the rules send `via: local` are made from the client's machine.

**Limits**:
What a session may use (memory, swap, processor time, tasks) and how long it may sit idle. Resource limits take an executor that runs sessions as systemd scopes.

**Asleep**:
Suspended by the executor for sitting idle, and resumed when someone reaches the session again. A session suspended on request stays suspended.
_Avoid_: Hibernated, paused

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
The right to give a tab input, held by one person or agent at a time. A person takes it from an agent at once; equals ask and wait for an answer. Watching needs none, and neither does saying where a tab goes: opening and closing tabs, reloading, going to an address or along the history.
_Avoid_: Lock, control, focus

**Presence**:
Who is connected to a session, which tab each watches, and who holds which lease.

**Operator token**:
The secret of whoever serves the sessions. Its holder may do anything there.

**Control plane**:
What stands above the executors of many nodes: it has the accounts, knows the nodes that are alive, decides which node a session runs on, keeps a record of every session and where it is, and signs tickets. Executors need none; it needs them.
_Avoid_: Server, manager, orchestrator

**Node**:
A machine with an executor on it, as the control plane knows it: its name, where it is reached, what its sessions may have, and when it was last heard from. A node tells of itself with a keepalive, and one that falls silent gets no new sessions.

**Registration token**:
What lets an executor tell a control plane it is a node of it. An admin makes it; several can be good at once. An admin takes one back as well: no new node registers with it then, and the nodes that registered with it stay for as long as they say of themselves what they said before.

**Workspace**:
Where accounts keep sessions and snapshots together: what is a workspace's is all its members', and stays the workspace's when a member leaves. A session or a snapshot is of one workspace or of none, and of none it is its account's own. A member who is an admin of the workspace says who its members are. Whoever does finds a person to let in by the whole email address they sign in with, and is told of nobody they did not name.

**Service account**:
An account for something that is not a person: it comes with API tokens alone. It holds sessions and snapshots and is let into workspaces as a person's account is.

**Person**:
Someone who signs in: known by an email address, and proven by a password of their own, which they set with a setup link an admin gives them, by a passkey they added, or by the word of a provider. A person has one account. Nobody makes themselves a person: an admin does, or a provider's word where the control plane is set to take it.

**Passkey**:
What an authenticator of a person's keeps for them and proves it has, in place of their password: good at the address the control plane is reached at and nowhere else. A person adds passkeys once signed in, names them and removes them; one signs them in by itself, and no second factor is asked after it. An admin removes a person's passkeys without them, as for one who lost the device.
_Avoid_: Security key, WebAuthn credential

**Provider**:
An OpenID Connect issuer the control plane lets people sign in through, beside their passwords. It signs in the person who has the email address it says it verified, and no second factor is asked after it. A provider says for itself whether someone it vouches for whom no admin made a person is made one when they first come, with no password until they set one, and of which domains. The settings name providers, which stay as they are while the control plane runs; an admin adds others meanwhile, changes them, disables them and removes them, and each is asked how it is reached before it is kept enabled. What a provider is known by stays for as long as it is there: the address it sends people back to has it, and so does whoever came through it. Its client secret is given and never told. Disabling or removing a provider removes nobody: whoever came through it alone does not sign in until it is back, and passwords and passkeys are no provider's to take.
_Avoid_: IdP, SSO, social login

**Grant**:
What a person lets an app do in their name, as OAuth has it: scopes and, where they chose, the sessions, snapshots and workspaces it reaches. An app's access token is told to be a caller exactly as an API token is. A person sees their grants as connected apps and takes any back, which ends the app's tokens with it. An app gives its grant back itself as well, by handing in either of its tokens.

**Session path**:
Where a session is reached through a proxy that stands before the nodes, below the proxy's own address: `/n/<node>/sessions/<id>`. The proxy sends what comes there on to the node, once the control plane told it the request may pass and gave it a ticket to put on it; the ticket goes no further than the proxy. The path changes when the session moves to another node.

**Master key**:
The one secret a control plane is given beside its database: what it has to read again, such as a node's operator token, is kept sealed with a key made of it. It is not in the database, and stays the same for as long as what was sealed is to be read.

**Account**:
Whose sessions, snapshots and API tokens are, in the control plane. An admin account also makes accounts and registration tokens, disables accounts and removes them. An account is removed once no session and no snapshot names it, and its API tokens, its grants, the share links it made and its places in workspaces go with it, and the guests of those links are put out.
_Avoid_: Tenant, user

**Disabled**:
Said of an account an admin took out of use without removing it: nothing signs in as it, whatever it proves itself by, its cookies, its API tokens and the tokens of its grants are nobody's at once, and whoever is in a session as it is put out. The share links it made let nobody in while it is, and their guests are put out with it. All that is its own stays, and it is as it was once an admin enables it. Nobody disables or removes their own account, and the last admin stays.
_Avoid_: Blocked, banned, suspended (which is a session's)

**Event**:
Something that was done, written down once and never changed: when, what kind of thing it was, who did it and what it was about, each as it was called then, the workspace that was of, and where the request came from. Who did it is an account, the guest of a share link, the holder of the bootstrap token, someone not known, as whoever failed to sign in, or the control plane by itself. An admin reads every event; anyone else those of their own account, done by it or to it, and of the workspaces they are in. Events are kept for a while and then forgotten, and none holds a secret.
_Avoid_: Audit entry, activity, log line

**Ticket**:
A signed, expiring pass for one person into one session. It lets its holder watch, and says what else they may do as access. Whoever stands above the executor signs it; the gateway only checks it. A session socket opened with it stays open after the ticket ran out, but for one whose ticket says until when, and one whose holder the operator dismisses.
_Avoid_: Session token, share link

**Share link**:
What lets someone with no account into one session: whoever has the session makes it, to watch or to control, for a time or until they take it back. Its secret is told once, in a link, and kept as a digest. Whoever opens the link is a guest: they say what the others are to call them, and are shown the session's workbench and nothing else. A guest who controls gives input, changes tabs, takes a tab, and has the clipboard and the sound; the session's files, routing, automation and DevTools endpoint are no guest's. Taking a link back puts its guests out at once, and so does its running out, and the disabling or removing of the account that made it.
_Avoid_: Invite, public link, session token

**Access**:
What a caller may do in a session, area by area: `input`, `tabs`, `lease`, `sound`, `clipboard`, `uploads`, `downloads`, `recordings`, `proxy`, `mcp`, `cdp`, `tunnel`, each read, written, both or neither. Watching takes none. The operator token gives all of it; a ticket gives what it says, and a feature that is off gives nothing to anyone.
_Avoid_: Role, permission, scope

**Snapshot**:
A session's profile as it was at one moment, kept as a read-only layer. A session created from a snapshot starts with that profile and writes its own changes above it. Snapshots are the executor's; a runner that serves itself has a plain profile directory.

**Snapshot store**:
Where executors keep snapshots together, so that a session is created on one node from a snapshot taken on another: an S3 bucket, or a directory the nodes share. A node brings a snapshot's layers to its own storage when it first builds a session on them. Without one, snapshots are their node's alone.

**Session store**:
Where executors put a session whenever it is suspended, so that another node resumes it: its record, and what its profile had above its layers with its files. A node asked to resume a session it does not have, or has another state of, brings it from there. Which node runs a session is for whoever tells the nodes what to do. Executors can be set up to say in the store which sessions they have as well, and then refuse one another node has unless asked to take it over. A session whose node died is resumed elsewhere as it was last suspended. A node drops its own copy of a session that is at rest there when asked to: that is evicting it, and the session stays for whichever node resumes it.

**Storage state**:
What a session's browser keeps for the sites it visits, as a document that is taken out of one session and put into another: its cookies, the local storage of origins and, where asked for, their databases. It is for whoever runs the session, as the DevTools endpoint is. A snapshot keeps the whole profile; a storage state is the part of it that moves between browsers.
_Avoid_: Browser state, capsule

**Session file**:
A file under the session's files directory: downloads, uploads and recordings. Session files are not part of the profile and never enter a snapshot.

**Recording**:
A target's video and sound from start to stop, written as it is encoded for those who watch, with a journal of what automation did meanwhile. That is the raw recording. It may go on with another tab, and its picture changes size as the tab's does.

**Recording edit**:
What is made of a raw recording once it stops: a second video with the cuts, speed-ups, captions, zooms and click ripples the recording asked for, and a timeline that maps one to the other. Its frame is the smallest every size of the raw picture fits in, each in the middle of it. The raw recording stays.
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
Something a member shows the others who watch the same tab, and nothing the session keeps: where its pointer is, also while it draws, and the strokes it draws over the picture, which fade once they end. Pointers are shown unless whoever watches chose not to see them. Anyone in the session makes marks, also who may only watch. A mark is no input to the page.
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

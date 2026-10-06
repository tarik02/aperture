# Live session

The live session is a running session's transient state: browser targets, connected clients, presentation, the input lease, recordings. These routes expose it; the viewport and uploads routes are also in the spec under the `live-session` tag.

| Route | Credentials | Purpose |
|---|---|---|
| `GET /sessions/:id/session` (WebSocket) | API `sessions:read` or more, `aps_`, `ape_`, `apv_` | the session protocol below, with JPEG presentation frames |
| `GET /sessions/:id/webrtc/signal` (WebSocket) | same | the same protocol over WebRTC data channels, with a video track |
| `POST /sessions/:id/browser/viewport` | API `sessions:write`, `aps_`, `ape_` | resize one top-level target; body `{targetId, width, height, deviceScaleFactor}` |
| `GET`/`PUT /sessions/:id/browser/cursor` | same | remote cursor visibility in the stream and recordings, `{"visible": bool}` |
| `/sessions/:id/recordings…` | same | [recordings.md](recordings.md) |
| `POST /sessions/:id/uploads` | API `sessions:write`, `aps_` | [session-files.md](session-files.md#uploads) |
| `GET /sessions/:id/tunnel` (WebSocket) | API `sessions:write`, `aps_` | [local tunnel](#local-tunnel) |
| `/sessions/:id/cdp/<aps_ token>/…` | the `aps_` token in the path | [CDP](#cdp) |

Authorization failures use the API error envelope; failures inside the session answer `{"error": "<message>"}` without a stable code. A connection's role is the credential's: `aps_` and API `sessions:write` are `owner`, `ape_` is `editor`, `apv_` and API `sessions:read` alone are `viewer`.

## Session protocol

Both WebSockets take the exact subprotocol `aperture-session.v1`; API tokens and capabilities ride along as further subprotocols, `authorization.bearer.<token>` and, for a system-admin token, `x-aperture-tenant-id.<tenantId>`.

1. The client sends `session.hello` with `name` and `avatarHash`, and `autoSize: true|false` when it wants to take part in [viewport ownership](#viewport-ownership).
2. The server answers `session.snapshot`: `clientId`, `resumeSecret`, `role`, `transport`, `targets`, `activeTargetId`, `participants`, `holderClientId` and lease `mode`, `recordings`, and the viewport-owner fields for clients that opted in. The snapshot is the whole recoverable state; realtime data is never in it.
3. State arrives as `targets.state`, `presentation.state`, `viewport.state`, `input.state`, `presence.state`, `recordings.state`, and the realtime `presence.cursor`, `presence.cursor.clear` and `paint.point`.

**Resume.** When the transport drops, reconnect within five seconds and send `session.hello` with `clientId` and `resumeSecret` instead of `name` and `avatarHash`, plus the normal authorization. The client keeps its identity, lease and recordings; the new snapshot is the truth to reconcile against. Commands that were in flight have failed; wait for a new user action instead of replaying them.

**Channels.** WebRTC clients open an ordered `application` channel and an unordered, zero-retransmit `application-realtime` channel, plus a receive-only video transceiver. Reliable traffic: hello, snapshot, state, commands and results, input other than pointer motion, stroke start and end. Realtime traffic: pointer motion, cursor positions, intermediate stroke points; each carries a positive transport-local `realtimeCounter`, and newest wins. On the WebSocket all of it is JSON on one ordered socket, so coalesce realtime messages before sending, and presentation frames arrive as binary packets: a four-byte big-endian length, a UTF-8 `presentation.frame` JSON header of that length, then JPEG bytes.

**Commands** carry a nonempty `requestId` and are answered by `<type>.result` with the same `requestId` and `ok`, or an `error`:

| Command | Who | Notes |
|---|---|---|
| `target.select`, `target.create`, `target.close` | any role for select; owner, editor otherwise | selecting is client-local and moves nothing for others |
| `page.navigate`, `page.history-back`, `page.history-forward`, `page.reload`, `page.stop-loading` | owner, editor | act on the client's active target |
| `viewport.set`, `viewport.auto-size.set`, `viewport.owner.claim` | owner, editor | [viewport ownership](#viewport-ownership) |
| `presentation.quality.set`, `presentation.cursor.set` | owner, editor | encoder quality is shared by every WebRTC presentation; cursor visibility is session-wide |
| `automation.pacing.set` | owner, editor | [automation pacing](#automation-pacing) |
| `recording.start`, `recording.stop`, `recording.cancel` | owner, editor | [recordings.md](recordings.md); `recordings.state` carries `editing` while the edit runs |

**Input lease.** Browser input needs the session-wide lease. `input.claim {targetId, mode}` takes it: `implicit` yields to anyone who claims `explicit`; an `explicit` holder is preempted only by an owner displacing an editor. Keep it with `input.heartbeat`, give it back with `input.release`; it is released when the transport is gone for good. While holding it, send `input.pointer.motion.absolute` (realtime), `input.pointer.button`, `input.pointer.scroll`, `input.keyboard.key`, `input.keyboard.text`. Viewers never hold it.

**Presence.** `presence.cursor {targetId, x, y}` and `presence.cursor.clear` show your pointer to others; `follow.set {followingClientId}` adopts another client's active target (chains allowed, cycles rejected, no input rights); `paint.point {targetId, strokeId, color, width, phase, x, y}` draws an ephemeral overlay stroke, allowed for viewers too.

## Viewport ownership

One client at a time, the viewport owner, resizes the browser to its own presentation size. Only clients whose hello carried `autoSize` receive `viewportOwnerClientId` and `autoSize` in snapshots and `viewport.state`. `viewport.auto-size.set {enabled: true}` and `viewport.owner.claim` take ownership; `viewport.set` with `autoSize: true` resizes only for the owner and fails with `viewport_not_owned` otherwise. A `viewport.set` without `autoSize`, or the viewport route, is an explicit resize: it applies and leaves ownership vacant until a client takes it again. The route answers with `targetId`, the media `generation` and the applied `viewport` (logical size, DPR-scaled content size, media canvas in 64 px steps, effective scale); widths below 500 become 500.

## Automation pacing

Browser automation through Playwright MCP runs at one cadence, decided per call:

- the slowest `pace` of the running recordings (`instant` < `fast` < `slow`);
- at least `fast` while a connected owner or editor set `automation.pacing.set {pacing: "watchable"}`;
- **immediate** otherwise. Plain pass-through, no added latency.

At the paced cadences the proxy between Playwright and Chromium turns `Input.dispatchMouseEvent` into real compositor input (the pointer, a real press, a real wheel; modifiers and back/forward buttons stay on CDP), makes `DOM.scrollIntoViewIfNeeded` scroll smoothly and wait for the page to settle, and waits for each input to be delivered. At `instant` the pointer jumps to each point. At `fast` and `slow` it glides there in `a + b·log2(D/W + 1)` (Fitts's law; `D` the distance, `W` the width of the element under the target point along the movement) and lands at least 4 px inside that element: `fast` uses a = b = 75 ms within 100 to 700 ms, `slow` a = b = 150 ms within 200 to 1400 ms and rests twice as long before a press. The path follows the `motion` of the recording that set the pace (the earliest of equally slow ones); watchable pacing alone is linear. Typing is not paced. Pacing is `normal` by default and ends when the client that set `watchable` disconnects.

## WebRTC signaling

Connect to `/sessions/:id/webrtc/signal` with the subprotocols above, send a version 1 SDP `offer`, exchange `ice-candidate` messages, receive the `answer` or a typed signaling `error`. Capacity never evicts an existing peer: if the peer is not usable within five seconds, fall back to `/session`.

## CDP

`cdpUrl` (from create, a session read or `sessions.connection`) is `$APERTURE_BASE_URL/sessions/:id/cdp`. The session token is the next path segment, and nothing else authenticates:

```bash
curl -fsS "$CDP_URL/$SESSION_TOKEN/json/version"
curl -fsS "$CDP_URL/$SESSION_TOKEN/json/list"
```

The `webSocketDebuggerUrl`s in those answers are rewritten onto the same tokenized path; connect to them with no `Authorization` header and no subprotocol. Rotating the session token (`POST /api/sessions/:id/session-token/rotate`, `sessions.session_token_rotate`) breaks every URL built with the old one.

## Local tunnel

A local tunnel lets the browser reach services on the client's machine, such as a dev server. The session's [proxy rules](control-plane.md#egress-proxy) decide what it carries: connections whose rule says `"via": "local"`, for example `{"match": "localhost:3000", "via": "local"}`; the browser addresses them as `localhost`.

Open `GET /sessions/:id/tunnel` with subprotocol `aperture-tunnel.v1`. Binary messages then carry a yamux session in which the client is the yamux server: Aperture opens one stream per matching browser connection, and each stream is a SOCKS5 conversation (no-auth greeting, `CONNECT` to the target) that the client answers by dialing the target locally. A session has one tunnel; a new attach replaces it, and `via: local` connections fail while none is attached.

# Live session

Apply the credential and tenant-selection rules from [authentication.md](authentication.md). For recording routes and recording commands, also read [recordings.md](recordings.md).

## Data-plane routes

These public routes are forwarded to the running session:

- `GET /sessions/:sessionId/session` — live-session WebSocket; editor and viewer capabilities allowed
- `GET /sessions/:sessionId/browser/status` — `sessions:read`
- `POST /sessions/:sessionId/browser/viewport` — `sessions:write`
- `GET /sessions/:sessionId/webrtc/signal` — WebRTC signaling WebSocket
- `GET /sessions/:sessionId/tunnel` — local tunnel WebSocket; `sessionToken` or `sessions:write`

Use an authorized API bearer token and tenant header, or the bound `sessionToken`, for routed live-session requests.

## Local tunnel

A local tunnel carries browser connections over one client-opened WebSocket and dials them on the client's machine, so the browser can reach, for example, a dev server on a developer's laptop. The session's [proxy rules](control-plane.md) decide which connections it carries: those whose rule has `"via": "local"`, such as `{ "match": "localhost:3000", "via": "local" }`. Open `GET /sessions/:sessionId/tunnel` with the `aperture-tunnel.v1` subprotocol to attach.

The browser reaches the client's services as `localhost`, never `127.0.0.1` or `[::1]`: loopback IPs bypass the session proxy.

After the upgrade, binary WebSocket messages carry a yamux session in which the client is the yamux server. Aperture opens one stream per matching browser connection. Each stream carries a SOCKS5 session: a no-auth greeting, then a `CONNECT` with the target. The client dials the target and replies as a SOCKS5 server would. `via: local` connections fail while no client is attached. A new attach replaces the session's previous local tunnel.

## Live-session protocol

Interactive clients use the exact `aperture-session.v1` WebSocket subprotocol on both `/session` and `/webrtc/signal`. Editor and viewer capabilities are also accepted through the bearer subprotocol. A new session transport sends this reliable hello first:

```json
{
  "type": "session.hello",
  "name": "Quiet Otter",
  "avatarHash": "0123456789abcdef0123456789abcdef"
}
```

The server responds with `session.snapshot`, including `clientId` and `resumeSecret`. A replacement transport sends those two values instead of `name` and `avatarHash`, together with normal session authorization. Resume credentials expire five seconds after transport loss.

WebRTC clients create ordered `application` and unordered, zero-retransmit `application-realtime` data channels plus a receive-only video transceiver. The reliable channel carries the hello, snapshots, state, commands, results, input other than pointer motion, and stroke boundaries. The realtime channel carries pointer motion, cursor positions, and intermediate stroke points. Every realtime message has a positive transport-local `realtimeCounter`.

The `/session` fallback carries the same JSON messages. Its presentation frames are binary packets containing a four-byte big-endian JSON-header length, the UTF-8 `presentation.frame` header, and raw JPEG bytes. Coalesce disposable realtime messages before writing them to this ordered socket.

Reliable commands use a nonempty `requestId` and receive a matching typed `.result` message. Commands are `target.select`, `target.create`, `target.close`, `page.navigate`, `page.history-back`, `page.history-forward`, `page.reload`, `page.stop-loading`, `viewport.set`, `presentation.quality.set`, `presentation.cursor.set`, `recording.start`, `recording.stop`, and `recording.cancel`. A transport failure fails outstanding commands. Use the replacement snapshot to reconcile state and wait for a new caller action instead of retrying them.

## Viewport

Viewport body:

```json
{
  "width": 1280,
  "height": 720,
  "deviceScaleFactor": 1
}
```

The response reports the logical size, DPR-scaled content rectangle, `64x64`-bucketed media canvas, and effective scale.

## CDP proxy

CDP uses the session-specific `sessionToken`, not the Aperture API bearer token. Append the token as the next path segment after the returned `cdpUrl`:

```bash
curl -fsS "$CDP_URL/$SESSION_TOKEN/json/version"
curl -fsS "$CDP_URL/$SESSION_TOKEN/json/list"
```

Discovery responses contain rewritten WebSocket debugger URLs under the same tokenized public path. Connect to those URLs without an `Authorization` header or WebSocket subprotocol.

Rotate a compromised session token with `POST /api/sessions/:sessionId/session-token/rotate`; previously issued live-session URLs then stop authorizing.

## WebRTC signaling

Connect to:

```text
wss://aperture.example.com/sessions/:sessionId/webrtc/signal
```

Send these WebSocket subprotocols:

- `aperture-session.v1`
- `authorization.bearer.$SESSION_TOKEN` or an authorized API token
- `x-aperture-tenant-id.$TENANT_ID` when using a system-admin token

Send a version 1 SDP `offer`, then exchange `ice-candidate` messages. The server returns an `answer` or a typed signaling `error`. The authenticated role becomes the session client's role. WebRTC capacity never evicts an existing peer; use `/session` as the fallback when the peer cannot become usable within five seconds.

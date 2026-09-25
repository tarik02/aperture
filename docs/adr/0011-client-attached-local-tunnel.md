---
status: accepted
---

# Client-attached local tunnel over the session proxy

A client can attach a local tunnel to a running session by opening one WebSocket to `/sessions/:sessionId/tunnel`. Browser connections to the hosts the client names are carried over that WebSocket and dialed on the client's machine. This lets a session reach, for example, a dev server on a developer's laptop as `http://localhost:3000`.

## Context

ADR 0010 gives every session a wrapper-owned SOCKS5 proxy with a `tunnel` upstream: the wrapper dials out to an external operator, then runs yamux over the WebSocket and opens one stream per SOCKS `CONNECT`. Exposing a machine that cannot accept inbound connections needs the opposite direction: the machine dials Aperture, and the session's traffic for its hosts flows back through that connection.

## Decision

- **Same protocol, inbound.** The client opens the WebSocket, and after that the stack is the `tunnel` upstream's: binary messages carry yamux, the wrapper is the yamux client and opens one stream per browser connection, and the client terminates SOCKS5 on each stream and dials the target. The wire protocol is named by the `aperture-tunnel.v1` subprotocol. A tunnel operator implementation can serve both directions.
- **Wrapper-owned.** Traefik routes the WebSocket straight to the session wrapper, so the daemon still never handles proxied bytes. Access is `owner`: the session token (`aps_`), or an account with `sessions:write`. Collaboration capabilities cannot attach.
- **Routes from the client.** The client lists the hosts it serves as repeated `route` query parameters: `host`, `host:port`, `*.suffix` for subdomains, or `*` for all traffic. A matching connection goes to the client whatever the session's proxy assignment. Other connections use the assignment as before. The routes live only as long as the WebSocket; nothing is persisted.
- **One per session.** A new attach replaces and closes the previous local tunnel, so a reconnecting client takes over from its stale connection.
- **No fallback.** When the attached client cannot open a stream, a matched connection fails instead of going elsewhere. Once the client disconnects, its routes are gone and connections use the assignment again.
- **Localhost reaches the wrapper.** Chromium used to bypass the proxy for all loopback destinations. It now bypasses only loopback IPs, so `localhost` and `*.localhost` reach the wrapper where a route can claim them. Unclaimed localhost connections are dialed on the session host, as before, and never go to the upstream. Loopback IPs still bypass the proxy entirely, so routes match `localhost`, not `127.0.0.1`.

## Consequences

- A tunnel client needs no Aperture-specific framing: a WebSocket, a yamux server, and a SOCKS5 `CONNECT` handler.
- The wrapper's `/status` reports the attached routes under `proxy.localTunnel`.
- This change adds no client implementation.

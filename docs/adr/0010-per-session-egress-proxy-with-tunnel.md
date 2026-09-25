---
status: accepted
---

# Always-on per-session local proxy with multiplexed tunnel upstream

> The single `upstream` assignment and its `bypass` list are superseded by the proxy rules in [ADR 0011](0011-client-attached-local-tunnel.md). The rest of this decision stands.

Every browser session gets a session-local proxy server (SOCKS5) owned by its `browser-session-wrapper`. Chromium always points at it; the wrapper dials upstream per connection: direct TCP, a configured generic upstream proxy URL (`http`/`https`/`socks`/`socks5`/`socks5h`), or a multiplexed yamux-over-WebSocket tunnel to an external tunnel server. Aperture stays provider-agnostic: it only speaks generic proxy URLs and generic SOCKS5 → yamux → WebSocket tunneling.

Putting the wrapper in the traffic path on every connection enables hostname-based filtering, traffic management, and live upstream switching without touching Chromium.

## Context

Browser automation consumers need all session traffic to egress through an assigned proxy, including through a single public WSS connection that carries many logical TCP streams. The requirements are:

- generic HTTP/HTTPS/SOCKS proxy support on browser sessions;
- one public WSS connection carrying many logical TCP streams (full-duplex, backpressure, independent open/close/reset, half-close, liveness/idle timeouts, authenticated handshake, clean failure on disconnect);
- assignment changes affect new streams only; existing streams finish normally;
- no provider-specific code in Aperture.

Aperture today has no egress-proxy support: proxy-adjacent code is limited to inbound reverse proxies (`internal/browser/wrapper_cdp.go`, `internal/httpapi/middleware.go`, Traefik edge config in `internal/traefik/render.go`). Chromium is launched via `internal/browser/args.go` (`RequiredArgs`/`BuildLaunchArgs`) and `internal/browser/wrapper.go` (`BuildBwrapCommand`), configured through `CreateSession` (`api/openapi.yaml`, `internal/httpapi/session_handlers.go`, `internal/session/service.go`) with runtime delivery via `internal/browser/runtime_env.go`. The outbound WebSocket precedent is `coder/websocket` (`go.mod`), used for live-session transport and CDP dialing.

Multiplexing is settled: Go `hashicorp/yamux` interoperating with Node `yamux-js` (already proven in use; no further spike).

## Reference implementations (proxyhub)

The sibling proxyhub repository already implements each data-plane piece in Go; Aperture mirrors these designs without importing provider-specific code:

- `socks/server.go` — `Socks5Server{Dialer proxy.Dialer, ValidateTarget func(ctx, target) error}` with `ServeConn`: no-auth SOCKS5, `CONNECT` with hostname address type, a `ValidateTarget` hook that rejects disallowed destinations before dialing, SOCKS failure replies, then bidirectional copy. This is the shape of Aperture's local proxy server, including the hook point for future hostname-based filtering.
- `util/copy2.go` — `Copy2(ctx, a, b)`: bidirectional `io.Copy` with first-error capture and half-close propagation (closing the peer direction when one side ends, full close on context cancel). Reference for stream relay in both the local server and the tunnel streams.
- `util/dial.go` — `DialProxyContext`: context-aware dialing over any `proxy.Dialer`, preferring `proxy.ContextDialer`. Reference for upstream dialing with cancellation.
- `wsstream/wsstream.go` — WebSocket → `io.ReadWriteCloser` adapter over binary messages (16 KiB chunks, `io.Pipe`). Reference for running yamux over Aperture's `coder/websocket` connection.
- `proxyclient/proxydialer/dialer.go` — `Dialer` implementing `proxy.Dialer`/`proxy.ContextDialer`: raw-stream mode plus SOCKS5 `CONNECT` handshake over an established stream via `golang.org/x/net/proxy`. This is the primary tunnel precedent: a muxed stream carries a plain SOCKS session, no custom framing.
- `proxyclient/proxytunnel/tunnel.go` — `Tunnel` (also `proxy.Dialer`/`proxy.ContextDialer`): one authenticated WSS connection (`Authorization: Bearer`, `/proxy/:id/tunnel`) carrying a yamux session shared by all streams. Reference for tunnel lifecycle and stream acquisition.
- `proxyclient/transport.go` — newer transport variant: yamux over WSS with shutdown/error channels and control streams. Reference for tunnel lifecycle management. Its sibling `transport/header.go` (length-prefixed JSON per-stream header) was considered for destination signaling and rejected: the SOCKS handshake already carries the destination, so no custom header goes on the wire.

What proxyhub does not have (and Aperture therefore designs itself): an HTTP `CONNECT` proxy server. Aperture's local listener is SOCKS5-only; HTTP(S) proxying upstream is client-side dialing, covered by `golang.org/x/net/proxy` (already an indirect dependency in `go.mod`) plus an HTTP `CONNECT` dialer where needed.

## Decision

### Always-on local proxy server

The wrapper always starts a loopback SOCKS5 server for its session, and Chromium always uses it:

```text
Chromium --proxy-server=socks5://127.0.0.1:<P>
  → wrapper SOCKS5 server (CONNECT only, no-auth, loopback, port 0 → OS-assigned)
  → per-connection upstream dial (strategy from current assignment)
  → direct TCP | generic upstream proxy | yamux stream over WSS tunnel
```

The listener binds `127.0.0.1:0` and lets the OS assign the port — no daemon-side port range is needed. The wrapper passes the actual port to the Chromium process it launches and reports it via `/status` for observability.

Chrome sends SOCKS5 `CONNECT` with the target hostname (no local DNS leak), so the wrapper receives hostnames and forwards them — to the upstream proxy, or in the tunnel stream header for remote resolution. The server accepts hostname, IPv4, and IPv6 address types and forwards them as-is; allowing or rejecting a destination (including literal IPs) is the upstream's decision. The local `ValidateTarget`-style hook stays permissive and is reserved for future local policy.

Consequences of "always":

- Chromium flags are constant across proxy modes; proxy changes never touch the browser.
- The wrapper sees every connection's target hostname, which enables filtering, per-host policy, traffic accounting, and live upstream switching later.
- The bypass list still exempts loopback and wrapper/internal endpoints so Aperture's own control traffic never enters the proxy path.

### Upstream strategies

Each session carries one proxy assignment, stored by Aperture. The assignment selects the upstream strategy for **new** connections; existing connections keep the dialer they started with:

```text
proxy: {
  upstream: direct | proxy | tunnel,
  url?: string,            // proxy mode: generic upstream proxy URL
  tunnel?: { url, auth },  // tunnel mode: WSS endpoint + credentials
  bypass?: string,         // --proxy-bypass-list extension; loopback always bypassed
  allowlist?: string[],    // (future) hostname filter enforced via ValidateTarget-style hook
}
```

- `direct`: wrapper dials target TCP itself. (Still via the local SOCKS so filtering/accounting apply.)
- `proxy`: wrapper dials through the configured generic upstream URL (`http(s)://`, `socks5(h)://`, …). Chromium never sees this URL. Credentials ride in the URL's userinfo and are applied per scheme — Basic `Proxy-Authorization` on the `CONNECT` for `http`/`https`, RFC 1929 username/password for the socks schemes. An omitted port defaults per scheme (1080 socks, 80 http, 443 https).
- `tunnel`: wrapper opens one yamux stream per SOCKS `CONNECT` over the session's authenticated WSS tunnel. The operator terminates SOCKS5 on the stream (same shape as the local server); the wrapper negotiates no-auth on the stream itself, forwards Chromium's `CONNECT` request unmodified, and relays the operator's reply straight back, so the client sees exactly one method-selection reply and one `CONNECT` reply. Only method negotiation is re-originated — the destination bytes are Chromium's, and no custom framing is added.

An assignment update swaps the strategy for new connections only. An explicit hard-rotate option resets live tunnel streams, accepting request failures.

### Assignment API and storage

`CreateSession` accepts an optional `proxy` object (absent = `direct`, preserving current behavior):

```json
"proxy": {
  "upstream": "direct | proxy | tunnel",
  "url": "string, required when upstream=proxy: generic upstream proxy URL, credentials as userinfo; reads mask the password",
  "tunnel": { "url": "string, required when upstream=tunnel: compound tunnel URL (see below)",
              "auth": "string, required when upstream=tunnel: per-assignment bearer secret" },
  "bypass": "string, optional: extra --proxy-bypass-list entries"
}
```

The tunnel URL uses a compound scheme naming the stack bottom-up (wire transport first), e.g.:

```text
wss+yamux+socks5://tunnel.example/<assignment-handle>
ws+yamux+socks5://tunnel.example/<assignment-handle>
```

Parsing rule: split the scheme on `+`; it must be exactly [`ws`|`wss`, `yamux`, `socks5`]. The dial endpoint is the same URL with the scheme replaced by `ws`/`wss`; authority and path are treated opaquely (the path typically carries the operator's assignment handle). Anything else — unknown tokens, extra segments, wrong arity — fails validation. Userinfo, query, and fragment are rejected so URLs stay canonical and log-safe (auth travels in `tunnel.auth`, never in the URL). The fixed token set is deliberate: the stack is currently constant, and a new transport/mux/payload must be implemented before its token is accepted.

- `PUT /api/sessions/{id}/proxy` replaces the assignment (`sessions:write` scope). Same body shape plus an optional `"drain": true` flag for hard-rotate (reset live tunnel streams; new connections use the new assignment either way).
- Validation: `url` required iff `upstream=proxy`; `tunnel.url` + `tunnel.auth` required iff `upstream=tunnel`; empty/whitespace values rejected. Stored assignment is the source of truth for wrapper restarts and wake-from-suspend (via `RuntimeEnvValues`).
- Secrets are write-only: session GET/list responses redact `tunnel.auth` (same redaction rule as tokens — never in logs, metrics labels, or traces).
- Storage: new columns on the sessions table (`proxy_upstream`, `proxy_url`, `proxy_tunnel_url`, `proxy_tunnel_auth`, `proxy_bypass`) via a new migration; not folded into `BrowserArgsJSON`, since proxy is supervisor-owned state rather than user browser args.

### Placement: wrapper-owned, per-session, fate-shared

The SOCKS server and the upstream/tunnel dialers live in `browser-session-wrapper`, one instance per session:

- lifecycle is fate-shared with the browser (no orphan listeners or tunnels, no cross-session port/state leaks);
- configuration arrives through the existing `RuntimeEnvValues` channel; updates are pushed to the running wrapper (or applied on wake) without restarting Chromium;
- Chromium reaches it over loopback, which the bwrap `--share-net` setup already permits;
- the daemon never handles proxied bytes; it only persists assignment and signals the wrapper.

There is one tunnel per session assignment (concurrent tunnels during rotation overlap are expected, not an error state). No daemon-wide shared tunnel.

### Live assignment updates

Push with persisted fallback, mirroring capability rotation (`POST /collaboration/capability-rotated`, daemon side `internal/session/collaboration_capability.go:332-354`):

1. Daemon validates the new assignment, persists it, and rewrites the session's runtime env (source of truth for restarts and wake-from-suspend).
2. If the wrapper is running, the daemon `POST`s the assignment to a new wrapper loopback endpoint (`POST /proxy-assignment`), authenticated with the session's `WRAPPER_CONTROL_TOKEN`. Same-payload re-push is a no-op. The token is required because the browser sandbox shares the host network namespace, so page JavaScript can reach the wrapper API; it lives only in the runtime env and is never served over that API.
3. The wrapper swaps its upstream dialer for new connections immediately, dials the new tunnel on demand, and keeps the previous tunnel until its streams drain (plus an idle timeout). `drain: true` resets live tunnel streams instead.
4. If the wrapper is unreachable (suspended, crashed), the update is still persisted; the wrapper picks it up from the runtime env on next wake/start. Push failure never loses the update — it is reported as a `session.proxy_push_failed` event and the response marks the update unpushed, rather than failing a call whose effects already landed.

### Chromium wiring

Supervisor-owned flags; user-supplied `--proxy-server*` / `--proxy-bypass-list*` become denied in `internal/browser/args.go` alongside the existing denials, as do the switches Chromium resolves ahead of `--proxy-server` (`--no-proxy-server`, `--proxy-pac-url`, `--proxy-auto-detect`, `--winhttp-proxy-resolver`). Denials match on the canonical switch name, since Chromium accepts single- and double-dash spellings alike:

- `--proxy-server=socks5://127.0.0.1:<P>` always;
- `--proxy-bypass-list` always includes loopback plus wrapper/internal endpoints; user override can only extend it;
- `--disable-quic`, because QUIC/UDP has no SOCKS-`CONNECT` path and would otherwise bypass the proxy.

### Tunnel protocol and behavior

- Transport: standard WebSocket over HTTPS (public-ingress compatible) via the existing `coder/websocket` dialer; yamux runs over a `net.Conn` adapter on top of it (see `wsstream` reference). Multiplexing is a yamux layer concern, never WS-message-as-packet framing.
- Handshake: the tunnel URL is a compound `ws(s)+yamux+socks5://` value minted by the tunnel operator and pushed into Aperture (session create / proxy-assignment update); Aperture parses the scheme to select the stack and treats the rest opaquely. The wrapper sends `Authorization: Bearer <per-assignment secret>` plus session binding in a handshake header (`X-Aperture-Session-Id`, non-secret, used by the operator for logging, mapping verification, and duplicate detection). Secrets travel via runtime env, are never logged, and follow the same redaction rule as `aps_` tokens. Rotation = assignment update with a new URL/secret; the wrapper dials fresh and old streams drain.
- Streams: one yamux stream per SOCKS `CONNECT`; the stream carries a plain SOCKS session (no custom header — the `CONNECT` request already encodes the destination), then the bidirectional TCP pipe with close propagation (`Copy2` reference); yamux flow control provides backpressure with bounded buffers.
- Liveness: yamux keepalives plus tunnel idle timeout; tunnel drop fails all its streams cleanly (request errors, pool-safe) without retrying or resuming byte streams.
- Reconnect dials a fresh tunnel with the current assignment; it never replays stream bytes. A wrapper may hold multiple concurrent tunnels (e.g. the previous assignment's tunnel still draining old streams while a new tunnel serves new ones). Aperture guarantees nothing about duplicates — detecting and resolving overlapping tunnels for the same session is operator scope, not Aperture's.

### What Aperture does not do

- No provider-specific concepts (proxy IDs, credentials, inventory, selection) anywhere in this repo.
- Out of scope: login, recovery, portal, or Kubernetes browser code.
- No UDP relay (`CONNECT` only) and no SOCKS authentication on the loopback listener in the first scope. Hostname filtering ships as the hook point only; policy itself is future work.

## Consequences

- New always-on wrapper subsystem: loopback SOCKS5 server (mirroring `socks/server.go`, including the `ValidateTarget` hook), upstream dialers (direct / generic-URL / tunnel), tunnel lifecycle (mirroring `proxytunnel`/`Transport`), relay (mirroring `Copy2`), WS adapter (mirroring `wsstream`). No custom stream framing — tunnel streams carry plain SOCKS sessions. New package under `internal/browser/` or `internal/proxy/`.
- New dependencies: `hashicorp/yamux` (Go side; Node side already settled on `yamux-js`); `golang.org/x/net/proxy` promoted to direct.
- Persisted per-session proxy assignment plus `CreateSession`/update-proxy API surface, `RuntimeEnvValues` fields, and a wrapper update channel for live assignment swaps.
- Test burden for this feature: local SOCKS handshake/replies, upstream strategies, concurrent streams, backpressure/bounded buffering, close/reset, half-close, tunnel disconnect, proxy-failure errors, auth rejection, reconnect behavior, DNS-leak (hostname reaches upstream unresolved) and bypass-list checks.
- Follow-up contract work with the tunnel server operator: exact tunnel URL/auth/session-binding shape, and end-to-end verification against a compatible multiplexed endpoint.

## Delivery order

1. Always-on local SOCKS5 server + constant Chromium flags + arg denials; `direct` upstream first.
2. Generic-URL upstream dialing.
3. WSS/yamux tunnel upstream with health reporting.
4. Assignment create/update API with new-connections-only switching (+ hard-rotate drain).
5. Hardening tests (concurrency, backpressure, close/reset, disconnect, auth, reconnect, DNS-leak, bypass).
6. Hostname filtering policy on the existing hook (future).
7. Contract docs and end-to-end verification against a compatible multiplexed tunnel endpoint.

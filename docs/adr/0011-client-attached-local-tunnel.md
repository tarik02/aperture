---
status: accepted
---

# Rule-based proxy routing with a client-attached local tunnel

A session's proxy configuration is a set of named upstreams and an ordered list of rules. Each rule routes the browser connections its match covers: direct, refused, through an upstream, or through a local tunnel, which is a WebSocket a client opens to the session so that connections are dialed on the client's machine. This lets a session reach, for example, a dev server on a developer's laptop as `http://localhost:3000` while other traffic goes wherever the configuration says.

This replaces the single `upstream: direct | proxy | tunnel` assignment and its `bypass` list from ADR 0010. The wrapper-owned SOCKS5 proxy, the outbound tunnel stack, live updates and write-only secrets stay as ADR 0010 decided.

## Context

ADR 0010 sends all of a session's traffic one way. Two needs didn't fit:

- exposing a machine that cannot accept inbound connections, which needs a tunnel the machine dials, the opposite of the `tunnel` upstream;
- sending different hosts different ways, for example a dev domain through a tunnel, a corporate domain through a proxy, and a blocked domain nowhere.

## Decision

### Configuration

```json
"proxy": {
  "upstreams": {
    "operator": { "url": "wss+yamux+socks5://tunnel.example/x", "auth": "…" },
    "corp":     { "url": "socks5://user:pass@corp:1080" }
  },
  "rules": [
    { "match": "*.test",         "via": "operator" },
    { "match": "*.net",          "via": "http://proxy:8080" },
    { "match": "localhost:3000", "via": "local" },
    { "match": "*.ai",           "via": "refuse" },
    { "match": "*",              "via": "direct" }
  ]
}
```

- **Rules are an ordered list, first match wins.** A JSON object's key order is not a reliable contract, so it can't carry precedence.
- **A match** is `host` or `host:port`. The host is exact, `*.suffix` for subdomains, or `*` for any host.
- **Via** is `direct`, `refuse`, `local`, an upstream name, or an inline proxy URL.
- **Upstreams are named** so a tunnel's `auth` never has to appear in a URL, as ADR 0010 requires, and every secret is stored and redacted in one place. A proxy URL without a secret may be inlined in a rule; a tunnel URL may not, because it needs `auth`.
- **Defaults.** A connection no rule matches goes direct, which preserves the behavior of a session without a configuration.
- **`bypass` is gone:** a `direct` rule expresses it.
- **Secrets.** Upstream `auth` is write-only, and proxy URL passwords are masked on read, both in `upstreams` and in inline `via` URLs.
- **Storage.** The configuration is one JSON column on the session instead of five, and the wrapper gets it as one `PROXY_CONFIG` value. Existing assignments migrate to an equivalent `*` rule.
- **Updates** keep ADR 0010's semantics: new connections use the new rules, and `drain` resets live outbound tunnels. A tunnel to an upstream whose settings did not change keeps serving across updates.
- **The legacy shape is still accepted.** Clients built against ADR 0010 are deployed, so the API translates `upstream`, `url`, `tunnel` and `bypass` into rules: `direct` rules for each `bypass` entry, then one `*` rule via the proxy URL or a `tunnel` upstream. Bypass entries that are not valid matches, such as CIDR ranges or `<local>`, are rejected. Mixing the two shapes is rejected. Session reads also return a deprecated `upstream`, exact when the rules have that form and approximate otherwise, and a push to a wrapper started before this change falls back to its assignment endpoint when the rules have that form.

### Localhost

Chromium used to bypass the proxy for all loopback destinations. It now bypasses only loopback IPs, so `localhost` and `*.localhost` reach the wrapper where a rule can route them.

- **`*` never matches localhost.** A catch-all upstream would otherwise send `localhost` to a remote machine. Only a rule that names localhost routes it.
- **Unrouted localhost** is dialed on the session host, as before.
- **Loopback IPs** still bypass the proxy entirely, so local services are matched as `localhost`, not `127.0.0.1`.

### Local tunnel

- **Same protocol, inbound.** A client opens `GET /sessions/:sessionId/tunnel` with the `aperture-tunnel.v1` subprotocol. After that the stack is the outbound tunnel's: binary messages carry yamux, the wrapper is the yamux client and opens one stream per connection, and the client terminates SOCKS5 on each stream and dials the target. One implementation can serve both directions.
- **Wrapper-owned.** Traefik routes the WebSocket straight to the session wrapper, so the daemon still never handles proxied bytes. Access is `owner`: the session token (`aps_`), or an account with `sessions:write`. Collaboration capabilities cannot attach.
- **Routing stays in the configuration.** The client sends nothing but the tunnel, and `via: local` rules decide what it carries. The configuration is persisted and editable through `PUT /api/sessions/:sessionId/proxy`; the tunnel lasts as long as the WebSocket.
- **One per session.** A new attach replaces and closes the previous local tunnel, so a reconnecting client takes over from its stale connection.
- **No fallback.** A `via: local` connection fails while no client is attached, so a client's hosts never reach a different destination.

## Consequences

- A tunnel client needs no Aperture-specific framing: a WebSocket, a yamux server, and a SOCKS5 `CONNECT` handler.
- The wrapper's `/status` reports the rule count and whether a local tunnel is attached under `proxy`.
- This change adds no client implementation.

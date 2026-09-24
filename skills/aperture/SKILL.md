---
name: aperture
description: Operate an Aperture instance through its public HTTP, WebSocket, and MCP APIs. Use for authentication, tenant and token administration, browser channels, session lifecycle, snapshots, events, MCP tools, CDP discovery/proxying, WebRTC signaling, viewport control, target-scoped recording, and session files.
---

# Aperture

Use the instance's public origin for every request:

```bash
export APERTURE_BASE_URL="https://aperture.example.com"
```

Public surfaces:

- control plane: `$APERTURE_BASE_URL/api/*`
- central MCP: `$APERTURE_BASE_URL/mcp`
- live session data plane: `$APERTURE_BASE_URL/sessions/:sessionId/*`
- session-bound MCP: `$APERTURE_BASE_URL/sessions/:sessionId/mcp`

Treat `/internal/*` as implementation-only. Use only the public surfaces above.

## Route by task

Read every reference whose branch the task touches before acting. For any authenticated operation, read the authentication reference together with the domain reference. Leave unrelated references unloaded.

- Authentication, authorities, scopes, tenant selection, resource grants, errors, or pagination: [references/authentication.md](references/authentication.md)
- Health, browser channels, events, tenants, API tokens, sessions, proxies, or snapshots: [references/control-plane.md](references/control-plane.md)
- Central or session-bound MCP, browser tool profiles, native tools, or MCP limits: [references/mcp.md](references/mcp.md)
- Live-session WebSocket protocol, viewport control, CDP proxying, or WebRTC signaling: [references/live-session.md](references/live-session.md)
- Recording through live-session HTTP, the formal API, live commands, or MCP: [references/recordings.md](references/recordings.md)
- Session-file metadata, signed download URLs, or file downloads: [references/session-files.md](references/session-files.md)

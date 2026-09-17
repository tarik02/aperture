# Aperture MCP

Streamable HTTP MCP, enabled when `mcp_enabled` is true (the default); otherwise both
routes return `404`.

- central management MCP: `$APERTURE_BASE_URL/mcp`
- session-bound MCP: `$APERTURE_BASE_URL/sessions/:sessionId/mcp`

Both authenticate with `Authorization: Bearer`. Central MCP accepts Aperture API tokens
only. Session-bound MCP also accepts that session's `sessionToken`, which can then use
only tools for its bound session.

Read the connected server's tool list and schemas for available tools and arguments;
this file covers only what the schemas do not tell you.

## Central vs session-bound

Central tools take `sessionId` and, for system-admin tokens, `tenantId`. Session-bound
tools bind both from the URL and omit them from their inputs. Never pass `tenantId` with
a tenant token — explicit tenant selection is rejected.

API token resource grants are enforced before any tool reaches a session or snapshot,
and token-creation tools apply the same delegation rules as the HTTP API
(see `api.md`).

## Agent-browser tools

Browser automation tools are selected per connection with the `agentBrowserTools` query
parameter, defaulting to `core,tabs,mobile,network`:

```text
/mcp?agentBrowserTools=core,tabs,mobile,network
/sessions/$SESSION_ID/mcp?agentBrowserTools=core,tabs
```

Profiles are validated when the connection is established and stay fixed for its
lifetime; open a new connection to change them. Browser calls wake the target session
for the duration of the call, while connecting and listing tools do not.

`agent_browser_close` is intentionally absent — Aperture owns the session lifecycle, so
suspend or delete the session instead.

## Limits

- Recording tools start tab recordings only; viewer recordings require a live-session
  client (see `live-session.md`).
- File tools return metadata and signed URLs, never large file contents.
- Tool output is capped at `tool_output_max_bytes` (16 MiB by default).

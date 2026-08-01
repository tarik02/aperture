---
status: accepted
---

# Separate screencast stop from signed file URLs

Aperture will expose `POST /api/sessions/{sessionId}/screencast/stop` for stopping a running screencast and returning its session file metadata, and `POST /api/sessions/{sessionId}/files/download-url` for creating a signed URL from a session-relative path. Keeping these operations separate matches the existing MCP model, lets callers choose whether and when to share a file, and makes signed URL creation useful for session files other than screencasts.

## Considered options

- A combined stop-and-sign operation would save one request but couple screencast control to file sharing and duplicate generic signing behavior.
- Replacing the live attachment response would remove the web UI's direct stop-and-download flow.
- Adding JSON negotiation to the live route would mix two response contracts on one operation and would not expose generic signed URL creation.

## Consequences

- The live `POST /sessions/{sessionId}/screencast/stop` route remains the direct attachment operation.
- The central stop operation requires `sessions:write`, while signed URL creation requires `sessions:read` and accepts the configured default and maximum TTLs.
- Central stop and MCP use one loopback-only wrapper operation that returns the exact stopped file without transferring WebM bytes.
- Signed `apf_` file requests must reach the central token verifier instead of the higher-priority live session file route.

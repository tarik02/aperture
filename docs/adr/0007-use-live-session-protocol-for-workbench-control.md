---
status: accepted
---

# Use live session protocol for workbench control

Aperture's workbench will use the live session protocol for ordinary browser-target state, control, and presentation instead of connecting directly to CDP. The public browser-target ID remains the CDP `targetId`, treated as an opaque identifier outside owner DevTools. A target identity lasts for one live page: it survives navigation and internal remapping, but ends when the page closes or the browser restarts. This preserves ADR 0002's identity and target-scoped media decisions while allowing the session wrapper to keep CDP as its Chromium integration.

Owner raw CDP is a privileged interface outside live-session authorization, input leasing, and protocol ordering. It remains unrestricted and may disrupt collaborators; normal workbench, API, and MCP browser operations use the live-session module instead.

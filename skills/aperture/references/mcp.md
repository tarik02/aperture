# MCP

Aperture exposes Streamable HTTP MCP when `mcp_enabled` is true (the default):

- central management MCP: `/mcp`
- session-bound MCP: `/sessions/:sessionId/mcp`

Both endpoints use `Authorization: Bearer ...`. Central MCP accepts Aperture API tokens only. Session-bound MCP accepts either an authorized API token or that session's `sessionToken`. Apply the authority, tenant-selection, and resource-grant rules from [authentication.md](authentication.md).

Central tools take `tenantId` or `sessionId` where required and expose management, session, snapshot, event, and session-file workflows. Session-bound MCP binds the session from the URL and omits `sessionId` from tool inputs. A session token can use only tools for its bound session.

Central and session-bound MCP apply API token resource grants before native or Playwright tools reach a session or snapshot. `tokens.create` accepts `resourceMode` and `resourceGrants` with the same rules as the REST API.

Browser tool profiles are selected when the MCP connection is established with the `browserTools` query parameter:

```text
/mcp?browserTools=core,vision,network
/sessions/$SESSION_ID/mcp?browserTools=core,vision
```

The default is `core,vision,network`; `storage` is also available. The `vision` profile is accepted for compatibility but adds no tools: the Aperture pointer tools below cover its coordinate tools, and every connection with write access gets them whatever its profiles. Profiles are validated at connection time and remain fixed for that connection. Open a new connection to change profiles. Browser calls wake the target session for the call duration; connecting and listing tools do not wake it. Playwright MCP starts lazily and remains attached for that browser session.

## Pointer tools

Aperture provides its own pointer tools under the names `browser_click`, `browser_move`, `browser_drag`, and `browser_scroll`. They replace Playwright's `browser_click`, `browser_hover`, `browser_drag`, `browser_mouse_click_xy`, `browser_mouse_move_xy`, `browser_mouse_drag_xy`, `browser_mouse_down`, `browser_mouse_up`, and `browser_mouse_wheel`, which are not exposed. Replacements for the removed tools: `browser_hover` is `browser_move`; `browser_mouse_move_xy`, `browser_mouse_click_xy`, and `browser_mouse_drag_xy` are `browser_move`, `browser_click`, and `browser_drag` with `x`/`y` (or `startX`/`startY`/`endX`/`endY`); `browser_mouse_wheel` is `browser_scroll`. There is no replacement for `browser_mouse_down` and `browser_mouse_up`: express a press-move-release as one `browser_drag`. Like other browser tools they take `sessionId` on central connections and hold the input lease for the call.

Locate a position by a snapshot ref or by viewport CSS pixels:

- `target` (a ref from `browser_snapshot`, or a unique selector) with an optional `element` description; or
- `x` and `y`, measured from the top-left of the viewport.

`browser_drag` names its endpoints `startTarget`/`startElement` or `startX`/`startY`, and `endTarget`/`endElement` or `endX`/`endY`; each end may use either form. `browser_scroll` takes `deltaX` and `deltaY`, wheel deltas that scroll by that many CSS pixels (positive scrolls right and down) over a ref, at `x` and `y`, or, with neither, where the pointer last was on the page (the viewport center if it has not been there; without a compositor, where Playwright's mouse is). `browser_click` also takes `button` (`left`, `right`, or `middle`), `clickCount` (1 to 3; Playwright's `doubleClick: true` is accepted as an alias for `clickCount` 2), and `modifiers` (`Alt`, `Control`, `ControlOrMeta`, `Meta`, `Shift`).

Every pointer tool accepts the following:

- `motion` (`browser_click`, `browser_move`, and `browser_drag` only; `browser_scroll` does not accept it): how the pointer travels. `"natural"` (the default) is an eased, slightly curved glide at about 1200 px/s; `"fast"` is quicker; `"instant"` jumps in one step; `{"speed": pxPerSecond}` and `{"durationMs": ms}` set an average speed or a fixed travel time. It has no effect when Playwright input is used.
- `holdMs`: milliseconds to wait after the gesture before the page state is returned, up to 30000. Use it to let a recording show the result; in a bursts recording the burst stays open at least this long after the gesture (see [recordings.md](recordings.md#bursts-recordings)).
- `caption`: up to 500 characters of text kept with the gesture. A recording that captures the gesture saves it as a caption, spanning the gesture and its `holdMs`, in the recording's timeline (see [recordings.md](recordings.md)).
- `timeoutMs`: how long to wait for a ref target to be visible, stable, enabled, and not covered, from 1 to 20000 (default 5000). With Playwright input it bounds the whole call that resolves a ref instead, since Playwright's own tools take no timeout.

The motion used comes from the tool's `motion`, then the `motion` of the newest running recording of the page (set with `recording.start`), then the session setting, then `natural`. Set the session setting with `cursor.set` and read it with `cursor.get`. `cursor.set` takes `visible`, `motion`, or both; the motion lasts until the session stops and is never stored. Cursor visibility needs a compositor: in a session without one, `cursor.set` with `visible` fails with `cursor_requires_compositor` (REST: 409 with the same code) and applies nothing, including a `motion` sent in the same call; `motion` alone works in every session. The REST `GET` and `PUT /api/sessions/:sessionId/cursor` return and accept the same fields.

Which input each tool uses:

- Compositor input (real pointer events on the browser window, so the cursor glides and the gesture shows in live streams and recordings): `browser_click`, `browser_move`, and `browser_drag`, in a session with a compositor.
- Playwright input (events dispatched over CDP, with no cursor travel): `browser_scroll` always, in compositor sessions too, so Chromium scrolls the exact distance and animates it itself, and the tool returns once the scroll has settled. `browser_click`, `browser_move`, and `browser_drag` in sessions without a compositor, and, for a single call, when the compositor cannot place the pointer: elements in cross-origin frames, pinch-zoomed pages, emulated viewports (a viewport that does not scale uniformly to the window), pages whose Content Security Policy blocks string evaluation, and pages that cannot be matched to a compositor surface.

With Playwright input `motion` is ignored, `modifiers` work only on a ref target with a single or double click, a click count of 3 on a ref and a drag between a ref and coordinates need the ref's position and fail if it cannot be determined, and a drag between two refs goes through Playwright's own `browser_drag`.

Common to both: coordinates are viewport CSS pixels, and browser zoom is accounted for. A ref target is scrolled into view and waited on until it is visible, unchanged across two animation frames, not disabled or inert, and the topmost element at its center; if it does not become actionable, the tool returns an error naming the reason. Elements in same-origin frames and open shadow roots are handled. For `browser_drag` between two refs with compositor input, both must be visible at the same time: the end is looked up again after the start is scrolled into view, and if the start's scroll pushed it out of view the tool returns an error asking you to scroll so both fit or to drag between coordinates. The result has the same shape as Playwright's pointer tools: the outcome followed by the page state and accessibility snapshot.

Browser close, browser installation, and arbitrary Playwright-process code execution tools are excluded because Aperture owns the browser lifecycle and does not expose host-process execution. Use `sessions.suspend` or `sessions.delete` to stop a browser session. File references returned by browser tools are session file relative paths (see [session-files.md](session-files.md)) rather than host filesystem paths; automatically named output lands under `outputs/`. `browser_file_upload` accepts any session file relative path, including downloads, recordings, and uploads. Page-provided WebMCP tools are disabled because Aperture exposes a static, authorized browser-tool surface.

Native tool names include `browser_click`, `browser_move`, `browser_drag`, `browser_scroll`, `cursor.get`, `cursor.set`, `sessions.create`, `sessions.create_from_snapshot`, `sessions.list`, `sessions.get`, `sessions.bulk_get`, `sessions.status`, `sessions.connection`, `sessions.suspend`, `sessions.reopen`, `sessions.replace_tags`, `sessions.delete`, `sessions.promote`, `sessions.session_token_rotate`, `snapshots.list`, `snapshots.get`, `snapshots.update`, `snapshots.delete`, `snapshots.replace_tags`, `snapshots.restore`, `events.list`, `session_files.list`, `session_files.create_download_url`, `recording.start`, `recording.list`, `recording.status`, `recording.retarget`, `recording.stop`, `browser.channels`, `browser.targets`, `tenant.get`, `tenant.update`, `tenants.list`, `tenants.create`, `tenants.update`, `tenants.delete`, `tenants.restore`, `tokens.list`, `tokens.create`, and `tokens.revoke`.

MCP tool output is capped at `tool_output_max_bytes` (16 MiB by default). Set `mcp_enabled = false` to make both MCP routes return `404`.

# Aperture Companion

Build the extension, open `chrome://extensions`, enable Developer mode, and load `dist` with
**Load unpacked**:

```sh
pnpm --filter @aperture-browser/companion build
```

The build generates every PNG extension icon from `public/icon.svg`.

GitHub releases include an `aperture-companion-<version>.zip`. Extract it before selecting the
resulting directory with **Load unpacked**.

The Aperture URL defaults to the current tab's HTTP or HTTPS origin unless you have entered a URL.
Click **Connect with Aperture** to use site login. Sign in on
Aperture and approve the tenants and permissions the companion needs. The connection appears
under **Connected apps**, where you can revoke it. Disconnecting it in the extension also revokes
the grant. Site login requires an Aperture instance with browser login and MCP enabled.

Site login uses an authorization code with PKCE and refreshes expiring access tokens automatically.
Credentials stay in `chrome.storage.local` and are never synchronized. If you approve multiple
tenants, the connection uses the first available tenant.

Alternatively, click **Use API token instead** and use a regular Aperture tenant API token. The extension requires `sessions:read` and
`sessions:write`; add `snapshots:read` to start from existing snapshots and `snapshots:write` to
teleport directly into a snapshot. Tokens stay in `chrome.storage.local` and are never
synchronized.

Teleport imports available cookies (including HTTP-only and partitioned cookies), local and
session storage, IndexedDB, Cache Storage, OPFS, scroll positions, `window.name`, `history.state`,
and mutable document state such as form values, contenteditable markup, focus, and selection.
Selected popup tabs retain their opener relationship when their parent tab is also selected.
Cookies are captured from each selected tab's cookie store and each captured frame's exact
partition, including its cross-site ancestor setting.
Teleport requests access to the selected page origins and their parent sites, which Chrome
requires to read cookie partitions. Private suffixes such as `github.io` keep separate sites
separate.
Extractable Web Crypto keys stored in IndexedDB are preserved. File inputs, non-extractable
cryptographic keys, closed shadow roots, iframe document state, and in-memory JavaScript state
cannot be transferred.

Snapshot teleports create a session asynchronously and wait for restoration before promotion.
The companion saves the session ID and resumes progress when its background worker restarts.
If creation was interrupted before its ID could be saved, check Aperture before retrying.
An existing snapshot with the same name is preserved and the teleport reports a conflict.

# Aperture Companion

Build the extension, open `chrome://extensions`, enable Developer mode, and load `dist` with
**Load unpacked**:

```sh
pnpm --filter @aperture-browser/companion build
```

The build generates every PNG extension icon from `public/icon.svg`.

GitHub releases include an `aperture-companion-<version>.zip`. Extract it before selecting the
resulting directory with **Load unpacked**.

Connect it with a regular Aperture tenant API token. The extension requires `sessions:read` and
`sessions:write`; add `snapshots:read` to start from existing snapshots and `snapshots:write` to
teleport directly into a snapshot. Tokens stay in `chrome.storage.local` and are never
synchronized.

Teleport imports available cookies (including HTTP-only and partitioned cookies), local and
session storage, IndexedDB, Cache Storage, OPFS, scroll positions, `window.name`, `history.state`,
and mutable document state such as form values, contenteditable markup, focus, and selection.
Selected popup tabs retain their opener relationship when their parent tab is also selected.
Extractable Web Crypto keys stored in IndexedDB are preserved. File inputs, non-extractable
cryptographic keys, closed shadow roots, iframe document state, and in-memory JavaScript state
cannot be transferred.

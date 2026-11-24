# Aperture Companion

An extension for a Chromium browser of your own. It takes the tabs you choose, with what their sites keep in your browser, and opens them in an [Aperture](../../README.md) session, or keeps them as a snapshot: a teleport. It speaks to a control plane of Aperture v2, as `@aperture-browser/control-api` has it.

## Loading it

```sh
pnpm --filter @aperture-browser/companion build
```

Open `chrome://extensions`, turn on **Developer mode**, and choose **Load unpacked** on `dist`. The build draws the PNG icons from `public/icon.svg`, and writes the manifest's version from `package.json`.

A release has an `aperture-companion-<version>.zip`: extract it, and choose the directory it gives with **Load unpacked**.

## Connecting

The Aperture URL is offered as the current tab's origin until you enter another. The extension asks the browser for access to that origin, and to nothing else of Aperture.

**Connect with Aperture** is OAuth, as an MCP client does it: the extension registers itself with the control plane, opens the console in a window of the browser's own (`chrome.identity.launchWebAuthFlow`), and exchanges the code it is answered with, using PKCE. It asks for `sessions:read`, `sessions:write`, `snapshots:read` and `snapshots:write`; you approve what you choose, and may hold it to workspaces. It needs at least `sessions:write`. The access token lasts an hour and is renewed with the refresh token, which is used once each: the extension renews under a lock, in its worker, so that the popup closing loses neither. What you approved is listed in the console under **Account**, **Connections**. Removing the connection in the extension gives the grant back; so does revoking it there.

**Use API token instead** takes an `apc_…` token of an account. It needs `sessions:write`; add `snapshots:read` to start sessions from snapshots and `snapshots:write` to teleport into one.

Tokens are kept in `chrome.storage.local`, which the browser does not synchronise.

A connection makes sessions and snapshots in one place: **Personal**, the account's own, or a workspace the account is in. Where there is more than one, the popup asks which, and remembers it for the connection. A token held to resources has the workspaces it names and no personal place.

## What a teleport moves

Cookies (`HttpOnly` and partitioned ones included), local and session storage, IndexedDB, Cache Storage, private files (OPFS), scroll positions, `window.name`, `history.state`, and what a document holds that changes: form values, editable text, focus and selection. A tab that another chosen tab opened keeps it as its opener.

Cookies are taken from the cookie store of each chosen tab, and from the partition of each of its frames, with whether a frame of another site stands between. For that the extension asks for access to the origins of the chosen pages and to their sites, which the browser requires to tell a frame's partition. Storage is taken once for each origin as it is embedded: on its own, and below each chain of frames it was found in.

Dates, bytes, maps, sets, files, blobs and Web Crypto keys that may be exported keep their kind, in databases and in `history.state` alike. The extension takes all of it with the session runner's own scripts (`crates/runner/src/live/state`), which are what puts it back, so the two cannot disagree on the form.

Not moved: files chosen in a form, keys that may not be exported, closed shadow roots, the document state of frames, cache entries the browser does not let a page read, and what a page has in memory alone. A kind of storage over 32 MiB for one origin is left out, and so is, from the last origin back, as much as brings the whole under 48 MiB: caches first, then files, then databases. What was left out is said when the teleport ends.

## Sessions and snapshots

A teleport into a session creates it with the state and opens it in the console at once. Aperture answers for the session as soon as its browser runs and puts the state in after: the session's page says that it is being restored, and what is put in, while its tabs arrive, and takes no input until all of it is in. The popup is done by then, and says so.

A teleport into a snapshot creates the session, waits until it is restored, suspends it, takes the snapshot and deletes the session, and the popup says which of these it is at. A session that was not restored is deleted, and why is told. A snapshot keeps the profile, so cookies and storage are in it and what the pages showed is not. Aperture holds nobody to one snapshot of a name: the extension refuses a name that is taken in the place you chose, before it makes anything, and leaves that snapshot as it is.

The browser asks for access to the pages' sites in a prompt of its own, and the popup may close over it; the worker keeps the teleport until the sites are given. Where they are refused, or the browser puts no prompt up, the popup says which sites were not given and that nothing was teleported, and nothing is kept waiting. A popup that opens and finds a teleport waiting for sites nobody is asked for any more, as after a prompt that was dismissed, offers **Give access** and **Cancel** in place of the form. The sites are taken whole or not at all: pages without their sites' cookies would be put back broken. What nobody answers runs out after two minutes.

The worker notes how far a teleport came. One it was stopped in goes on from there when the worker starts again: a snapshot that was being taken is looked for before another is asked for. A teleport that was stopped while the session was being created is not asked for again, since whether it was made is not known: look in Aperture before trying again.

## Checks

`pnpm --filter @aperture-browser/companion test` checks the value codec, the cookies, and the step no browser check reaches: the browser's prompt for sites being answered, refused, not put up, and left behind by a popup that closed. `apps/control/tests/companion.test.ts` loads the built extension into a browser and teleports a signed-in tab through a control plane of its own.

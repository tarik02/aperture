---
status: accepted
---

# One files root per session

Every session file lives below `<store_root>/sessions/<bucket>/<session-id>/files/`, and a session file is identified by its path relative to that root:

```text
files/
  downloads/    Chromium download directory
  recordings/   recorder output
  uploads/      POST /sessions/:sessionId/uploads
  outputs/      Playwright MCP --output-dir
```

The REST listing, MCP `session_files.list`, signed download URLs, upload responses, recording results, and Playwright browser tools all use these relative paths. The daemon and the wrapper list and resolve them through one shared implementation (`internal/sessionfiles`). Logs and crash dumps stay under `artifact_root`; they are not session files.

Inside the browser sandbox the root is mounted at the fixed path `/session/files`. Chromium's download directory is `/session/files/downloads`, and every session file below the root reports `sandboxPath` (`/session/files/<relativePath>`) for CDP `DOM.setFileInputFiles`. The path is the same for every session, so it reveals nothing about the host and stays valid in profiles carried into snapshots. The recorder and Playwright MCP run in the wrapper outside the sandbox and use the host root directly. Playwright MCP's workspace is the root, so `browser_file_upload` accepts any relative path. Because Playwright hands the browser the host paths it resolves, the sandbox also mounts the root at its host path. That mount is internal and never appears in API responses.

## Context

Files used to be spread across three places: downloads and recordings under the session store directory, uploads and Playwright output under `artifact_root`. The wrapper listed uploads, downloads, and artifacts with one path scheme, while the API and MCP listed downloads and recordings with another. Playwright could only read the artifact directory, so reusing a download in a file chooser meant downloading and re-uploading it. Uploads also returned host paths.

## Decision

- One root, with the subdirectories above, derived by `paths.SessionFiles`.
- The wrapper's own `GET /sessions/:sessionId/files` listing and download routes are removed. They only worked while the session ran and duplicated the control-plane listing and signed downloads, which work in every retained state.
- Upload responses return the regular session file shape, including `sandboxPath`. Host paths are never exposed.
- Session files are separate from snapshots. Promotion materializes only the overlay lower and upper directories (the browser profile), and the files root is outside both, so a snapshot never contains session files. A session created from a snapshot gets a new, empty files root. The profile may still remember past downloads in its history, pointing at `/session/files/downloads/…` paths that do not exist in the new session.
- Session files are served over the REST API and MCP only. Session-token holders reach them through session-bound MCP; there is no REST route authorized by the session token.
- Hidden entries (in-progress uploads, recording segments) are not session files.

## Existing sessions

Sessions created before this change keep their files where they were, because a wrapper that is still running may be writing to those directories. Moving them is unsafe until the wrapper stops. The shared implementation reads these legacy directories as well, under the same relative paths:

- `<session>/downloads` → `downloads/`
- `<session>/recordings` → `recordings/`
- `<artifact_root>/…/uploads` → `uploads/`
- top-level files of `<artifact_root>/…` → `outputs/`

Relative paths of downloads, recordings, and uploads are unchanged, so already-issued signed URLs and stored references keep working. Playwright output that was named `<file>` is now `outputs/<file>`. Legacy files have no `sandboxPath`. When an old session next starts, it writes to the new root, and its legacy files stay listable and downloadable but are no longer reachable from the browser. The legacy mapping can be deleted once every session created before this change has expired.

## Addendum: managing files and directories

Session files and directories can be managed over REST in every retained state, so a file manager does not need the session to run:

- `POST /api/sessions/:sessionId/files?directory=…` stores multipart files in any directory below the root, `uploads` by default. The data-plane `POST /sessions/:sessionId/uploads` stays for session-token holders of a running session.
- `POST /api/sessions/:sessionId/files/directories` creates a directory with its missing parents.
- `DELETE /api/sessions/:sessionId/files?relativePath=…` deletes a file or directory. A directory that still has entries needs `recursive=true`.
- `POST /api/sessions/:sessionId/files/move` moves or renames a file or directory. It never overwrites and cannot move a directory into itself.

The daemon applies these directly to the files root through `internal/sessionfiles`, using the same path rules as every other file route. It records `session.file_uploaded`, `session.file_deleted`, `session.file_moved`, `session.directory_created`, `session.directory_deleted`, and `session.directory_moved` events.

The listing returns directories as entries next to files (`type: "directory"`), so empty directories show up. Directories are only removed when a user deletes them, never automatically. `downloads`, `recordings`, `uploads`, and `outputs` cannot be deleted or moved, because the browser, recorder, wrapper, and Playwright write into them.

Anything still being written cannot be moved or deleted, including anything inside a directory being moved or deleted:
- in-progress Chromium downloads (`.crdownload`)
- upload placeholders
- hidden entries, which are active recording segments and staged uploads

Signed download URLs can be created with `disposition: inline` for previews. Every signed download is served with its detected `Content-Type`, byte ranges, and `X-Content-Type-Options: nosniff`. Content that can run scripts, such as HTML or SVG, also gets `Content-Security-Policy: sandbox`, so opening it inline cannot run scripts under the Aperture origin. Media, PDFs, and plain text are left unsandboxed because sandboxing only breaks Chrome's viewers.

Changes that check limits take an exclusive lock on the files root, shared by the daemon and the session's wrapper, so concurrent uploads cannot overrun the storage quota together. Uploads stream into unnamed (`O_TMPFILE`) temporary files without the lock and hold it only for the final limit check and link (with a `/proc/self/fd` fallback where `linkat` with `AT_EMPTY_PATH` needs a capability, before Linux 6.10), so a slow client delays nothing but its own upload, and a crash mid-upload leaves nothing behind. Waiting for the lock ends with the request. Because streamed bytes count only once published, each process streams at most 3 uploads per session at once. A recording is likewise finalized under a hidden name and published without replacing an existing file, taking a numbered name instead. Because empty files and directories cost no quota bytes, the files root is also capped at 10000 entries. Creating any entry below the files root first creates `downloads`, `recordings`, `uploads`, and `outputs`, so their names stay reserved even in sessions from before the files root.

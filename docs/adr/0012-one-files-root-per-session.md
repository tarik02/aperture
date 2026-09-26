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

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

The REST listing, MCP `session_files.list`, signed download URLs, upload responses, recording results, and Playwright browser tools all use these relative paths. The daemon lists and resolves them through one shared implementation (`internal/sessionfiles`). The wrapper receives the root as `FILES_DIR`, bind-mounts it into the browser sandbox, and runs Playwright MCP with the root as its workspace, so `browser_file_upload` accepts any session file. Logs and crash dumps stay under `artifact_root`; they are not session files.

## Context

Files used to be spread across three places: downloads and recordings under the session store directory, uploads and Playwright output under `artifact_root`. The wrapper listed uploads, downloads, and artifacts with one path scheme, while the API and MCP listed downloads and recordings with another. Playwright could only read the artifact directory, so reusing a download in a file chooser meant downloading and re-uploading it. Uploads also returned host paths.

## Decision

- One root, with the subdirectories above, derived by `paths.SessionFiles`.
- The wrapper's own `GET /sessions/:sessionId/files` listing and download routes are removed. They only worked while the session ran and duplicated the control-plane listing and signed downloads, which work in every retained state.
- Upload responses return the regular session file shape. Host paths are never exposed. Because the sandbox bind-mounts host paths at the same location, there is no separate sandbox path to offer, so raw CDP `DOM.setFileInputFiles` cannot address uploads; `browser_file_upload` can.
- Hidden entries (in-progress uploads, recording segments) are not session files.

## Existing sessions

Sessions created before this change keep their files where they were, because a wrapper that is still running may be writing to those directories. Moving them is unsafe until the wrapper stops. The shared implementation reads these legacy directories as well, under the same relative paths:

- `<session>/downloads` → `downloads/`
- `<session>/recordings` → `recordings/`
- `<artifact_root>/…/uploads` → `uploads/`
- top-level files of `<artifact_root>/…` → `outputs/`

Relative paths of downloads, recordings, and uploads are unchanged, so already-issued signed URLs and stored references keep working. Playwright output that was named `<file>` is now `outputs/<file>`. When an old session next starts, it writes to the new root; its legacy files stay readable but are no longer reachable by Playwright. The legacy mapping can be deleted once every session created before this change has expired.

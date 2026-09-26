---
status: accepted
---

# Hot, cold, and database storage

Aperture's persistent state is split across three separately configured locations, because they need different filesystems:

| Location | Holds | Filesystem |
| --- | --- | --- |
| `store_root` (hot) | Overlay state of running and stopped sessions: `sessions/<bucket>/<id>/{upper,work,merged,cache,metadata}`, and the empty lower directory | Local. overlayfs cannot use an NFS upper directory. |
| `cold_root` (cold) | Snapshots (`snapshots/<bucket>/<id>/profile`) and session files (`sessions/<bucket>/<id>/files`) | Local or NFS v3 or later with a lock manager, exported without root squashing. |
| `database_path` | The SQLite database | Local. SQLite locking is unreliable on NFS. |

Snapshots and session files grow without bound and outlive the sessions that produced them, so they are what an operator wants on large shared storage. The overlay state of a session is small, hot, and tied to the host that mounts it.

## Decisions

- `cold_root` defaults to `store_root`, and both use the same relative paths. An install that does not set `cold_root` keeps every file where it was; an install whose `cold_root` names its `store_root` through a symlink or bind mount is treated the same.
- Nothing reads both locations. When `cold_root` differs from `store_root`, `aperture serve` refuses to start while snapshots or session files remain under `store_root`, and `aperture storage migrate` moves them while Aperture is stopped and no session overlay is mounted. The legacy session file directories of ADR 0012 stay under `store_root` and `artifact_root` and are still read there.
- `store_root` and `cold_root` must be set in the config file. The root mount helpers read only the trusted config file, and they need `cold_root` to find a snapshot used as a lower layer and to create a session's files directories. `aperture serve` loads the helper's config the way the helper does and refuses to start when its `store_root` or `cold_root` differs from the daemon's, for example because a root was set only through the environment.
- `cold_root` carries a `.aperture-root` marker holding the install ID, which the database migrations create. `aperture serve` accepts a `cold_root` whose marker matches. A missing marker is written when nothing can be lost: when the database has no live snapshot (not yet collected) or session (not expired), or when `cold_root` is `store_root`, which is local and where installs from before the marker keep their data. Otherwise it refuses to start: a missing marker with live data under a separate `cold_root` means an unmounted share or a wrong path, and a marker with another ID means another install's data or a restored database. `aperture storage migrate` refuses a `cold_root` marked by another install and writes the marker. The marker sits at the top of `cold_root`, where nothing lists, moves, or collects entries.
- Session files are removed with the session's overlay state when it expires; snapshots are removed by garbage collection, both under `cold_root`.

## Considered options

- **Read both locations.** Every consumer of snapshots and session files (mount helper, promotion, the file API, the wrapper, garbage collection, the stale staging sweep) would have to pick a location per entry, and new writes would still need one answer. A one-shot migration keeps a single location in the code.
- **Move data automatically at startup.** Copying snapshots to NFS can take long and runs while browsers may be using them; an explicit command run with Aperture stopped makes the operator choose the moment.
- **A new `session-files/` tree under `cold_root`.** Clearer on its own, but it would move every file of existing installs even when `cold_root` is left at its default.

## Consequences

- Promotion materializes a snapshot on `cold_root` from a session upper directory on `store_root`, which crosses filesystems. Files from the session upper are copied (a reflink is tried first); files unchanged from the parent snapshot are hard-linked, since both snapshots are under `cold_root`. The final rename of a snapshot stays within `cold_root`.
- Moving a file from a legacy directory under `store_root` into the files root crosses filesystems when `cold_root` is elsewhere and is rejected as outside the files root, like legacy files under `artifact_root` already were.
- An NFS `cold_root` that is not mounted when Aperture starts is detected by its missing marker once the install has data. A fresh install that starts before its share is mounted marks the bare mount point instead and is refused once the share is mounted over it and the install has data. Moving `cold_root` to another place without moving its data is refused the same way.
- Backups of the three locations are out of scope.

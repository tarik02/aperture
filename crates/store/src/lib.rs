//! A node's local storage: sessions, the layers their profiles are made of, and snapshots.
//!
//! A session's profile is an overlay: the session's own upper directory over a chain of
//! layers. A layer is a directory that never changes again, with at most one parent.
//! Taking a snapshot moves the session's upper directory into a new layer and gives the
//! session an empty one over it, so a snapshot costs a rename whatever the profile's size,
//! and sessions created from it share its files.
//!
//! ```text
//! <root>/layers/<id>/{layer.json,fs/}
//! <root>/snapshots/<id>.json
//! <root>/sessions/<id>/{session.json,upper/,work/,cache/,files/,logs/,state/}
//! ```

use std::{
    collections::HashSet,
    fs, io,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize, de::DeserializeOwned};

/// What Chromium leaves in a profile about the process that had it open. A profile that
/// carries them to another process looks locked to it.
const PROCESS_FILES: &[&str] = &[
    "SingletonLock",
    "SingletonSocket",
    "SingletonCookie",
    "DevToolsActivePort",
];

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("session {0} not found")]
    SessionNotFound(String),
    #[error("snapshot {0} not found")]
    SnapshotNotFound(String),
    #[error("{0:?} is not an id")]
    InvalidId(String),
    #[error("{path}: {source}")]
    Io { path: PathBuf, source: io::Error },
    #[error("{path}: {source}")]
    Record {
        path: PathBuf,
        source: serde_json::Error,
    },
}

type Result<T> = std::result::Result<T, StoreError>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRecord {
    pub id: String,
    pub created_at_ms: u64,
    /// The snapshot the session was created from.
    pub snapshot_id: Option<String>,
    /// The layer right below the session's upper directory.
    pub base_layer: Option<String>,
    /// The layer a snapshot in progress moves the upper directory into. `Store::open`
    /// finishes or drops what a crash left here.
    #[serde(default)]
    pub freezing: Option<String>,
    /// How the session's browser connections are routed, as whoever runs the session
    /// reads it. It holds the secrets of the session's upstreams.
    #[serde(default)]
    pub proxy: Option<serde_json::Value>,
    /// What the session may use and how long it may sit idle, as whoever runs the session
    /// reads it.
    #[serde(default)]
    pub limits: Option<serde_json::Value>,
    /// It was suspended for sitting idle, and is to be resumed when someone reaches it.
    #[serde(default)]
    pub asleep: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotRecord {
    pub id: String,
    pub name: Option<String>,
    pub session_id: String,
    pub layer: Option<String>,
    pub created_at_ms: u64,
}

#[derive(Debug, Serialize, Deserialize)]
struct LayerRecord {
    parent: Option<String>,
}

/// A session's directories, for whatever runs its browser.
#[derive(Debug, Clone)]
pub struct SessionPaths {
    /// The layers below the upper directory, the lowest first.
    pub lowers: Vec<PathBuf>,
    pub upper: PathBuf,
    pub work: PathBuf,
    pub cache: PathBuf,
    pub files: PathBuf,
    pub logs: PathBuf,
    /// What whoever runs the browser keeps of the session between its runs.
    pub state: PathBuf,
}

pub struct Store {
    root: PathBuf,
}

impl Store {
    pub fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let store = Self { root: root.into() };
        for dir in ["layers", "snapshots", "sessions"] {
            create_dir_all(&store.root.join(dir))?;
        }
        // A directory without its record is a session a crash left half created or half
        // removed.
        for entry in read_dir(&store.root.join("sessions"))? {
            if !entry.join("session.json").exists() {
                remove_dir_all(&entry)?;
            }
        }
        for session in store.sessions()? {
            if session.freezing.is_some() {
                store.settle_freeze(session)?;
            }
        }
        store.collect_layers()?;
        Ok(store)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn create_session(
        &self,
        snapshot_id: Option<&str>,
        proxy: Option<serde_json::Value>,
        limits: Option<serde_json::Value>,
    ) -> Result<SessionRecord> {
        let base_layer = match snapshot_id {
            Some(id) => self.snapshot(id)?.layer,
            None => None,
        };
        let session = SessionRecord {
            id: new_id(),
            created_at_ms: now_ms(),
            snapshot_id: snapshot_id.map(str::to_owned),
            base_layer,
            freezing: None,
            proxy,
            limits,
            asleep: false,
        };
        // Built aside and renamed into place, so the session appears with its record.
        let staged = self.root.join("sessions").join(format!(".{}", session.id));
        for sub in ["upper", "work", "cache", "files", "logs", "state"] {
            create_dir_all(&staged.join(sub))?;
        }
        write_record(&staged.join("session.json"), &session)?;
        rename(&staged, &self.session_dir(&session.id))?;
        Ok(session)
    }

    pub fn session(&self, id: &str) -> Result<SessionRecord> {
        check_id(id)?;
        read_record(&self.session_dir(id).join("session.json"))?
            .ok_or_else(|| StoreError::SessionNotFound(id.to_owned()))
    }

    pub fn set_session_proxy(&self, id: &str, proxy: Option<serde_json::Value>) -> Result<()> {
        let mut session = self.session(id)?;
        session.proxy = proxy;
        write_record(&self.session_dir(id).join("session.json"), &session)
    }

    pub fn set_session_asleep(&self, id: &str, asleep: bool) -> Result<()> {
        let mut session = self.session(id)?;
        if session.asleep != asleep {
            session.asleep = asleep;
            write_record(&self.session_dir(id).join("session.json"), &session)?;
        }
        Ok(())
    }

    pub fn sessions(&self) -> Result<Vec<SessionRecord>> {
        let mut sessions = Vec::new();
        for entry in read_dir(&self.root.join("sessions"))? {
            if let Some(session) = read_record::<SessionRecord>(&entry.join("session.json"))? {
                sessions.push(session);
            }
        }
        sessions.sort_by(|a, b| (a.created_at_ms, &a.id).cmp(&(b.created_at_ms, &b.id)));
        Ok(sessions)
    }

    pub fn session_paths(&self, id: &str) -> Result<SessionPaths> {
        let session = self.session(id)?;
        let dir = self.session_dir(id);
        let mut lowers = Vec::new();
        let mut layer = session.base_layer;
        while let Some(id) = layer {
            lowers.push(self.layer_dir(&id).join("fs"));
            layer = self.layer(&id)?.parent;
        }
        lowers.reverse();
        Ok(SessionPaths {
            lowers,
            upper: dir.join("upper"),
            work: dir.join("work"),
            cache: dir.join("cache"),
            files: dir.join("files"),
            logs: dir.join("logs"),
            state: dir.join("state"),
        })
    }

    /// Removes the session with its profile and files. Its browser must not be running.
    pub fn delete_session(&self, id: &str) -> Result<()> {
        self.session(id)?;
        let dir = self.session_dir(id);
        // The record goes first, so that what a crash leaves is not taken for a session.
        remove_file(&dir.join("session.json"))?;
        remove_dir_all(&dir)?;
        self.collect_layers()
    }

    /// Takes a snapshot of the session's profile. Its browser must not be running.
    pub fn create_snapshot(&self, session_id: &str, name: Option<&str>) -> Result<SnapshotRecord> {
        let mut session = self.session(session_id)?;
        let dir = self.session_dir(session_id);
        let upper = dir.join("upper");
        for name in PROCESS_FILES {
            remove_file(&upper.join(name))?;
        }

        // A session that changed nothing since its base shares the base's layer.
        let layer = if read_dir(&upper)?.is_empty() {
            session.base_layer.clone()
        } else {
            let layer = new_id();
            session.freezing = Some(layer.clone());
            write_record(&dir.join("session.json"), &session)?;
            self.settle_freeze(session)?;
            Some(layer)
        };

        let snapshot = SnapshotRecord {
            id: new_id(),
            name: name.map(str::to_owned),
            session_id: session_id.to_owned(),
            layer,
            created_at_ms: now_ms(),
        };
        write_record(&self.snapshot_path(&snapshot.id), &snapshot)?;
        Ok(snapshot)
    }

    pub fn snapshot(&self, id: &str) -> Result<SnapshotRecord> {
        check_id(id)?;
        read_record(&self.snapshot_path(id))?
            .ok_or_else(|| StoreError::SnapshotNotFound(id.to_owned()))
    }

    pub fn snapshots(&self) -> Result<Vec<SnapshotRecord>> {
        let mut snapshots = Vec::new();
        for entry in read_dir(&self.root.join("snapshots"))? {
            if entry
                .extension()
                .is_some_and(|extension| extension == "json")
                && let Some(snapshot) = read_record::<SnapshotRecord>(&entry)?
            {
                snapshots.push(snapshot);
            }
        }
        snapshots.sort_by(|a, b| (a.created_at_ms, &a.id).cmp(&(b.created_at_ms, &b.id)));
        Ok(snapshots)
    }

    /// Removes the snapshot. The layers it named stay for as long as a session or another
    /// snapshot is built on them.
    pub fn delete_snapshot(&self, id: &str) -> Result<()> {
        self.snapshot(id)?;
        remove_file(&self.snapshot_path(id))?;
        self.collect_layers()
    }

    /// Moves the upper directory into the layer named by `freezing` and puts the session on
    /// top of it, from wherever an earlier attempt stopped.
    fn settle_freeze(&self, mut session: SessionRecord) -> Result<()> {
        let Some(layer) = session.freezing.take() else {
            return Ok(());
        };
        let dir = self.session_dir(&session.id);
        let upper = dir.join("upper");
        let layer_dir = self.layer_dir(&layer);
        let record = layer_dir.join("layer.json");

        if !record.exists() {
            create_dir_all(&layer_dir)?;
            // The upper directory is still the session's when a crash came before the rename.
            if !layer_dir.join("fs").exists() {
                rename(&upper, &layer_dir.join("fs"))?;
            }
            // The record makes the layer one: without it, the directory is collected.
            write_record(
                &record,
                &LayerRecord {
                    parent: session.base_layer.clone(),
                },
            )?;
        }
        // Overlayfs keeps indexes of the upper directory it worked for in here.
        remove_dir_all(&dir.join("work"))?;
        create_dir_all(&dir.join("work"))?;
        create_dir_all(&upper)?;
        session.base_layer = Some(layer);
        write_record(&dir.join("session.json"), &session)
    }

    /// Removes the layers no session and no snapshot is built on.
    fn collect_layers(&self) -> Result<()> {
        let mut used = HashSet::new();
        let tops = self
            .sessions()?
            .into_iter()
            .flat_map(|session| [session.base_layer, session.freezing])
            .chain(self.snapshots()?.into_iter().map(|snapshot| snapshot.layer));
        for top in tops {
            let mut layer = top;
            while let Some(id) = layer {
                if !used.insert(id.clone()) {
                    break;
                }
                layer = read_record::<LayerRecord>(&self.layer_dir(&id).join("layer.json"))?
                    .and_then(|record| record.parent);
            }
        }
        for entry in read_dir(&self.root.join("layers"))? {
            let name = entry.file_name().and_then(|name| name.to_str());
            if name.is_none_or(|name| !used.contains(name)) {
                remove_file(&entry.join("layer.json"))?;
                remove_dir_all(&entry)?;
            }
        }
        Ok(())
    }

    fn layer(&self, id: &str) -> Result<LayerRecord> {
        let path = self.layer_dir(id).join("layer.json");
        read_record(&path)?.ok_or_else(|| StoreError::Io {
            path,
            source: io::ErrorKind::NotFound.into(),
        })
    }

    fn session_dir(&self, id: &str) -> PathBuf {
        self.root.join("sessions").join(id)
    }

    fn layer_dir(&self, id: &str) -> PathBuf {
        self.root.join("layers").join(id)
    }

    fn snapshot_path(&self, id: &str) -> PathBuf {
        self.root.join("snapshots").join(format!("{id}.json"))
    }
}

fn new_id() -> String {
    uuid::Uuid::now_v7().simple().to_string()
}

/// Ids name directories, so one from outside must not be a path.
fn check_id(id: &str) -> Result<()> {
    if id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(StoreError::InvalidId(id.to_owned()))
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

fn io_error(path: &Path) -> impl FnOnce(io::Error) -> StoreError {
    |source| StoreError::Io {
        path: path.to_owned(),
        source,
    }
}

fn create_dir_all(path: &Path) -> Result<()> {
    fs::create_dir_all(path).map_err(io_error(path))
}

fn rename(from: &Path, to: &Path) -> Result<()> {
    fs::rename(from, to).map_err(io_error(from))
}

fn remove_file(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Err(err) if err.kind() != io::ErrorKind::NotFound => Err(io_error(path)(err)),
        _ => Ok(()),
    }
}

fn remove_dir_all(path: &Path) -> Result<()> {
    let removed = match fs::remove_dir_all(path) {
        // Overlayfs leaves a directory nobody may enter in its work directory.
        Err(err) if err.kind() == io::ErrorKind::PermissionDenied => {
            open_up(path).and_then(|()| fs::remove_dir_all(path))
        }
        removed => removed,
    };
    match removed {
        Err(err) if err.kind() != io::ErrorKind::NotFound => Err(io_error(path)(err)),
        _ => Ok(()),
    }
}

/// Gives the owner access to every directory below `path`.
fn open_up(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() {
        return Ok(());
    }
    let mut permissions = metadata.permissions();
    permissions.set_mode(permissions.mode() | 0o700);
    fs::set_permissions(path, permissions)?;
    for entry in fs::read_dir(path)? {
        open_up(&entry?.path())?;
    }
    Ok(())
}

fn read_dir(path: &Path) -> Result<Vec<PathBuf>> {
    fs::read_dir(path)
        .map_err(io_error(path))?
        .map(|entry| entry.map(|entry| entry.path()).map_err(io_error(path)))
        .collect()
}

fn read_record<T: DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(io_error(path)(err)),
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|source| StoreError::Record {
            path: path.to_owned(),
            source,
        })
}

/// Through a rename, so a reader finds the old record or the new one, never half of one.
fn write_record<T: Serialize>(path: &Path, record: &T) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(record).map_err(|source| StoreError::Record {
        path: path.to_owned(),
        source,
    })?;
    let staged = path.with_extension("json.tmp");
    fs::write(&staged, bytes).map_err(io_error(&staged))?;
    rename(&staged, path)
}

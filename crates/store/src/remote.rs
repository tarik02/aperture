//! Where nodes keep snapshots, sessions or both together: an object store, such as an S3
//! bucket or a directory they all mount.
//!
//! ```text
//! <prefix>/snapshots/<id>.json
//! <prefix>/layers/<id>/{fs.tar.zst,layer.json}
//! <prefix>/sessions/<id>/{session.json,state.tar.zst,held.json}
//! ```
//!
//! A session's record is as it was last suspended, and its state is what its profile had
//! above its layers then, with its files. Which node runs a session is for whoever tells
//! the nodes what to do; nodes that are asked to say so here as well, with `held.json`,
//! and then refuse a session another node says it has.
//!
//! A layer is there once its record is, which is written after its files. A snapshot's
//! record is written after its layers, so whoever finds a snapshot finds all of it. A node
//! brings a snapshot's layers into its own store before it builds a session on them.

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};

use futures_util::TryStreamExt;
use object_store::{
    ObjectStore, ObjectStoreExt, PutMode, PutPayload, buffered::BufWriter, path::Path as Key,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use tokio::{io::AsyncWriteExt, process::Command};

use crate::{
    Arriving, LayerRecord, Result, SessionRecord, SnapshotRecord, Store, StoreError, check_id,
    new_id,
};

/// How long a layer no snapshot is built on stays: one may be on its way to a snapshot
/// whose record is not written yet.
const KEPT_UNUSED: Duration = Duration::from_secs(60 * 60);

/// What of a session's directory is its state: the rest is made anew wherever it runs.
const STATE: [&str; 3] = ["upper", "files", "state"];

/// Which node says it has a session.
#[derive(Serialize, Deserialize)]
struct Held {
    node: String,
}

/// The programs layers are packed and unpacked with.
#[derive(Debug, Clone)]
pub struct Tools {
    pub tar: PathBuf,
    pub zstd: PathBuf,
}

pub struct Remote {
    objects: Arc<dyn ObjectStore>,
    prefix: Key,
    tools: Tools,
}

impl Remote {
    /// Opens the store at `url`: `s3://bucket/prefix`, with the bucket's region, endpoint
    /// and credentials as the `AWS_*` environment variables say, or `file:///directory`.
    pub fn open(url: &str, tools: Tools) -> Result<Self> {
        let invalid = |reason: String| StoreError::Archive(format!("{url:?}: {reason}"));
        let parsed = url::Url::parse(url).map_err(|err| invalid(err.to_string()))?;
        let (objects, prefix) = object_store::parse_url_opts(&parsed, std::env::vars())
            .map_err(|err| invalid(err.to_string()))?;
        Ok(Self {
            objects: Arc::from(objects),
            prefix,
            tools,
        })
    }

    pub async fn snapshots(&self) -> Result<Vec<SnapshotRecord>> {
        let listed = self.list("snapshots").await?;
        let mut snapshots = Vec::new();
        for key in listed.into_iter().map(|(key, _)| key) {
            // One that was deleted since it was listed is no snapshot any more.
            if let Some(snapshot) = self.read::<SnapshotRecord>(&key).await? {
                snapshots.push(snapshot);
            }
        }
        snapshots.sort_by(|a, b| (a.created_at_ms, &a.id).cmp(&(b.created_at_ms, &b.id)));
        Ok(snapshots)
    }

    pub async fn snapshot(&self, id: &str) -> Result<SnapshotRecord> {
        check_id(id)?;
        self.read(&self.snapshot_key(id))
            .await?
            .ok_or_else(|| StoreError::SnapshotNotFound(id.to_owned()))
    }

    /// Puts a snapshot the node took, with the layers that are not there yet.
    pub async fn push(&self, store: &Store, snapshot: &SnapshotRecord) -> Result<()> {
        self.push_layers(store, snapshot.layer.as_deref()).await?;
        self.write(&self.snapshot_key(&snapshot.id), snapshot).await
    }

    /// Puts the layer and those below it that are not there yet.
    pub async fn push_layers(&self, store: &Store, top: Option<&str>) -> Result<()> {
        let chain = store.layer_chain(top)?;
        for (id, parent) in chain.into_iter().rev() {
            let there = self.read::<LayerRecord>(&self.layer_key(&id)).await?;
            if there.is_some() {
                continue;
            }
            let packed = store.staging().join(format!("{}.tar.zst", new_id()));
            let outcome = async {
                self.pack(&store.layer_files(&id), &["."], &packed).await?;
                self.upload(&packed, &self.files_key(&id)).await
            }
            .await;
            crate::remove_file(&packed)?;
            outcome?;
            self.write(&self.layer_key(&id), &LayerRecord { parent })
                .await?;
        }
        Ok(())
    }

    /// Brings a snapshot into the node's store: its record, and the layers that are not
    /// there yet.
    pub async fn pull(&self, store: &Store, snapshot: &SnapshotRecord) -> Result<()> {
        let _arriving = self.pull_layers(store, snapshot.layer.as_deref()).await?;
        store.import_snapshot(snapshot)
    }

    /// Brings the layer and those below it that are not in the node's store yet. They
    /// stay there for as long as what this returns is kept, also with nothing built on
    /// them.
    pub async fn pull_layers<'a>(
        &self,
        store: &'a Store,
        top: Option<&str>,
    ) -> Result<Arriving<'a>> {
        let mut missing = Vec::new();
        let mut layer = top.map(str::to_owned);
        while let Some(id) = layer.filter(|id| !store.has_layer(id)) {
            let record: LayerRecord = self.read(&self.layer_key(&id)).await?.ok_or_else(|| {
                StoreError::Archive(format!("layer {id} is not in the store nodes share"))
            })?;
            missing.push((id, record.parent.clone()));
            layer = record.parent;
        }
        // The layers below the missing ones are here, and stay while the rest comes.
        let below = missing.last().and_then(|(_, parent)| parent.as_deref());
        let kept = store.layer_chain(below)?.into_iter().map(|(id, _)| id);
        let arriving = store.arriving(
            missing
                .iter()
                .map(|(id, _)| id.clone())
                .chain(kept)
                .collect(),
        );
        for (id, parent) in missing.into_iter().rev() {
            let staged = store.staging().join(new_id());
            let packed = staged.with_extension("tar.zst");
            let outcome = async {
                self.download(&self.files_key(&id), &packed).await?;
                self.unpack(&packed, &staged).await?;
                store.import_layer(&id, parent.as_deref(), &staged)
            }
            .await;
            crate::remove_file(&packed)?;
            if outcome.is_err() {
                crate::remove_dir_all(&staged)?;
            }
            outcome?;
        }
        Ok(arriving)
    }

    /// The session as it was last put here.
    pub async fn session(&self, id: &str) -> Result<Option<SessionRecord>> {
        check_id(id)?;
        self.read(&self.session_key(id)).await
    }

    /// Every session that is here, with the node that says it has it where one does.
    pub async fn sessions(&self) -> Result<Vec<(SessionRecord, Option<String>)>> {
        let listed = self.list("sessions").await?;
        let mut sessions = Vec::new();
        for (key, _) in listed {
            if key.filename() != Some("session.json") {
                continue;
            }
            // One that was deleted since it was listed is no session any more.
            let Some(session) = self.read::<SessionRecord>(&key).await? else {
                continue;
            };
            let held = self.read::<Held>(&self.held_key(&session.id)).await?;
            sessions.push((session, held.map(|held| held.node)));
        }
        sessions.sort_by(|(a, _), (b, _)| (a.created_at_ms, &a.id).cmp(&(b.created_at_ms, &b.id)));
        Ok(sessions)
    }

    /// Puts the session's record, as it is in the node's store.
    pub async fn put_session(&self, session: &SessionRecord) -> Result<()> {
        self.write(&self.session_key(&session.id), session).await
    }

    /// Puts the state of a session whose browser is not running: what its profile has
    /// above its layers, its files, and what its runner keeps. Gives the revision that
    /// state is.
    pub async fn push_state(&self, store: &Store, id: &str) -> Result<String> {
        let revision = new_id();
        let packed = store.staging().join(format!("{revision}.tar.zst"));
        let outcome = async {
            self.pack(&store.session_dir(id), &STATE, &packed).await?;
            self.upload(&packed, &self.state_key(id)).await
        }
        .await;
        crate::remove_file(&packed)?;
        outcome?;
        Ok(revision)
    }

    /// Brings the state last put of the session into a directory in the node's store,
    /// for [`Store::adopt_session`].
    pub async fn pull_state(&self, store: &Store, id: &str) -> Result<PathBuf> {
        let staged = store.staging().join(new_id());
        let packed = staged.with_extension("tar.zst");
        let outcome = async {
            self.download(&self.state_key(id), &packed).await?;
            self.unpack(&packed, &staged).await
        }
        .await;
        crate::remove_file(&packed)?;
        if outcome.is_err() {
            crate::remove_dir_all(&staged)?;
        }
        outcome?;
        Ok(staged)
    }

    /// Says that `node` has the session, unless another node says it has it: then that
    /// node's name is given, and with `takeover` its word is taken for this node's.
    pub async fn hold(&self, id: &str, node: &str, takeover: bool) -> Result<Option<String>> {
        check_id(id)?;
        let key = self.held_key(id);
        let ours = serde_json::to_vec(&Held {
            node: node.to_owned(),
        })
        .expect("a name is serializable");
        loop {
            match self.read::<Held>(&key).await? {
                Some(held) if held.node == node => return Ok(None),
                Some(held) if !takeover => return Ok(Some(held.node)),
                Some(_) => {
                    self.objects
                        .put(&key, PutPayload::from(ours))
                        .await
                        .map_err(failed(format!("writing {key}")))?;
                    return Ok(None);
                }
                None => {}
            }
            let created = self
                .objects
                .put_opts(&key, PutPayload::from(ours.clone()), PutMode::Create.into())
                .await;
            match created {
                Ok(_) => return Ok(None),
                // Another node was first: it is read again to say which.
                Err(object_store::Error::AlreadyExists { .. }) => {}
                Err(err) => return Err(failed(format!("writing {key}"))(err)),
            }
        }
    }

    /// Takes back what `node` said of having the session.
    pub async fn release(&self, id: &str, node: &str) -> Result<()> {
        check_id(id)?;
        let key = self.held_key(id);
        match self.read::<Held>(&key).await? {
            Some(held) if held.node == node => match self.objects.delete(&key).await {
                Ok(()) | Err(object_store::Error::NotFound { .. }) => Ok(()),
                Err(err) => Err(failed(format!("removing {key}"))(err)),
            },
            _ => Ok(()),
        }
    }

    /// Removes what is here of the session. The record first: without it the rest is no
    /// session.
    pub async fn delete_session(&self, id: &str) -> Result<()> {
        check_id(id)?;
        for key in [self.session_key(id), self.state_key(id), self.held_key(id)] {
            match self.objects.delete(&key).await {
                Ok(()) | Err(object_store::Error::NotFound { .. }) => {}
                Err(err) => return Err(failed(format!("removing {key}"))(err)),
            }
        }
        Ok(())
    }

    /// The layers the sessions here are built on.
    async fn session_layers(&self) -> Result<Vec<Option<String>>> {
        let mut layers = Vec::new();
        for (key, _) in self.list("sessions").await? {
            if key.filename() != Some("session.json") {
                continue;
            }
            if let Some(session) = self.read::<SessionRecord>(&key).await? {
                layers.push(session.base_layer);
            }
        }
        Ok(layers)
    }

    /// Removes the snapshot. Its layers stay for as long as another snapshot is built on
    /// them.
    pub async fn delete(&self, id: &str) -> Result<()> {
        self.snapshot(id).await?;
        let key = self.snapshot_key(id);
        self.objects
            .delete(&key)
            .await
            .map_err(failed(format!("removing {key}")))
    }

    /// Removes the layers no snapshot here and no session in `sessions` is built on.
    pub async fn collect(&self, sessions: Option<&Self>) -> Result<()> {
        // Before what is built on them: a layer that comes while this looks is newer
        // than what is seen of it here.
        let objects = self.list("layers").await?;
        let mut tops: Vec<Option<String>> = self
            .snapshots()
            .await?
            .into_iter()
            .map(|snapshot| snapshot.layer)
            .collect();
        if let Some(sessions) = sessions {
            tops.extend(sessions.session_layers().await?);
        }
        let mut used = HashSet::new();
        for top in tops {
            let mut layer = top;
            while let Some(id) = layer.filter(|id| used.insert(id.clone())) {
                layer = self
                    .read::<LayerRecord>(&self.layer_key(&id))
                    .await?
                    .and_then(|record| record.parent);
            }
        }
        let layers = self.prefix.clone().join("layers");
        let mut unused: HashMap<String, (Vec<Key>, Duration)> = HashMap::new();
        for (key, age) in objects {
            let Some(id) = key.prefix_match(&layers).and_then(|mut parts| parts.next()) else {
                continue;
            };
            if used.contains(id.as_ref()) {
                continue;
            }
            let (keys, youngest) = unused
                .entry(id.as_ref().to_owned())
                .or_insert((Vec::new(), Duration::MAX));
            keys.push(key);
            *youngest = age.min(*youngest);
        }
        for (keys, youngest) in unused.into_values() {
            if youngest < KEPT_UNUSED {
                continue;
            }
            // The record first: without it the rest is no layer.
            let (records, files): (Vec<Key>, Vec<Key>) = keys
                .into_iter()
                .partition(|key| key.filename() == Some("layer.json"));
            for key in records.into_iter().chain(files) {
                self.objects
                    .delete(&key)
                    .await
                    .map_err(failed(format!("removing {key}")))?;
            }
        }
        Ok(())
    }

    fn snapshot_key(&self, id: &str) -> Key {
        self.prefix
            .clone()
            .join("snapshots")
            .join(format!("{id}.json"))
    }

    fn session_key(&self, id: &str) -> Key {
        let session = self.prefix.clone().join("sessions").join(id);
        session.join("session.json")
    }

    fn held_key(&self, id: &str) -> Key {
        let session = self.prefix.clone().join("sessions").join(id);
        session.join("held.json")
    }

    fn state_key(&self, id: &str) -> Key {
        let session = self.prefix.clone().join("sessions").join(id);
        session.join("state.tar.zst")
    }

    fn layer_key(&self, id: &str) -> Key {
        self.prefix
            .clone()
            .join("layers")
            .join(id)
            .join("layer.json")
    }

    fn files_key(&self, id: &str) -> Key {
        self.prefix
            .clone()
            .join("layers")
            .join(id)
            .join("fs.tar.zst")
    }

    /// What is below `directory`, each with how long ago it was written.
    async fn list(&self, directory: &str) -> Result<Vec<(Key, Duration)>> {
        let directory = self.prefix.clone().join(directory);
        let listed: Vec<_> = self
            .objects
            .list(Some(&directory))
            .try_collect()
            .await
            .map_err(failed(format!("listing {directory}")))?;
        let now = std::time::SystemTime::now();
        Ok(listed
            .into_iter()
            .map(|object| {
                let age = now
                    .duration_since(object.last_modified.into())
                    .unwrap_or_default();
                (object.location, age)
            })
            .collect())
    }

    async fn read<T: DeserializeOwned>(&self, key: &Key) -> Result<Option<T>> {
        let found = match self.objects.get(key).await {
            Ok(found) => found,
            Err(object_store::Error::NotFound { .. }) => return Ok(None),
            Err(err) => return Err(failed(format!("reading {key}"))(err)),
        };
        let bytes = found
            .bytes()
            .await
            .map_err(failed(format!("reading {key}")))?;
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|source| StoreError::Record {
                path: key.to_string().into(),
                source,
            })
    }

    async fn write<T: Serialize>(&self, key: &Key, record: &T) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(record).map_err(|source| StoreError::Record {
            path: key.to_string().into(),
            source,
        })?;
        self.objects
            .put(key, PutPayload::from(bytes))
            .await
            .map_err(failed(format!("writing {key}")))?;
        Ok(())
    }

    async fn upload(&self, from: &Path, key: &Key) -> Result<()> {
        let io = |err| crate::io_error(from)(err);
        let mut file = tokio::fs::File::open(from).await.map_err(io)?;
        let mut writer = BufWriter::new(self.objects.clone(), key.clone());
        let sent = async {
            tokio::io::copy(&mut file, &mut writer).await?;
            writer.shutdown().await
        };
        sent.await
            .map_err(|err| StoreError::Archive(format!("sending {key}: {err}")))
    }

    async fn download(&self, key: &Key, to: &Path) -> Result<()> {
        let io = |err| crate::io_error(to)(err);
        let found = self
            .objects
            .get(key)
            .await
            .map_err(failed(format!("reading {key}")))?;
        let mut chunks = found.into_stream();
        let mut file = tokio::fs::File::create(to).await.map_err(io)?;
        while let Some(chunk) = chunks
            .try_next()
            .await
            .map_err(failed(format!("reading {key}")))?
        {
            file.write_all(&chunk).await.map_err(io)?;
        }
        file.flush().await.map_err(io)
    }

    /// Packs a layer's files with what overlayfs keeps of them: the attributes that say a
    /// directory hides what is below it, and the devices that say a file is gone.
    async fn pack(&self, directory: &Path, members: &[&str], to: &Path) -> Result<()> {
        let mut tar = self.tar();
        tar.arg("--create")
            .arg("--file")
            .arg(to)
            .arg("--directory")
            .arg(directory)
            .args(members);
        run(tar, "packing").await
    }

    async fn unpack(&self, from: &Path, to: &Path) -> Result<()> {
        crate::create_dir_all(to)?;
        let mut tar = self.tar();
        tar.arg("--extract")
            .arg("--file")
            .arg(from)
            .arg("--directory")
            .arg(to)
            .args(["--preserve-permissions", "--no-same-owner"]);
        run(tar, "unpacking").await
    }

    fn tar(&self) -> Command {
        let mut tar = Command::new(&self.tools.tar);
        tar.arg("--use-compress-program")
            .arg(&self.tools.zstd)
            .args(["--xattrs", "--xattrs-include=user.*"]);
        tar
    }
}

async fn run(mut command: Command, doing: &str) -> Result<()> {
    let output = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .output()
        .await
        .map_err(|err| StoreError::Archive(format!("{doing}: {err}")))?;
    if output.status.success() {
        return Ok(());
    }
    let said = String::from_utf8_lossy(&output.stderr);
    Err(StoreError::Archive(format!(
        "{doing}: {}: {}",
        output.status,
        said.trim()
    )))
}

fn failed(what: String) -> impl FnOnce(object_store::Error) -> StoreError {
    |source| StoreError::Remote { what, source }
}

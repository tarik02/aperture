//! What is told of a recording, kept next to its files for the session's next run.

use std::path::{Path, PathBuf};

use tracing::warn;

use super::{DIRECTORY, EditState, Recording, State};

/// Where what is told of a recording is kept, next to its files.
fn kept_path(files: &Path, id: &str) -> PathBuf {
    files.join(DIRECTORY).join(format!("{id}.recording.json"))
}

/// Keeps what is told of a recording, whole or not at all.
pub(super) fn keep(files: &Path, recording: &Recording) {
    let path = kept_path(files, &recording.id);
    let partial = path.with_extension("part");
    let written = serde_json::to_vec_pretty(recording)
        .map_err(std::io::Error::other)
        .and_then(|told| std::fs::write(&partial, told))
        .and_then(|()| std::fs::rename(&partial, &path));
    if let Err(err) = written {
        warn!(recording = %recording.id, "a recording was not kept for the next run: {err}");
    }
}

/// The recordings the session's earlier runs kept. One that was still being made or
/// edited when its run ended is told as failed: nothing goes on with it.
///
/// What cannot be read is said and left out: the recordings that can be are still told.
pub(super) fn restore(files: &Path) -> Vec<Recording> {
    let entries = match std::fs::read_dir(files.join(DIRECTORY)) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(err) => {
            warn!(%err, "the recordings of earlier runs are not read");
            return Vec::new();
        }
    };
    let mut earlier = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(err) => {
                warn!(%err, "a file among the recordings is not read");
                continue;
            }
        };
        let name = entry.file_name();
        if !name.to_string_lossy().ends_with(".recording.json") {
            continue;
        }
        let read = std::fs::read(entry.path())
            .map_err(anyhow::Error::from)
            .and_then(|kept| Ok(serde_json::from_slice::<Recording>(&kept)?));
        let mut recording = match read {
            Ok(recording) => recording,
            Err(err) => {
                warn!(file = ?name, "a kept recording is not read: {err:#}");
                continue;
            }
        };
        let mut changed = false;
        if recording.state == State::Recording {
            recording.state = State::Failed;
            recording.failure = Some("the session ended while it was recorded".into());
            // It may have left no file.
            recording.bytes = std::fs::metadata(files.join(&recording.file))
                .ok()
                .map(|metadata| metadata.len());
            changed = true;
        }
        if let Some(edit) = &mut recording.edit
            && edit.state == EditState::Editing
        {
            edit.state = EditState::Failed;
            edit.failure = Some("the session ended before the edit was made".into());
            changed = true;
        }
        if changed {
            keep(files, &recording);
        }
        earlier.push(recording);
    }
    earlier
}

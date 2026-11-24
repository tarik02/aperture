//! The tool that tells an agent the session's files: what was recorded, shot, downloaded
//! and put there for a page to take.

use std::{
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use anyhow::{Context, bail};
use async_trait::async_trait;
use browse_core::{Tool, ToolContext, ToolOutput, ToolSpec};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use rustix::fs::FileType;

use crate::{
    beneath::Beneath,
    files::{self, UPLOADS},
};

/// The directories of the session's files, as a file's `path` begins.
const DIRECTORIES: [&str; 4] = ["recordings", "screenshots", "downloads", UPLOADS];
/// How many files one listing tells; the newest first.
const LISTED: usize = 200;

/// The session's files.
pub(super) struct FilesTool(pub PathBuf);

#[derive(Serialize)]
struct Listed {
    /// Below the session's files, as a link to the file is asked for.
    path: String,
    size: u64,
    /// When it was last written, in milliseconds since the epoch.
    modified_ms: u64,
    /// Where the file is for the session's own tools, as `upload` takes it.
    absolute: PathBuf,
}

#[async_trait]
impl Tool for FilesTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "files".into(),
            description: "The session's files: `recordings` (each recording's raw `.mkv`, its \
                edited video once that is made, and its journal), `screenshots`, `downloads` \
                (what the browser downloaded) and `uploads` (what was put there for a page to \
                take). `list` (the default) gives each file's `path`, `size` in bytes, \
                `modified_ms` and `absolute` path, the newest first, of one `directory` or of \
                all four; `absolute` is what `upload` takes to give a file to a page. `delete` \
                removes the upload at `path`. The files' bytes are not read here: where the \
                session is reached through a control plane, its `sessions.file_link` makes an \
                address a file is fetched from or put to; where it serves itself, a file is \
                at `/files/<path>` and an upload is put at `/uploads/<name>`."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["list", "delete"] },
                    "directory": {
                        "type": "string",
                        "enum": DIRECTORIES,
                        "description": "list: only the files of this directory.",
                    },
                    "path": {
                        "type": "string",
                        "description": "delete: the upload, as `uploads/<name>`.",
                    },
                },
            }),
        }
    }

    async fn call(&self, _ctx: ToolContext, args: Value) -> anyhow::Result<ToolOutput> {
        #[derive(Deserialize)]
        struct Asked {
            action: Option<String>,
            directory: Option<String>,
            path: Option<String>,
        }
        let asked: Asked = serde_json::from_value(args).context("invalid arguments")?;
        match asked.action.as_deref().unwrap_or("list") {
            "list" => {
                let directories: Vec<&str> = match asked.directory.as_deref() {
                    Some(named) => vec![
                        *DIRECTORIES
                            .iter()
                            .find(|directory| **directory == named)
                            .with_context(|| format!("no directory {named}"))?,
                    ],
                    None => DIRECTORIES.to_vec(),
                };
                let root = self.0.clone();
                let mut listed = tokio::task::spawn_blocking(move || {
                    let files = Beneath::open(&root)?;
                    let mut listed = Vec::new();
                    for directory in directories {
                        list(&root, &files, Path::new(directory), &mut listed)?;
                    }
                    std::io::Result::Ok(listed)
                })
                .await??;
                listed.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms).then(a.path.cmp(&b.path)));
                let more = listed.len().saturating_sub(LISTED);
                listed.truncate(LISTED);
                Ok(ToolOutput::text(
                    json!({ "files": listed, "more": more }).to_string(),
                ))
            }
            "delete" => {
                let path = asked.path.context("pass the upload's `path`")?;
                let name = path
                    .strip_prefix(UPLOADS)
                    .and_then(|name| name.strip_prefix('/'))
                    .context("only an upload is deleted: `uploads/<name>`")?;
                files::named(&self.0.join(UPLOADS), name).context("that is no upload's name")?;
                let removed = Beneath::open(&self.0)
                    .and_then(|files| files.directory(Path::new(UPLOADS)))
                    .and_then(|uploads| uploads.remove(name));
                match removed {
                    Ok(()) => Ok(ToolOutput::text(json!({ "deleted": path }).to_string())),
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                        bail!("no upload {name}; `files` lists the uploads there are")
                    }
                    Err(err) => Err(err.into()),
                }
            }
            other => bail!("unknown action {other}; use list or delete"),
        }
    }
}

/// The files below `directory` of the session's files, those in its own directories too.
/// What a name hides, as a file that is still being written, is left out. A link is
/// followed nowhere: what is listed is what is in the session's files.
fn list(
    root: &Path,
    files: &Beneath,
    directory: &Path,
    listed: &mut Vec<Listed>,
) -> std::io::Result<()> {
    let entries = match files.directory(directory).and_then(|held| held.entries()) {
        Ok(entries) => entries,
        // Not there, or not a directory of the session's files: a link put in its place.
        Err(_) => return Ok(()),
    };
    for entry in entries {
        if entry.name.starts_with('.') {
            continue;
        }
        let below = directory.join(&entry.name);
        match entry.kind {
            FileType::Directory => list(root, files, &below, listed)?,
            FileType::RegularFile => listed.push(Listed {
                path: below.to_string_lossy().into_owned(),
                size: entry.size,
                modified_ms: entry
                    .modified
                    .duration_since(UNIX_EPOCH)
                    .map_or(0, |since| since.as_millis() as u64),
                absolute: root.join(&below),
            }),
            _ => {}
        }
    }
    Ok(())
}

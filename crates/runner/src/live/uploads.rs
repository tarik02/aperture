//! The files clients put into the session's uploads for its browser to take: whole, in one
//! request, or a piece at a time as tus 1.0 has it, with its creation and termination
//! extensions, which goes on where it left off when a connection drops or the page that
//! sends the file is loaded again.
//!
//! - `PUT /uploads/<name>` takes the request's body as the file;
//! - `OPTIONS /uploads` tells what of tus is spoken, and the largest file that is taken;
//! - `POST /uploads` makes an upload of `Upload-Length` bytes, of the file named by the
//!   `filename` of its `Upload-Metadata`, and says where it is: `uploads/resumable/<id>`,
//!   relative to where it was asked for;
//! - `HEAD` there tells how much of it came, `PATCH` puts the bytes that come next at
//!   `Upload-Offset`, and `DELETE` gives it up.
//!
//! Until a file is whole it is under a name no listing shows. Then it takes the place of
//! the upload of its name, where there was one. What is left of uploads nobody went on
//! with for a day is removed.

use std::{
    collections::{HashMap, HashSet},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};

use axum::{
    Json, Router,
    body::Body,
    extract::{Path as RoutePath, State},
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, head, put},
};
use base64::Engine;
use futures_util::StreamExt;
use rustix::fs::FileType;
use serde::{Deserialize, Serialize};
use tokio::{io::AsyncWriteExt, sync::watch};
use tracing::{info, warn};

use super::http::{Live, Refusal};
use crate::{
    beneath::Beneath,
    files::{self, UPLOADS},
};

/// The version of tus that is spoken.
const TUS: &str = "1.0.0";

const TUS_RESUMABLE: HeaderName = HeaderName::from_static("tus-resumable");
const TUS_VERSION: HeaderName = HeaderName::from_static("tus-version");
const TUS_EXTENSION: HeaderName = HeaderName::from_static("tus-extension");
const TUS_MAX_SIZE: HeaderName = HeaderName::from_static("tus-max-size");
const UPLOAD_LENGTH: HeaderName = HeaderName::from_static("upload-length");
const UPLOAD_OFFSET: HeaderName = HeaderName::from_static("upload-offset");
const UPLOAD_METADATA: HeaderName = HeaderName::from_static("upload-metadata");

/// What a file leaves free of the disk the session's files are on, at least: the browser
/// and the other sessions of the node write there too.
const MARGIN: u64 = 256 * 1024 * 1024;

/// How long what is left of an upload nobody goes on with is kept.
const STALE_AFTER: Duration = Duration::from_secs(24 * 60 * 60);
const SWEPT_EVERY: Duration = Duration::from_secs(60 * 60);

/// The largest file the session takes, and the resumable uploads a request writes to.
pub struct Uploads {
    most: watch::Sender<Option<u64>>,
    /// A request writes to an upload alone: what another one sent at the same offset would
    /// go in after it.
    writing: Mutex<HashSet<String>>,
}

impl Uploads {
    /// With files as large as `most` taken; any size without.
    pub fn new(most: Option<u64>) -> Self {
        Self {
            most: watch::channel(most).0,
            writing: Mutex::default(),
        }
    }

    pub fn most(&self) -> Option<u64> {
        *self.most.borrow()
    }

    pub fn set_most(&self, most: Option<u64>) {
        self.most.send_replace(most);
    }

    /// The largest file, as it is from now on.
    pub fn watch_most(&self) -> watch::Receiver<Option<u64>> {
        self.most.subscribe()
    }

    fn hold(self: &Arc<Self>, id: &str) -> Result<Held, Refusal> {
        let taken = self
            .writing
            .lock()
            .expect("not poisoned")
            .insert(id.to_owned());
        match taken {
            true => Ok(Held {
                uploads: self.clone(),
                id: id.to_owned(),
            }),
            false => Err(Refusal(
                StatusCode::LOCKED,
                "another request writes to the upload".into(),
            )),
        }
    }
}

/// An upload a request writes to, until it is dropped.
struct Held {
    uploads: Arc<Uploads>,
    id: String,
}

impl Drop for Held {
    fn drop(&mut self) {
        self.uploads
            .writing
            .lock()
            .expect("not poisoned")
            .remove(&self.id);
    }
}

/// The routes of the session's uploads.
pub(super) fn routes() -> Router<Live> {
    Router::new()
        .route("/uploads", get(list).post(create).options(options))
        .route("/uploads/{name}", put(put_whole).delete(remove))
        .route(
            "/uploads/resumable/{id}",
            head(offset).get(receipt).patch(append).delete(terminate),
        )
        .layer(axum::middleware::map_response(spoken))
}

/// Every answer says which tus it is in.
async fn spoken(mut response: Response) -> Response {
    let headers = response.headers_mut();
    headers.insert(TUS_RESUMABLE, HeaderValue::from_static(TUS));
    headers.insert(TUS_VERSION, HeaderValue::from_static(TUS));
    response
}

/// Removes what is left of uploads nobody went on with for a while, now and then, for as
/// long as the session runs.
pub(super) async fn sweep(files: PathBuf) {
    loop {
        let swept = {
            let files = files.clone();
            tokio::task::spawn_blocking(move || remove_stale(&files)).await
        };
        match swept {
            Ok(Ok(0)) => {}
            Ok(Ok(removed)) => info!(removed, "what was left of uploads was removed"),
            Ok(Err(err)) if err.kind() == std::io::ErrorKind::NotFound => {}
            Ok(Err(err)) => warn!(%err, "what is left of uploads was not looked at"),
            Err(err) => warn!(%err, "what is left of uploads was not looked at"),
        }
        tokio::time::sleep(SWEPT_EVERY).await;
    }
}

/// What was left of uploads and is stale now, removed: of one that was taken whole, its
/// partial file; of a resumable one, its partial file and what tells of it together, as
/// long as either is still written to.
fn remove_stale(files: &Path) -> std::io::Result<usize> {
    let uploads = Beneath::open(files)?.directory(Path::new(UPLOADS))?;
    let mut left: HashMap<String, (SystemTime, Vec<String>)> = HashMap::new();
    for entry in uploads.entries()? {
        if entry.kind != FileType::RegularFile || !entry.name.starts_with('.') {
            continue;
        }
        let of = match entry
            .name
            .strip_suffix(".json")
            .or_else(|| entry.name.strip_suffix(".json.new"))
        {
            Some(data) if data.ends_with(".upload") => data.to_owned(),
            _ if entry.name.ends_with(".upload") || entry.name.ends_with(".part") => {
                entry.name.clone()
            }
            _ => continue,
        };
        let (latest, names) = left
            .entry(of)
            .or_insert((SystemTime::UNIX_EPOCH, Vec::new()));
        *latest = (*latest).max(entry.modified);
        names.push(entry.name);
    }
    let now = SystemTime::now();
    let mut removed = 0;
    for (latest, names) in left.into_values() {
        if now.duration_since(latest).unwrap_or_default() < STALE_AFTER {
            continue;
        }
        for name in names {
            match uploads.remove(&name) {
                Ok(()) => removed += 1,
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                Err(err) => return Err(err),
            }
        }
    }
    Ok(removed)
}

/// A file put into the session for the browser to take.
#[derive(Serialize)]
struct Uploaded {
    name: String,
    size: u64,
    /// Where the file is, for the browser as for the session's tools.
    path: PathBuf,
}

async fn list(State(live): State<Live>) -> Result<Json<Vec<Uploaded>>, Refusal> {
    let directory = live.files.join(UPLOADS);
    let entries = Beneath::open(&live.files)
        .and_then(|files| files.directory(Path::new(UPLOADS)))
        .and_then(|uploads| uploads.entries());
    let entries = match entries {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Json(Vec::new())),
        Err(err) => return Err(err.into()),
    };
    let mut uploads: Vec<Uploaded> = entries
        .into_iter()
        .filter(|entry| entry.kind == FileType::RegularFile)
        .filter_map(|entry| {
            Some(Uploaded {
                path: files::named(&directory, &entry.name)?,
                name: entry.name,
                size: entry.size,
            })
        })
        .collect();
    uploads.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(Json(uploads))
}

/// A size as it is read: `1 GiB`, `1.5 GiB`, `300 MiB`.
fn said(bytes: u64) -> String {
    const UNITS: [(&str, u64); 3] = [("GiB", 1 << 30), ("MiB", 1 << 20), ("KiB", 1 << 10)];
    for (unit, size) in UNITS {
        if bytes >= size {
            return match bytes % size {
                0 => format!("{} {unit}", bytes / size),
                _ => format!("{:.1} {unit}", bytes as f64 / size as f64),
            };
        }
    }
    format!("{bytes} bytes")
}

fn too_large(most: u64) -> Refusal {
    Refusal(
        StatusCode::PAYLOAD_TOO_LARGE,
        format!("the file is over the {} upload limit", said(most)),
    )
}

/// Refuses `length` more bytes: past the largest file, or more than the disk has to spare.
fn room(uploads: &Beneath, most: Option<u64>, file: u64, length: u64) -> Result<(), Refusal> {
    if let Some(most) = most.filter(|&most| file > most) {
        return Err(too_large(most));
    }
    let free = uploads.free()?;
    if free < length.saturating_add(MARGIN) {
        return Err(Refusal(
            StatusCode::INSUFFICIENT_STORAGE,
            format!(
                "the session's disk has {} free, too little for {} more",
                said(free),
                said(length)
            ),
        ));
    }
    Ok(())
}

/// A header that is a number of bytes; none where it is not there.
fn bytes(headers: &HeaderMap, name: &HeaderName) -> Result<Option<u64>, Refusal> {
    let Some(value) = headers.get(name) else {
        return Ok(None);
    };
    let number = value
        .to_str()
        .ok()
        .and_then(|value| value.trim().parse().ok());
    number
        .map(Some)
        .ok_or_else(|| Refusal::bad_request(format_args!("{name} is no number of bytes")))
}

/// Takes the request's body as the file `name` of the session's uploads, in place of one
/// there was.
async fn put_whole(
    State(live): State<Live>,
    RoutePath(name): RoutePath<String>,
    headers: HeaderMap,
    body: Body,
) -> Result<Json<Uploaded>, Refusal> {
    let path = files::named(&live.files.join(UPLOADS), &name)
        .ok_or_else(|| Refusal::bad_request("not a file name"))?;
    let uploads = Beneath::open(&live.files)?.directory_made(UPLOADS)?;
    let most = live.uploads.most();
    // Before a byte of it is read: one past the most is refused while it is on its way.
    let declared = bytes(&headers, &header::CONTENT_LENGTH)?.unwrap_or_default();
    room(&uploads, most, declared, declared)?;
    // Under a name no listing shows until the file is whole.
    let partial = format!(".{name}.part");
    let written = async {
        let mut file = tokio::fs::File::from_std(uploads.create(&partial)?);
        let mut chunks = body.into_data_stream();
        let mut size = 0;
        while let Some(chunk) = chunks.next().await {
            let chunk = chunk.map_err(std::io::Error::other)?;
            size += chunk.len() as u64;
            if most.is_some_and(|most| size > most) {
                return Ok(None);
            }
            file.write_all(&chunk).await?;
        }
        file.flush().await?;
        uploads.rename(&partial, &name)?;
        std::io::Result::Ok(Some(size))
    };
    let size = match written.await {
        Ok(Some(size)) => return Ok(Json(Uploaded { name, size, path })),
        Ok(None) => Err(too_large(most.unwrap_or_default())),
        Err(err) => Err(err.into()),
    };
    match uploads.remove(&partial) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => warn!(file = %partial, %err, "what came of an upload is left behind"),
    }
    size
}

async fn remove(
    State(live): State<Live>,
    RoutePath(name): RoutePath<String>,
) -> Result<StatusCode, Refusal> {
    files::named(&live.files.join(UPLOADS), &name)
        .ok_or_else(|| Refusal::bad_request("not a file name"))?;
    let removed = Beneath::open(&live.files)
        .and_then(|files| files.directory(Path::new(UPLOADS)))
        .and_then(|uploads| uploads.remove(&name));
    match removed {
        Ok(()) => Ok(StatusCode::NO_CONTENT),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            Err(Refusal::not_found("no such upload"))
        }
        Err(err) => Err(err.into()),
    }
}

/// What tells of a resumable upload, beside the bytes that came of it.
#[derive(Serialize, Deserialize)]
struct Resumable {
    /// The file it is to be.
    name: String,
    length: u64,
    /// Whether the file was made of it. What tells of it is kept a while after, for a
    /// client whose answer to the last piece was lost to learn it is whole, rather than
    /// send all of it again.
    #[serde(default)]
    done: bool,
}

/// Where the bytes of an upload go until it is whole.
fn partial(id: &str) -> String {
    format!(".{id}.upload")
}

/// Where what tells of it is kept.
fn told(id: &str) -> String {
    format!(".{id}.upload.json")
}

/// Refuses a request of another tus, or of none.
fn tus(headers: &HeaderMap) -> Result<(), Refusal> {
    match headers.get(TUS_RESUMABLE).is_some_and(|said| said == TUS) {
        true => Ok(()),
        false => Err(Refusal(
            StatusCode::PRECONDITION_FAILED,
            format!("uploads are resumed as tus {TUS} has it, said in Tus-Resumable"),
        )),
    }
}

/// The value of `key` in the upload's metadata, which is pairs of a key and its value in
/// base64, apart by commas.
fn metadata(headers: &HeaderMap, key: &str) -> Result<Option<String>, Refusal> {
    let Some(said) = headers.get(UPLOAD_METADATA) else {
        return Ok(None);
    };
    let unread = || Refusal::bad_request("Upload-Metadata is not read");
    for pair in said.to_str().map_err(|_| unread())?.split(',') {
        let (named, value) = pair.trim().split_once(' ').unwrap_or((pair.trim(), ""));
        if named != key {
            continue;
        }
        let value = base64::engine::general_purpose::STANDARD
            .decode(value.trim())
            .map_err(|_| unread())?;
        return String::from_utf8(value).map(Some).map_err(|_| unread());
    }
    Ok(None)
}

async fn options(State(live): State<Live>) -> Response {
    let mut response = StatusCode::NO_CONTENT.into_response();
    let headers = response.headers_mut();
    headers.insert(
        TUS_EXTENSION,
        HeaderValue::from_static("creation,termination"),
    );
    if let Some(most) = live.uploads.most() {
        headers.insert(TUS_MAX_SIZE, HeaderValue::from(most));
    }
    response
}

/// Makes a resumable upload, which is whole at once where it is of nothing.
async fn create(State(live): State<Live>, headers: HeaderMap) -> Result<Response, Refusal> {
    tus(&headers)?;
    let length = bytes(&headers, &UPLOAD_LENGTH)?.ok_or_else(|| {
        Refusal::bad_request("an upload says its Upload-Length: one said later is not taken")
    })?;
    let name = metadata(&headers, "filename")?.ok_or_else(|| {
        Refusal::bad_request("an upload names its file, as the filename of its Upload-Metadata")
    })?;
    let path = files::named(&live.files.join(UPLOADS), &name)
        .ok_or_else(|| Refusal::bad_request("not a file name"))?;
    let uploads = Beneath::open(&live.files)?.directory_made(UPLOADS)?;
    room(&uploads, live.uploads.most(), length, length)?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let telling = Resumable {
        name: name.clone(),
        length,
        done: false,
    };
    let telling = serde_json::to_vec(&telling).expect("an upload is serializable");
    uploads.create(&told(&id))?.write_all(&telling)?;
    uploads.create(&partial(&id))?;
    let location = format!("{UPLOADS}/resumable/{id}");
    let mut response = match length {
        0 => (
            StatusCode::CREATED,
            Json(whole(&uploads, &id, name, path, 0)?),
        )
            .into_response(),
        _ => StatusCode::CREATED.into_response(),
    };
    let headers = response.headers_mut();
    headers.insert(
        header::LOCATION,
        HeaderValue::from_str(&location).map_err(Refusal::failed)?,
    );
    headers.insert(UPLOAD_OFFSET, HeaderValue::from(0u64));
    Ok(response)
}

/// The upload of that id; none where it is no upload's.
fn resumed(live: &Live, id: &str) -> Result<(Beneath, Resumable, PathBuf), Refusal> {
    let unknown = || Refusal::not_found("no such upload");
    if id.len() != 32 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(unknown());
    }
    let uploads = Beneath::open(&live.files)?
        .directory(Path::new(UPLOADS))
        .map_err(|_| unknown())?;
    let telling = uploads.file(Path::new(&told(id))).map_err(|_| unknown())?;
    let telling: Resumable = serde_json::from_reader(telling).map_err(|_| unknown())?;
    let path = files::named(&live.files.join(UPLOADS), &telling.name).ok_or_else(unknown)?;
    Ok((uploads, telling, path))
}

/// The upload's bytes, made the file it is of, in place of the one of its name.
fn whole(
    uploads: &Beneath,
    id: &str,
    name: String,
    path: PathBuf,
    size: u64,
) -> std::io::Result<Uploaded> {
    uploads.rename(&partial(id), &name)?;
    let done = Resumable {
        name: name.clone(),
        length: size,
        done: true,
    };
    let fresh = format!("{}.new", told(id));
    let kept = match uploads.remove(&fresh) {
        Err(err) if err.kind() != std::io::ErrorKind::NotFound => Err(err),
        _ => uploads.create(&fresh).and_then(|mut file| {
            file.write_all(&serde_json::to_vec(&done).expect("an upload is serializable"))
        }),
    }
    .and_then(|()| uploads.rename(&fresh, &told(id)));
    if let Err(err) = kept {
        warn!(upload = %id, %err, "an upload's file was made, and what tells of it was not kept");
    }
    Ok(Uploaded { name, size, path })
}

/// How much of the upload came.
async fn offset(
    State(live): State<Live>,
    RoutePath(id): RoutePath<String>,
    headers: HeaderMap,
) -> Result<Response, Refusal> {
    tus(&headers)?;
    let (uploads, telling, path) = resumed(&live, &id)?;
    if telling.done {
        return Ok(offset_said(telling.length, telling.length));
    }
    let came = uploads
        .file(Path::new(&partial(&id)))
        .and_then(|file| file.metadata())
        .map_err(|_| Refusal::not_found("no such upload"))?
        .len();
    // All of it came, and the request it came with ended before the file was made of it:
    // the client takes it for whole now.
    if came == telling.length
        && let Ok(_held) = live.uploads.hold(&id)
    {
        match whole(&uploads, &id, telling.name, path, came) {
            // Made the file of it since this looked.
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            made => {
                made?;
            }
        }
    }
    Ok(offset_said(came, telling.length))
}

fn offset_said(came: u64, length: u64) -> Response {
    let mut response = StatusCode::OK.into_response();
    let headers = response.headers_mut();
    headers.insert(UPLOAD_OFFSET, HeaderValue::from(came));
    headers.insert(UPLOAD_LENGTH, HeaderValue::from(length));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// The file an upload was made, for whoever sends it: they may not be let list the others.
async fn receipt(
    State(live): State<Live>,
    RoutePath(id): RoutePath<String>,
) -> Result<Json<Uploaded>, Refusal> {
    let (_, telling, path) = resumed(&live, &id)?;
    if !telling.done {
        return Err(Refusal(
            StatusCode::CONFLICT,
            "the upload is not whole yet".into(),
        ));
    }
    Ok(Json(Uploaded {
        name: telling.name,
        size: telling.length,
        path,
    }))
}

/// Puts the request's body into the upload at its offset, which is where what came of it
/// ends. What comes of a body that ends early is kept, for the next request to go on
/// from. The request that makes the file whole is answered with it.
async fn append(
    State(live): State<Live>,
    RoutePath(id): RoutePath<String>,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, Refusal> {
    tus(&headers)?;
    let kind = headers.get(header::CONTENT_TYPE);
    if kind.is_none_or(|kind| kind != "application/offset+octet-stream") {
        return Err(Refusal(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "what goes into an upload is application/offset+octet-stream".into(),
        ));
    }
    let at = bytes(&headers, &UPLOAD_OFFSET)?
        .ok_or_else(|| Refusal::bad_request("what goes into an upload says its Upload-Offset"))?;
    let (uploads, telling, path) = resumed(&live, &id)?;
    if telling.done {
        return Err(Refusal(
            StatusCode::CONFLICT,
            format!("all {} bytes of the upload came", telling.length),
        ));
    }
    let _held = live.uploads.hold(&id)?;
    let (file, came) = uploads
        .extend(&partial(&id))
        .map_err(|_| Refusal::not_found("no such upload"))?;
    if came != at {
        return Err(Refusal(
            StatusCode::CONFLICT,
            format!("{came} bytes of the upload came, and not {at}"),
        ));
    }
    let left = telling.length.saturating_sub(came);
    let coming = bytes(&headers, &header::CONTENT_LENGTH)?;
    if coming.is_some_and(|coming| coming > left) {
        return Err(Refusal(
            StatusCode::PAYLOAD_TOO_LARGE,
            format!("{left} bytes of the upload are left, and more came"),
        ));
    }
    room(&uploads, None, 0, coming.unwrap_or(left))?;

    let mut file = tokio::fs::File::from_std(file);
    let mut chunks = body.into_data_stream();
    let mut written = came;
    let mut ended = None;
    let mut past = false;
    while let Some(chunk) = chunks.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(err) => {
                ended = Some(err);
                break;
            }
        };
        let room = (telling.length - written) as usize;
        let taken = &chunk[..chunk.len().min(room)];
        file.write_all(taken).await?;
        written += taken.len() as u64;
        if taken.len() < chunk.len() {
            past = true;
            break;
        }
    }
    file.flush().await?;
    drop(file);
    if let Some(err) = ended {
        return Err(Refusal::bad_request(format_args!(
            "the request ended before its body did: {err}"
        )));
    }
    if past {
        return Err(Refusal(
            StatusCode::PAYLOAD_TOO_LARGE,
            format!("{left} bytes of the upload were left, and more came"),
        ));
    }
    let mut response = match written == telling.length {
        true => Json(whole(&uploads, &id, telling.name, path, written)?).into_response(),
        false => StatusCode::NO_CONTENT.into_response(),
    };
    response
        .headers_mut()
        .insert(UPLOAD_OFFSET, HeaderValue::from(written));
    Ok(response)
}

/// Gives the upload up, and what came of it.
async fn terminate(
    State(live): State<Live>,
    RoutePath(id): RoutePath<String>,
    headers: HeaderMap,
) -> Result<StatusCode, Refusal> {
    tus(&headers)?;
    let (uploads, _, _) = resumed(&live, &id)?;
    let _held = live.uploads.hold(&id)?;
    for name in [partial(&id), told(&id), format!("{}.new", told(&id))] {
        match uploads.remove(&name) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(err.into()),
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

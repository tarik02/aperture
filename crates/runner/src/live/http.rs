//! The session's live endpoints, on a socket in its runtime directory. Whoever reaches the
//! socket is trusted: the executor checks callers before it forwards them here.

use std::{
    io::Cursor,
    path::{Path, PathBuf},
    sync::Arc,
};

use aperture_compositor::{Frame, Handle, Viewport};
use aperture_runner::{Features, PortRange, proxy};
use axum::{
    Json, Router,
    body::Body,
    extract::{Path as RoutePath, Query, State, WebSocketUpgrade},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use futures_util::StreamExt;
use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use tokio::{io::AsyncWriteExt, sync::watch};
use tower_http::services::ServeDir;

use super::{
    client,
    edit::plan::Options,
    mcp,
    record::{self, EditState, Recording, Recordings},
    shots::{self, Screenshot},
    sound::Sound,
    stream::Streams,
};
use crate::{
    automation::Automation,
    egress::Egress,
    files::{self, Download, Progress, UPLOADS},
    pages::Pages,
    presence::{Identity, Presence},
    targets::Target,
};

/// What the live endpoints serve.
#[derive(Clone)]
pub struct Live {
    pub compositor: Handle,
    pub streams: Arc<Streams>,
    pub targets: watch::Receiver<Vec<Target>>,
    pub recordings: Recordings,
    pub egress: Arc<Egress>,
    pub rtc_ports: Option<PortRange>,
    pub downloads: watch::Receiver<Vec<Download>>,
    pub pages: Pages,
    /// The session's sound.
    pub sound: Arc<Sound>,
    pub presence: Arc<Presence>,
    /// The session's files.
    pub files: PathBuf,
    pub features: Features,
}

/// The largest file that is taken for the browser, in bytes.
const UPLOAD_MOST: u64 = 1024 * 1024 * 1024;

/// Serves until the listener fails.
pub async fn serve(socket: &Path, live: Live, automation: Arc<Automation>) -> std::io::Result<()> {
    let _ = std::fs::remove_file(socket);
    let listener = tokio::net::UnixListener::bind(socket)?;
    let mut app = Router::new()
        .route("/ws", get(session_socket))
        .route("/targets", get(targets_list))
        .route("/targets/{id}/screenshot.png", get(screenshot))
        .route("/targets/{id}/viewport", put(viewport_set))
        .route("/proxy", put(proxy_update))
        .route("/recordings", get(recordings_list).post(recording_start))
        .route("/recordings/{id}", get(recording_get))
        .route("/recordings/{id}/stop", post(recording_stop))
        .route("/downloads", get(downloads_list))
        .route("/busy", get(busy))
        .nest_service("/files", ServeDir::new(&live.files));
    if live.features.mcp {
        app = app.nest_service("/mcp", mcp::service(automation));
    }
    if live.features.recordings {
        app = app.route("/screenshots", get(screenshots_list).post(screenshot_take));
    }
    if live.features.uploads {
        app = app
            .route("/uploads", get(uploads_list))
            .route("/uploads/{name}", put(upload).delete(upload_remove));
    }
    axum::serve(listener, app.with_state(live)).await
}

/// A client's session socket. Who the client is comes with the request, from whoever let
/// it in; one that comes without is the operator's.
async fn session_socket(
    State(live): State<Live>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    let said = |name: &str| {
        let value = headers.get(name)?.to_str().ok()?;
        Some(percent_decode_str(value).decode_utf8_lossy().into_owned())
    };
    let identity = match said(aperture_runner::SUBJECT_HEADER) {
        Some(subject) => Identity {
            name: said(aperture_runner::NAME_HEADER)
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| subject.clone()),
            subject,
            // Whoever vouches for a caller says what they may do; nothing, when it does not.
            access: said(aperture_runner::ACCESS_HEADER)
                .and_then(|access| access.parse().ok())
                .unwrap_or_default(),
        },
        None => Identity::operator(),
    };
    upgrade.on_upgrade(move |socket| client::serve(live, socket, identity))
}

async fn downloads_list(State(live): State<Live>) -> Json<Vec<Download>> {
    Json(live.downloads.borrow().clone())
}

/// What the session does that nobody has to be connected for.
#[derive(Serialize)]
struct Busy {
    /// Recordings that run or are being edited.
    recordings: usize,
    /// Downloads that are not done yet.
    downloads: usize,
}

async fn busy(State(live): State<Live>) -> Json<Busy> {
    let recordings = live.recordings.list().into_iter().filter(|recording| {
        let editing = recording
            .edit
            .as_ref()
            .is_some_and(|edit| edit.state == EditState::Editing);
        recording.state == record::State::Recording || editing
    });
    let downloads = live.downloads.borrow();
    Json(Busy {
        recordings: recordings.count(),
        downloads: downloads
            .iter()
            .filter(|download| download.state == Progress::Running)
            .count(),
    })
}

/// A file put into the session for the browser to take.
#[derive(Serialize)]
struct Uploaded {
    name: String,
    size: u64,
    /// Where the file is, for the browser as for the session's tools.
    path: PathBuf,
}

async fn uploads_list(State(live): State<Live>) -> Response {
    let directory = live.files.join(UPLOADS);
    let mut uploads = Vec::new();
    let mut entries = match tokio::fs::read_dir(&directory).await {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Json(uploads).into_response();
        }
        Err(err) => return (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response(),
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(metadata) = entry.metadata().await else {
            continue;
        };
        if metadata.is_file() && files::named(&directory, &name).is_some() {
            uploads.push(Uploaded {
                path: entry.path(),
                name,
                size: metadata.len(),
            });
        }
    }
    uploads.sort_by(|a, b| a.name.cmp(&b.name));
    Json(uploads).into_response()
}

/// Takes the request's body as the file `name` of the session's uploads, in place of one
/// there was.
async fn upload(
    State(live): State<Live>,
    RoutePath(name): RoutePath<String>,
    body: Body,
) -> Response {
    let directory = live.files.join(UPLOADS);
    let Some(path) = files::named(&directory, &name) else {
        return (StatusCode::BAD_REQUEST, "not a file name").into_response();
    };
    // Under a name no listing shows until the file is whole.
    let partial = directory.join(format!(".{name}.part"));
    let written = async {
        tokio::fs::create_dir_all(&directory).await?;
        let mut file = tokio::fs::File::create(&partial).await?;
        let mut chunks = body.into_data_stream();
        let mut size = 0;
        while let Some(chunk) = chunks.next().await {
            let chunk = chunk.map_err(std::io::Error::other)?;
            size += chunk.len() as u64;
            if size > UPLOAD_MOST {
                return Ok(None);
            }
            file.write_all(&chunk).await?;
        }
        file.flush().await?;
        tokio::fs::rename(&partial, &path).await?;
        std::io::Result::Ok(Some(size))
    };
    match written.await {
        Ok(Some(size)) => Json(Uploaded { name, size, path }).into_response(),
        Ok(None) => {
            let _ = tokio::fs::remove_file(&partial).await;
            (StatusCode::PAYLOAD_TOO_LARGE, "the file is too large").into_response()
        }
        Err(err) => {
            let _ = tokio::fs::remove_file(&partial).await;
            (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response()
        }
    }
}

async fn upload_remove(State(live): State<Live>, RoutePath(name): RoutePath<String>) -> Response {
    let Some(path) = files::named(&live.files.join(UPLOADS), &name) else {
        return (StatusCode::BAD_REQUEST, "not a file name").into_response();
    };
    match tokio::fs::remove_file(&path).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            StatusCode::NOT_FOUND.into_response()
        }
        Err(err) => (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response(),
    }
}

#[derive(Serialize)]
struct TargetView {
    id: String,
    tab: u32,
    title: String,
    url: String,
    width: u32,
    height: u32,
    scale: f64,
}

async fn targets_list(State(live): State<Live>) -> Json<Vec<TargetView>> {
    let targets = live
        .targets
        .borrow()
        .iter()
        .map(|target| TargetView {
            id: target.id.clone(),
            tab: target.tab,
            title: target.title.clone(),
            url: target.url.clone(),
            width: target.width,
            height: target.height,
            scale: target.scale,
        })
        .collect();
    Json(targets)
}

/// How a screenshot is asked for.
#[derive(Deserialize)]
struct Shot {
    /// No wider than this many pixels: a smaller picture, for a preview.
    width: Option<u32>,
}

async fn screenshot(
    State(live): State<Live>,
    RoutePath(id): RoutePath<String>,
    Query(shot): Query<Shot>,
) -> Response {
    let window = live
        .targets
        .borrow()
        .iter()
        .find(|target| target.id == id)
        .map(|target| target.window);
    let Some(window) = window else {
        return (StatusCode::NOT_FOUND, format!("target {id} not found")).into_response();
    };
    let frame = match live.compositor.screenshot(window).await {
        Ok(frame) => frame,
        Err(err @ aperture_compositor::Error::WindowNotFound(_)) => {
            return (StatusCode::NOT_FOUND, err.to_string()).into_response();
        }
        Err(err @ aperture_compositor::Error::NoContent(_)) => {
            return (StatusCode::CONFLICT, err.to_string()).into_response();
        }
        Err(err) => return (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response(),
    };
    let encoded = tokio::task::spawn_blocking(move || {
        let (width, height, rgba) = match shot.width {
            Some(width) if width > 0 && width < frame.width => shrunk(&frame, width),
            _ => (frame.width, frame.height, frame.rgba),
        };
        encode_png(width, height, rgba)
    });
    match encoded.await {
        Ok(Ok(png)) => ([(header::CONTENT_TYPE, "image/png")], png).into_response(),
        Ok(Err(err)) => (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response(),
        Err(err) => (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct ViewportView {
    width: u32,
    height: u32,
    /// The target keeps its scale when left out.
    scale: Option<f64>,
}

/// Gives a target its own viewport, as near to the one asked for as it can be given.
async fn viewport_set(
    State(live): State<Live>,
    RoutePath(id): RoutePath<String>,
    Json(asked): Json<ViewportView>,
) -> Response {
    let target = live
        .targets
        .borrow()
        .iter()
        .find(|target| target.id == id)
        .cloned();
    let Some(target) = target else {
        return (StatusCode::NOT_FOUND, format!("target {id} not found")).into_response();
    };
    live.compositor.set_viewport(
        target.window,
        Viewport {
            width: asked.width,
            height: asked.height,
            scale: asked.scale.unwrap_or(target.scale),
        },
    );
    StatusCode::NO_CONTENT.into_response()
}

/// Takes the session's proxy configuration, for the connections made from now on.
async fn proxy_update(State(live): State<Live>, Json(config): Json<proxy::Config>) -> Response {
    match live.egress.update(&config) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(reason) => (StatusCode::BAD_REQUEST, reason).into_response(),
    }
}

#[derive(Deserialize, Default)]
struct StartRecording {
    /// The target to record; the newest one when left out.
    target: Option<String>,
    /// What the edit does once the recording stops.
    #[serde(flatten)]
    options: Options,
}

async fn recording_start(State(live): State<Live>, body: Option<Json<StartRecording>>) -> Response {
    let request = body.map(|Json(request)| request).unwrap_or_default();
    let started = live
        .recordings
        .start(request.target.as_deref(), request.options);
    match started.await {
        Ok(recording) => (StatusCode::CREATED, Json(recording)).into_response(),
        Err(err) => (StatusCode::CONFLICT, format!("{err:#}")).into_response(),
    }
}

#[derive(Deserialize, Default)]
struct TakeScreenshot {
    /// The target to take a screenshot of; the newest one when left out.
    target: Option<String>,
}

/// Takes a screenshot of a target and keeps it in the session's files.
async fn screenshot_take(State(live): State<Live>, body: Option<Json<TakeScreenshot>>) -> Response {
    let request = body.map(|Json(request)| request).unwrap_or_default();
    let target = {
        let targets = live.targets.borrow();
        match &request.target {
            Some(id) => targets.iter().find(|target| target.id == *id),
            None => targets.last(),
        }
        .cloned()
    };
    let Some(target) = target else {
        return (StatusCode::NOT_FOUND, "no such target").into_response();
    };
    let frame = match live.compositor.screenshot(target.window).await {
        Ok(frame) => frame,
        Err(err) => return (StatusCode::CONFLICT, err.to_string()).into_response(),
    };
    let files = live.files.clone();
    match tokio::task::spawn_blocking(move || shots::keep(&files, frame, target.title, target.url))
        .await
    {
        Ok(Ok(screenshot)) => (StatusCode::CREATED, Json(screenshot)).into_response(),
        Ok(Err(err)) => (StatusCode::INTERNAL_SERVER_ERROR, format!("{err:#}")).into_response(),
        Err(err) => (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response(),
    }
}

async fn screenshots_list(State(live): State<Live>) -> Response {
    let files = live.files.clone();
    match tokio::task::spawn_blocking(move || shots::list(&files)).await {
        Ok(screenshots) => Json::<Vec<Screenshot>>(screenshots).into_response(),
        Err(err) => (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response(),
    }
}

async fn recording_get(State(live): State<Live>, RoutePath(id): RoutePath<String>) -> Response {
    match live.recordings.get(&id) {
        Ok(recording) => Json(recording).into_response(),
        Err(err) => (StatusCode::NOT_FOUND, format!("{err:#}")).into_response(),
    }
}

async fn recording_stop(State(live): State<Live>, RoutePath(id): RoutePath<String>) -> Response {
    match live.recordings.stop(&id).await {
        Ok(recording) => Json(recording).into_response(),
        Err(err) => (StatusCode::NOT_FOUND, format!("{err:#}")).into_response(),
    }
}

async fn recordings_list(State(live): State<Live>) -> Json<Vec<Recording>> {
    Json(live.recordings.list())
}

/// The frame's pixels at `width` across, each the mean of those it stands for.
pub(super) fn shrunk(frame: &Frame, width: u32) -> (u32, u32, Vec<u8>) {
    let height =
        (u64::from(frame.height) * u64::from(width) / u64::from(frame.width)).max(1) as u32;
    let (from_width, from_height) = (frame.width as usize, frame.height as usize);
    let mut rgba = Vec::with_capacity(width as usize * height as usize * 4);
    for y in 0..height as usize {
        let rows = y * from_height / height as usize
            ..((y + 1) * from_height / height as usize).max(y * from_height / height as usize + 1);
        for x in 0..width as usize {
            let columns = x * from_width / width as usize
                ..((x + 1) * from_width / width as usize).max(x * from_width / width as usize + 1);
            let mut sums = [0u32; 4];
            for row in rows.clone() {
                for column in columns.clone() {
                    let at = (row * from_width + column) * 4;
                    for (sum, value) in sums.iter_mut().zip(&frame.rgba[at..at + 4]) {
                        *sum += u32::from(*value);
                    }
                }
            }
            let count = (rows.len() * columns.len()) as u32;
            rgba.extend(sums.map(|sum| (sum / count) as u8));
        }
    }
    (width, height, rgba)
}

pub(super) fn encode_png(
    width: u32,
    height: u32,
    mut rgba: Vec<u8>,
) -> Result<Vec<u8>, png::EncodingError> {
    // Frames are premultiplied; PNG stores straight alpha.
    for pixel in rgba.as_chunks_mut::<4>().0 {
        let alpha = u32::from(pixel[3]);
        if alpha == 0 || alpha == 255 {
            continue;
        }
        for channel in &mut pixel[..3] {
            *channel = ((u32::from(*channel) * 255 + alpha / 2) / alpha).min(255) as u8;
        }
    }
    let mut out = Cursor::new(Vec::new());
    let mut encoder = png::Encoder::new(&mut out, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_compression(png::Compression::Fast);
    encoder.write_header()?.write_image_data(&rgba)?;
    Ok(out.into_inner())
}

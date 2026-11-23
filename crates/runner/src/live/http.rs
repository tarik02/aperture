//! The session's live endpoints, on a socket in its runtime directory. Whoever reaches the
//! socket is trusted: the executor checks callers before it forwards them here.

use std::{
    io::Cursor,
    path::{Path, PathBuf},
    sync::Arc,
};

use aperture_compositor::{Frame, Handle};
use aperture_runner::{Features, PortRange, proxy};
use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Path as RoutePath, Query, State, WebSocketUpgrade},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use futures_util::StreamExt;
use percent_encoding::percent_decode_str;
use rustix::fs::FileType;
use serde::{Deserialize, Serialize};
use tokio::{io::AsyncWriteExt, sync::watch};
use tracing::warn;

use super::{
    client,
    edit::plan::Options,
    mcp,
    record::{self, Annotation, EditState, Recording, Recordings},
    served,
    shots::{self, Screenshot},
    sound::Sound,
    state,
    stream::Streams,
};
use crate::{
    automation::Automation,
    beneath::Beneath,
    cdp,
    egress::Egress,
    files::{self, Download, Progress, UPLOADS},
    pages::Pages,
    presence::{Identity, Presence},
    targets::{Mode, Tabs, Target},
};

/// The most a state that is put into the session takes.
const STATE_BYTES: usize = 64 * 1024 * 1024;

/// What the live endpoints serve.
#[derive(Clone)]
pub struct Live {
    /// The browser, for what is asked of it directly.
    pub browser: cdp::Client,
    pub compositor: Handle,
    pub streams: Arc<Streams>,
    pub targets: watch::Receiver<Vec<Target>>,
    /// The tabs, for giving them another viewport and another way to be shown.
    pub tabs: Tabs,
    /// The small pictures of the tabs that were last made.
    pub previews: Arc<shots::Previews>,
    pub icons: Arc<super::icons::Icons>,
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
    // The socket an earlier run left; binding says what else is in the way.
    let _ = std::fs::remove_file(socket);
    let listener = tokio::net::UnixListener::bind(socket)?;
    let mut app = Router::new()
        .route("/ws", get(session_socket))
        .route("/targets", get(targets_list))
        .route("/targets/{id}/screenshot.png", get(screenshot))
        .route("/targets/{id}/preview.png", get(preview))
        .route("/targets/{id}/favicon", get(favicon))
        .route("/targets/{id}/viewport", put(viewport_set))
        .route("/targets/{id}/mode", put(mode_set))
        .route("/proxy", put(proxy_update))
        .route(
            "/storage-state",
            post(state_export)
                .put(state_import)
                .layer(DefaultBodyLimit::max(STATE_BYTES)),
        )
        .route("/recordings", get(recordings_list).post(recording_start))
        .route("/recordings/{id}", get(recording_get))
        .route("/recordings/{id}/stop", post(recording_stop))
        .route("/recordings/{id}/retarget", post(recording_retarget))
        .route("/recordings/annotations/{kind}", post(recording_annotate))
        .route("/downloads", get(downloads_list))
        .route("/busy", get(busy))
        .route("/files/{*path}", get(file));
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
    let identity = match vouched(&headers) {
        Ok(identity) => identity.unwrap_or_else(Identity::operator),
        Err(why) => return (StatusCode::BAD_REQUEST, why).into_response(),
    };
    upgrade.on_upgrade(move |socket| client::serve(live, socket, identity))
}

/// Who a request comes from, as whoever let it in says: nobody, for one that comes without,
/// which is the operator's.
pub(super) fn vouched(headers: &HeaderMap) -> Result<Option<Identity>, &'static str> {
    // What vouches for a caller is told in full or the caller is refused: one that half of
    // it is missing of would pass for the operator.
    let vouched = [
        aperture_runner::SUBJECT_HEADER,
        aperture_runner::NAME_HEADER,
        aperture_runner::ACCESS_HEADER,
    ];
    if vouched.iter().any(|name| headers.contains_key(*name))
        && !vouched.iter().all(|name| {
            headers
                .get(*name)
                .is_some_and(|value| value.to_str().is_ok())
        })
    {
        return Err("who the request comes from is not told in full");
    }
    let said = |name: &str| {
        let value = headers.get(name)?.to_str().ok()?;
        Some(percent_decode_str(value).decode_utf8_lossy().into_owned())
    };
    Ok(
        said(aperture_runner::SUBJECT_HEADER).map(|subject| Identity {
            name: said(aperture_runner::NAME_HEADER)
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| subject.clone()),
            subject,
            // Whoever vouches for a caller says what they may do; nothing, when it does not.
            access: said(aperture_runner::ACCESS_HEADER)
                .and_then(|access| access.parse().ok())
                .unwrap_or_default(),
        }),
    )
}

/// Why a route does not do what was asked of it, as it answers.
struct Refusal(StatusCode, String);

impl Refusal {
    fn not_found(what: impl std::fmt::Display) -> Self {
        Self(StatusCode::NOT_FOUND, what.to_string())
    }

    fn bad_request(why: impl std::fmt::Display) -> Self {
        Self(StatusCode::BAD_REQUEST, why.to_string())
    }

    /// What went wrong here rather than with what was asked.
    fn failed(err: impl std::fmt::Display) -> Self {
        Self(StatusCode::INTERNAL_SERVER_ERROR, err.to_string())
    }
}

impl IntoResponse for Refusal {
    fn into_response(self) -> Response {
        (self.0, self.1).into_response()
    }
}

impl From<std::io::Error> for Refusal {
    fn from(err: std::io::Error) -> Self {
        Self::failed(err)
    }
}

impl From<tokio::task::JoinError> for Refusal {
    fn from(err: tokio::task::JoinError) -> Self {
        Self::failed(err)
    }
}

impl From<aperture_compositor::Error> for Refusal {
    fn from(err: aperture_compositor::Error) -> Self {
        let status = match err {
            aperture_compositor::Error::WindowNotFound(_) => StatusCode::NOT_FOUND,
            aperture_compositor::Error::NoContent(_) => StatusCode::CONFLICT,
            aperture_compositor::Error::Render(_) | aperture_compositor::Error::Gone => {
                StatusCode::INTERNAL_SERVER_ERROR
            }
        };
        Self(status, err.to_string())
    }
}

impl From<record::Error> for Refusal {
    fn from(err: record::Error) -> Self {
        let status = match err {
            record::Error::Off | record::Error::State(_) => StatusCode::CONFLICT,
            record::Error::NoTarget | record::Error::NoRecording => StatusCode::NOT_FOUND,
            record::Error::Options(_) => StatusCode::BAD_REQUEST,
            record::Error::Failed(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        Self(status, format!("{err:#}"))
    }
}

impl Live {
    /// The target that is named, by its tab's number or by its id; the newest one when
    /// none is.
    fn target(&self, named: Option<&str>) -> Result<Target, Refusal> {
        let id = named;
        let targets = self.targets.borrow();
        let target = match named {
            Some(named) => crate::targets::named(&targets, named),
            None => targets.last(),
        };
        target.cloned().ok_or_else(|| match id {
            Some(id) => Refusal::not_found(format_args!("target {id} not found")),
            None => Refusal::not_found("the session shows no target"),
        })
    }
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

/// One of the session's files, for whoever keeps it or shows it in a page of their own.
async fn file(
    State(live): State<Live>,
    RoutePath(path): RoutePath<String>,
    headers: HeaderMap,
) -> Result<Response, Refusal> {
    let below = Path::new(&path);
    let name = below.file_name().and_then(|name| name.to_str());
    let opened = Beneath::open(&live.files).and_then(|files| files.file(below));
    let (Some(name), Ok(file)) = (name, opened) else {
        // Whatever is no file of the session's is not there: a directory, a link, a pipe,
        // a path that leads out of the files.
        return Err(Refusal::not_found("no such file"));
    };
    let file = tokio::fs::File::from_std(file);
    Ok(served::file(&headers, file, name).await?)
}

/// A file put into the session for the browser to take.
#[derive(Serialize)]
struct Uploaded {
    name: String,
    size: u64,
    /// Where the file is, for the browser as for the session's tools.
    path: PathBuf,
}

async fn uploads_list(State(live): State<Live>) -> Result<Json<Vec<Uploaded>>, Refusal> {
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

/// Takes the request's body as the file `name` of the session's uploads, in place of one
/// there was.
async fn upload(
    State(live): State<Live>,
    RoutePath(name): RoutePath<String>,
    body: Body,
) -> Result<Json<Uploaded>, Refusal> {
    let path = files::named(&live.files.join(UPLOADS), &name)
        .ok_or_else(|| Refusal::bad_request("not a file name"))?;
    let uploads = Beneath::open(&live.files)?.directory_made(UPLOADS)?;
    // Under a name no listing shows until the file is whole.
    let partial = format!(".{name}.part");
    let written = async {
        let mut file = tokio::fs::File::from_std(uploads.create(&partial)?);
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
        uploads.rename(&partial, &name)?;
        std::io::Result::Ok(Some(size))
    };
    let size = match written.await {
        Ok(Some(size)) => return Ok(Json(Uploaded { name, size, path })),
        Ok(None) => Err(Refusal(
            StatusCode::PAYLOAD_TOO_LARGE,
            "the file is too large".into(),
        )),
        Err(err) => Err(err.into()),
    };
    match uploads.remove(&partial) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => warn!(file = %partial, %err, "what came of an upload is left behind"),
    }
    size
}

async fn upload_remove(
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

#[derive(Serialize)]
struct TargetView {
    id: String,
    tab: u32,
    title: String,
    url: String,
    width: u32,
    height: u32,
    scale: f64,
    /// How the tab's pages are shown, as it was set: `auto`, `desktop` or `mobile`.
    mode: Mode,
    /// Its pages are shown as on a phone now: what the mode comes to.
    mobile: bool,
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
            mode: target.mode,
            mobile: target.mobile,
        })
        .collect();
    Json(targets)
}

/// A target as it looks now, small: for a list of the tabs. One picture of a tab is made
/// in a while, whoever asks and however often, and whoever has it already is told so.
async fn preview(
    State(live): State<Live>,
    RoutePath(id): RoutePath<String>,
    headers: HeaderMap,
) -> Result<Response, Refusal> {
    let target = live.target(Some(&id))?;
    let known: Vec<String> = live
        .targets
        .borrow()
        .iter()
        .map(|target| target.id.clone())
        .collect();
    let made = live.previews.of(&live.compositor, &target, &known).await?;
    let caching = [
        (header::ETAG, made.tag.clone()),
        (header::CACHE_CONTROL, "private, no-cache".to_owned()),
    ];
    let has = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|tag| tag.to_str().ok());
    if has == Some(made.tag.as_str()) {
        return Ok((StatusCode::NOT_MODIFIED, caching).into_response());
    }
    let png = Body::from(made.png.clone());
    Ok((caching, [(header::CONTENT_TYPE, "image/png")], png).into_response())
}

/// The icon of the target's page, which whoever asked keeps for a while: the address it
/// is asked at says which site's it is.
async fn favicon(
    State(live): State<Live>,
    RoutePath(id): RoutePath<String>,
) -> Result<Response, Refusal> {
    let target = live.target(Some(&id))?;
    let known: Vec<String> = live
        .targets
        .borrow()
        .iter()
        .map(|target| target.id.clone())
        .collect();
    let Some(icon) = live.icons.of(&live.pages, &target, &known).await else {
        // Nothing, which whoever shows it takes as no picture, and no failure to tell of.
        return Ok(StatusCode::NO_CONTENT.into_response());
    };
    let told = [
        (header::CONTENT_TYPE, icon.kind),
        (header::CACHE_CONTROL, "private, max-age=600"),
        // An icon is drawn, with styles of its own where it is a drawing, and like all a
        // session answers with it runs nothing where it is shown by itself.
        (
            header::CONTENT_SECURITY_POLICY,
            "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        ),
    ];
    Ok((told, Body::from(icon.bytes.clone())).into_response())
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
) -> Result<Response, Refusal> {
    let target = live.target(Some(&id))?;
    let frame = live.compositor.screenshot(target.window).await?;
    let encoded = tokio::task::spawn_blocking(move || {
        let (width, height, rgba) = match shot.width {
            Some(width) if width > 0 && width < frame.width => shrunk(&frame, width),
            _ => (frame.width, frame.height, frame.rgba),
        };
        encode_png(width, height, rgba)
    });
    let png = encoded.await?.map_err(Refusal::failed)?;
    Ok(([(header::CONTENT_TYPE, "image/png")], png).into_response())
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
) -> Result<StatusCode, Refusal> {
    let target = live.target(Some(&id))?;
    live.tabs
        .resize(&target.id, asked.width, asked.height, asked.scale);
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct ModeView {
    mode: Mode,
    /// Whether the page loads again where the tab comes to be shown another way; it does
    /// when left out.
    reload: Option<bool>,
}

/// Sets how a target's pages are shown. `auto` leaves the tab as it is shown until
/// someone holds it: whoever asks here has no device to go by.
async fn mode_set(
    State(live): State<Live>,
    RoutePath(id): RoutePath<String>,
    Json(asked): Json<ModeView>,
) -> Result<StatusCode, Refusal> {
    let target = live.target(Some(&id))?;
    let reload = asked.reload.unwrap_or(true);
    live.tabs.set_mode(&target.id, asked.mode, None, reload);
    Ok(StatusCode::NO_CONTENT)
}

/// Takes the session's proxy configuration, for the connections made from now on.
async fn proxy_update(
    State(live): State<Live>,
    Json(config): Json<proxy::Config>,
) -> Result<StatusCode, Refusal> {
    live.egress.update(&config).map_err(Refusal::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

/// The cookies and the storage of origins, out of the session's browser.
async fn state_export(
    State(live): State<Live>,
    body: Option<Json<state::Asked>>,
) -> Result<Json<state::State>, Refusal> {
    let asked = body.map(|Json(asked)| asked).unwrap_or_default();
    let targets = live.targets.borrow().clone();
    let exported = state::export(&live.browser, &targets, asked).await;
    Ok(Json(
        exported.map_err(|err| Refusal::bad_request(format!("{err:#}")))?,
    ))
}

/// Cookies and the storage of origins, into the session's browser.
async fn state_import(
    State(live): State<Live>,
    Json(given): Json<state::State>,
) -> Result<StatusCode, Refusal> {
    given.check().map_err(Refusal::bad_request)?;
    let imported = state::import(&live.browser, &given).await;
    imported.map_err(|err| Refusal::failed(format_args!("{err:#}")))?;
    Ok(StatusCode::NO_CONTENT)
}

/// A tab as a request names it: by its number, or by its target's id.
fn named<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Named {
        Tab(u32),
        Target(String),
    }
    Ok(
        Option::<Named>::deserialize(deserializer)?.map(|named| match named {
            Named::Tab(tab) => tab.to_string(),
            Named::Target(id) => id,
        }),
    )
}

#[derive(Deserialize, Default)]
struct StartRecording {
    /// The tab to record; the newest one when left out.
    #[serde(default, deserialize_with = "named")]
    tab: Option<String>,
    /// What the edit does once the recording stops.
    #[serde(flatten)]
    options: Options,
}

async fn recording_start(
    State(live): State<Live>,
    body: Option<Json<StartRecording>>,
) -> Result<(StatusCode, Json<Recording>), Refusal> {
    let request = body.map(|Json(request)| request).unwrap_or_default();
    let started = live
        .recordings
        .start(request.tab.as_deref(), request.options);
    Ok((StatusCode::CREATED, Json(started.await?)))
}

#[derive(Deserialize, Default)]
struct TakeScreenshot {
    /// The tab to take a screenshot of; the newest one when left out.
    #[serde(default, deserialize_with = "named")]
    tab: Option<String>,
}

/// Takes a screenshot of a target and keeps it in the session's files.
async fn screenshot_take(
    State(live): State<Live>,
    body: Option<Json<TakeScreenshot>>,
) -> Result<(StatusCode, Json<Screenshot>), Refusal> {
    let request = body.map(|Json(request)| request).unwrap_or_default();
    let target = live.target(request.tab.as_deref())?;
    let frame = live.compositor.screenshot(target.window).await?;
    let files = live.files.clone();
    let kept =
        tokio::task::spawn_blocking(move || shots::keep(&files, frame, target.title, target.url));
    let screenshot = kept
        .await?
        .map_err(|err| Refusal::failed(format_args!("{err:#}")))?;
    Ok((StatusCode::CREATED, Json(screenshot)))
}

async fn screenshots_list(State(live): State<Live>) -> Result<Json<Vec<Screenshot>>, Refusal> {
    let files = live.files.clone();
    let listed = tokio::task::spawn_blocking(move || shots::list(&files));
    Ok(Json(listed.await??))
}

async fn recording_get(
    State(live): State<Live>,
    RoutePath(id): RoutePath<String>,
) -> Result<Json<Recording>, Refusal> {
    Ok(Json(live.recordings.get(&id)?))
}

async fn recording_stop(
    State(live): State<Live>,
    RoutePath(id): RoutePath<String>,
) -> Result<Json<Recording>, Refusal> {
    Ok(Json(live.recordings.stop(&id).await?))
}

#[derive(Deserialize)]
struct Retarget {
    /// The tab the recording goes on with.
    #[serde(deserialize_with = "named")]
    tab: Option<String>,
}

async fn recording_retarget(
    State(live): State<Live>,
    RoutePath(id): RoutePath<String>,
    Json(to): Json<Retarget>,
) -> Result<Json<Recording>, Refusal> {
    let tab = to
        .tab
        .ok_or_else(|| Refusal::bad_request("pass the `tab`"))?;
    Ok(Json(live.recordings.retarget(&id, &tab).await?))
}

/// Adds a caption, a focus or the pointer's circling to a running recording, or ends
/// its focus.
async fn recording_annotate(
    State(live): State<Live>,
    RoutePath(kind): RoutePath<String>,
    body: Option<Json<Annotation>>,
) -> Result<StatusCode, Refusal> {
    let annotation = body.map(|Json(annotation)| annotation).unwrap_or_default();
    let annotated = live.recordings.annotate(&kind, annotation).await;
    annotated.map_err(|err| Refusal::bad_request(format!("{err:#}")))?;
    Ok(StatusCode::NO_CONTENT)
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

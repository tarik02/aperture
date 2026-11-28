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
use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use tokio::sync::watch;

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
    uploads::{self, Uploads},
};
use crate::{
    automation::Automation,
    beneath::Beneath,
    cdp,
    egress::Egress,
    files::{Download, Progress},
    pace::{Pace, Paced},
    pages::Pages,
    presence::{Identity, Presence},
    restore::{Restore, Restoring},
    targets::{Mode, Tabs, Target},
};

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
    /// How the session's automation moves the pointer in what is recorded.
    pub pace: Paced,
    /// Whether the session is being given what its browser starts with.
    pub restore: Restoring,
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
    pub uploads: Arc<Uploads>,
}

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
        .route("/limits", put(limits_set))
        .route(
            "/storage-state",
            post(state_export)
                .put(state_import)
                .layer(DefaultBodyLimit::max(aperture_runner::STATE_BYTES)),
        )
        .route("/recordings", get(recordings_list).post(recording_start))
        .route("/recordings/{id}", get(recording_get))
        .route("/recordings/{id}/stop", post(recording_stop))
        .route("/recordings/{id}/edit", post(recording_edit))
        .route("/recordings/{id}/retarget", post(recording_retarget))
        .route("/recordings/annotations/{kind}", post(recording_annotate))
        .route("/pace", get(pace_get).put(pace_set))
        .route("/downloads", get(downloads_list))
        .route("/busy", get(busy))
        .route("/files/{*path}", get(file));
    if live.features.mcp {
        let once_restored = axum::middleware::from_fn_with_state(live.clone(), once_restored);
        let tools = Router::new()
            .nest_service("/mcp", mcp::service(automation))
            .layer(once_restored);
        app = app.merge(tools);
    }
    if live.features.recordings {
        app = app.route("/screenshots", get(screenshots_list).post(screenshot_take));
    }
    if live.features.uploads {
        app = app.merge(uploads::routes());
    }
    let swept = uploads::sweep(live.files.clone());
    tokio::select! {
        served = axum::serve(listener, app.with_state(live)) => served,
        () = swept => Ok(()),
    }
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
    // A tab that is not told as one would be every tab.
    let tab = match said(aperture_runner::TAB_HEADER) {
        Some(tab) => Some(tab.parse::<u32>().map_err(|_| "the tab told is no tab")?),
        None => None,
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
            tab,
        }),
    )
}

/// Why a route does not do what was asked of it, as it answers.
pub(super) struct Refusal(pub(super) StatusCode, pub(super) String);

impl Refusal {
    pub(super) fn not_found(what: impl std::fmt::Display) -> Self {
        Self(StatusCode::NOT_FOUND, what.to_string())
    }

    pub(super) fn bad_request(why: impl std::fmt::Display) -> Self {
        Self(StatusCode::BAD_REQUEST, why.to_string())
    }

    /// What went wrong here rather than with what was asked.
    pub(super) fn failed(err: impl std::fmt::Display) -> Self {
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
    /// It is the tab watched last, which whoever comes to watch the session watches.
    watched: bool,
}

async fn targets_list(State(live): State<Live>) -> Json<Vec<TargetView>> {
    // Before the targets are borrowed: what tells of them holds what this asks.
    let watched = live.tabs.watched();
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
            watched: Some(target.tab) == watched,
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
/// What the session is held to that may change while it runs.
#[derive(Deserialize)]
struct Limits {
    /// The largest file put into the session, in bytes; any size without.
    upload_most: Option<u64>,
}

async fn limits_set(State(live): State<Live>, Json(limits): Json<Limits>) -> StatusCode {
    live.uploads.set_most(limits.upload_most);
    StatusCode::NO_CONTENT
}

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

/// Refuses the session's automation while the session is being given what its browser
/// starts with: what a tool did to a page that is not yet what it is to be would be done
/// to another page.
async fn once_restored(
    State(live): State<Live>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    if live.restore.held() {
        return Refusal(
            StatusCode::CONFLICT,
            "the session is being restored".to_owned(),
        )
        .into_response();
    }
    next.run(request).await
}

/// Cookies, the storage of origins and tabs, into the session's browser. The session says
/// that it is being restored for as long as that takes. A state it was started to be given
/// and does not take leaves it saying so: it is not the session that was asked for.
async fn state_import(
    State(live): State<Live>,
    Json(given): Json<state::State>,
) -> Result<StatusCode, Refusal> {
    let awaited = live.restore.held();
    let ended = |failure: Option<String>| match failure {
        Some(reason) if awaited => Restore::Failed(reason),
        _ => Restore::None,
    };
    if let Err(refused) = given.check() {
        live.restore.set(ended(Some(refused.clone())));
        return Err(Refusal::bad_request(refused));
    }
    live.restore.set(Restore::Underway {
        tabs: given.tabs.len() as u32,
        cookies: given.cookies.len() as u32,
        origins: given.origins.len() as u32,
    });
    match state::import(&live.browser, &given).await {
        Ok(()) => {
            live.restore.set(ended(None));
            Ok(StatusCode::NO_CONTENT)
        }
        Err(err) => {
            let reason = format!("{err:#}");
            live.restore.set(ended(Some(reason.clone())));
            Err(Refusal::failed(reason))
        }
    }
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
    /// Go on with whichever tab the session's automation acts on.
    #[serde(default)]
    follow: bool,
}

async fn recording_start(
    State(live): State<Live>,
    body: Option<Json<StartRecording>>,
) -> Result<(StatusCode, Json<Recording>), Refusal> {
    let request = body.map(|Json(request)| request).unwrap_or_default();
    let started = live
        .recordings
        .start(request.tab.as_deref(), request.follow);
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

/// Stops a recording. What is passed says how its edit is made.
async fn recording_stop(
    State(live): State<Live>,
    RoutePath(id): RoutePath<String>,
    options: Option<Json<Options>>,
) -> Result<Json<Recording>, Refusal> {
    let options = options.map(|Json(options)| options).unwrap_or_default();
    Ok(Json(live.recordings.stop(&id, options).await?))
}

/// Makes the edit of a stopped recording again, with what is passed.
async fn recording_edit(
    State(live): State<Live>,
    RoutePath(id): RoutePath<String>,
    options: Option<Json<Options>>,
) -> Result<Json<Recording>, Refusal> {
    let options = options.map(|Json(options)| options).unwrap_or_default();
    Ok(Json(live.recordings.edit(&id, options)?))
}

/// The session's pace, as it is told and set.
#[derive(Serialize, Deserialize)]
struct PaceView {
    pace: Pace,
}

async fn pace_get(State(live): State<Live>) -> Json<PaceView> {
    Json(PaceView {
        pace: live.pace.get(),
    })
}

async fn pace_set(State(live): State<Live>, Json(asked): Json<PaceView>) -> Json<PaceView> {
    live.pace.set(asked.pace);
    Json(PaceView {
        pace: live.pace.get(),
    })
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

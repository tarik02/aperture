//! The session's live endpoints, on a socket in its runtime directory. Whoever reaches the
//! socket is trusted: the executor checks callers before it forwards them here.

use std::{io::Cursor, path::Path, sync::Arc};

use aperture_compositor::{Frame, Handle, Viewport};
use aperture_runner::{PortRange, proxy};
use axum::{
    Json, Router,
    extract::{Path as RoutePath, State, WebSocketUpgrade},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use serde::{Deserialize, Serialize};
use tokio::sync::watch;
use tower_http::services::ServeDir;

use super::{
    client,
    edit::plan::Options,
    mcp,
    record::{Recording, Recordings},
    stream::Streams,
};
use crate::{automation::Automation, egress::Egress, targets::Target};

/// What the live endpoints serve.
#[derive(Clone)]
pub struct Live {
    pub compositor: Handle,
    pub streams: Arc<Streams>,
    pub targets: watch::Receiver<Vec<Target>>,
    pub recordings: Recordings,
    pub egress: Arc<Egress>,
    pub rtc_ports: Option<PortRange>,
}

/// Serves until the listener fails. `files` are the session's files.
pub async fn serve(
    socket: &Path,
    live: Live,
    automation: Arc<Automation>,
    files: &Path,
) -> std::io::Result<()> {
    let _ = std::fs::remove_file(socket);
    let listener = tokio::net::UnixListener::bind(socket)?;
    let app = Router::new()
        .route("/ws", get(session_socket))
        .route("/targets", get(targets_list))
        .route("/targets/{id}/screenshot.png", get(screenshot))
        .route("/targets/{id}/viewport", put(viewport_set))
        .route("/proxy", put(proxy_update))
        .route("/recordings", get(recordings_list).post(recording_start))
        .route("/recordings/{id}", get(recording_get))
        .route("/recordings/{id}/stop", post(recording_stop))
        .nest_service("/files", ServeDir::new(files))
        .nest_service("/mcp", mcp::service(automation))
        .with_state(live);
    axum::serve(listener, app).await
}

/// A client's session socket.
async fn session_socket(State(live): State<Live>, upgrade: WebSocketUpgrade) -> Response {
    upgrade.on_upgrade(move |socket| client::serve(live, socket))
}

#[derive(Serialize)]
struct TargetView {
    id: String,
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
            title: target.title.clone(),
            url: target.url.clone(),
            width: target.width,
            height: target.height,
            scale: target.scale,
        })
        .collect();
    Json(targets)
}

async fn screenshot(State(live): State<Live>, RoutePath(id): RoutePath<String>) -> Response {
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
    match tokio::task::spawn_blocking(move || encode_png(frame)).await {
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

fn encode_png(mut frame: Frame) -> Result<Vec<u8>, png::EncodingError> {
    // Frames are premultiplied; PNG stores straight alpha.
    for pixel in frame.rgba.as_chunks_mut::<4>().0 {
        let alpha = u32::from(pixel[3]);
        if alpha == 0 || alpha == 255 {
            continue;
        }
        for channel in &mut pixel[..3] {
            *channel = ((u32::from(*channel) * 255 + alpha / 2) / alpha).min(255) as u8;
        }
    }
    let mut out = Cursor::new(Vec::new());
    let mut encoder = png::Encoder::new(&mut out, frame.width, frame.height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_compression(png::Compression::Fast);
    encoder.write_header()?.write_image_data(&frame.rgba)?;
    Ok(out.into_inner())
}

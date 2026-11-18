//! The session's live endpoints, on a socket in its runtime directory. Whoever reaches the
//! socket is trusted: the executor checks callers before it forwards them here.

use std::{io::Cursor, path::Path};

use aperture_compositor::{Frame, Handle};
use aperture_runner::PortRange;
use axum::{
    Json, Router,
    extract::{Path as RoutePath, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Serialize;
use tokio::sync::watch;

use super::peer::{self, ConnectError};
use crate::targets::Target;

#[derive(Clone)]
struct Live {
    compositor: Handle,
    targets: watch::Receiver<Vec<Target>>,
    rtc_ports: Option<PortRange>,
}

/// Serves until the listener fails.
pub async fn serve(
    socket: &Path,
    compositor: Handle,
    targets: watch::Receiver<Vec<Target>>,
    rtc_ports: Option<PortRange>,
) -> std::io::Result<()> {
    let _ = std::fs::remove_file(socket);
    let listener = tokio::net::UnixListener::bind(socket)?;
    let app = Router::new()
        .route("/rtc", post(connect))
        .route("/targets", get(targets_list))
        .route("/targets/{id}/screenshot.png", get(screenshot))
        .with_state(Live {
            compositor,
            targets,
            rtc_ports,
        });
    axum::serve(listener, app).await
}

/// Takes a WebRTC offer as SDP and answers with SDP.
async fn connect(State(live): State<Live>, offer: String) -> Response {
    match peer::connect(live.compositor, live.targets, live.rtc_ports, &offer).await {
        Ok(answer) => (
            StatusCode::CREATED,
            [(header::CONTENT_TYPE, "application/sdp")],
            answer,
        )
            .into_response(),
        Err(err @ ConnectError::Offer(_)) => {
            (StatusCode::BAD_REQUEST, err.to_string()).into_response()
        }
        Err(err) => (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response(),
    }
}

#[derive(Serialize)]
struct TargetView {
    id: String,
    title: String,
    url: String,
    width: u32,
    height: u32,
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

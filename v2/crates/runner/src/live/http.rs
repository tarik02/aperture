//! The session's live endpoints, on a socket in its runtime directory. Whoever reaches the
//! socket is trusted: the executor checks callers before it forwards them here.

use std::{io::Cursor, path::Path};

use aperture_compositor::{Frame, Handle, WindowId};
use aperture_runner::PortRange;
use axum::{
    Json, Router,
    extract::{Path as RoutePath, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Serialize;

use super::peer::{self, ConnectError};

/// Serves until the listener fails.
pub async fn serve(
    socket: &Path,
    compositor: Handle,
    rtc_ports: Option<PortRange>,
) -> std::io::Result<()> {
    let _ = std::fs::remove_file(socket);
    let listener = tokio::net::UnixListener::bind(socket)?;
    let app = Router::new()
        .route(
            "/rtc",
            post(move |compositor, offer| connect(compositor, rtc_ports, offer)),
        )
        .route("/windows", get(windows))
        .route("/windows/{id}/screenshot.png", get(screenshot))
        .with_state(compositor);
    axum::serve(listener, app).await
}

/// Takes a WebRTC offer as SDP and answers with SDP.
async fn connect(
    State(compositor): State<Handle>,
    rtc_ports: Option<PortRange>,
    offer: String,
) -> Response {
    match peer::connect(compositor, rtc_ports, &offer).await {
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
struct Window {
    id: u32,
    parent: Option<u32>,
    title: String,
    app_id: String,
    width: u32,
    height: u32,
}

async fn windows(State(compositor): State<Handle>) -> Json<Vec<Window>> {
    let windows = compositor
        .windows()
        .borrow()
        .iter()
        .map(|window| Window {
            id: window.id.0,
            parent: window.parent.map(|parent| parent.0),
            title: window.title.clone(),
            app_id: window.app_id.clone(),
            width: window.width,
            height: window.height,
        })
        .collect();
    Json(windows)
}

async fn screenshot(State(compositor): State<Handle>, RoutePath(id): RoutePath<u32>) -> Response {
    let frame = match compositor.screenshot(WindowId(id)).await {
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

//! A running session's live endpoints, served by the executor at `/sessions/{id}/live`:
//! requests go on to the session's runner, which serves them on a socket in its runtime
//! directory, and the path itself answers with a page that shows the session.

use std::sync::Arc;

use axum::{
    Router,
    body::Body,
    extract::{Path, Request, State},
    http::{StatusCode, Uri, header},
    response::{Html, IntoResponse, Response},
    routing::{any, get},
};
use hyper_util::rt::TokioIo;
use tokio::net::UnixStream;
use tracing::debug;

use crate::sessions::{Error, Sessions};

pub fn path(session_id: &str) -> String {
    format!("/sessions/{session_id}/live")
}

pub fn router(sessions: Arc<Sessions>) -> Router {
    Router::new()
        .route("/sessions/{id}/live", get(viewer))
        .route("/sessions/{id}/live/", get(viewer))
        .route("/sessions/{id}/live/{*rest}", any(forward))
        .with_state(sessions)
}

async fn viewer() -> Html<&'static str> {
    Html(include_str!("viewer.html"))
}

async fn forward(
    State(sessions): State<Arc<Sessions>>,
    Path((id, rest)): Path<(String, String)>,
    mut request: Request,
) -> Response {
    let live = match sessions.live(&id) {
        Ok(live) => live,
        Err(err) => return refuse(err),
    };
    // The runner knows nothing of the executor's paths or its token.
    *request.uri_mut() = match format!("/{rest}").parse::<Uri>() {
        Ok(uri) => uri,
        Err(err) => return (StatusCode::BAD_REQUEST, err.to_string()).into_response(),
    };
    request.headers_mut().remove(header::AUTHORIZATION);

    let answered = async {
        let stream = UnixStream::connect(&live.socket).await?;
        let (mut sender, connection) =
            hyper::client::conn::http1::handshake(TokioIo::new(stream)).await?;
        tokio::spawn(async move {
            if let Err(err) = connection.await {
                debug!(%err, "the connection to a runner failed");
            }
        });
        anyhow::Ok(sender.send_request(request).await?)
    };
    match answered.await {
        Ok(response) => response.map(Body::new),
        Err(err) => (StatusCode::BAD_GATEWAY, format!("{err:#}")).into_response(),
    }
}

fn refuse(err: Error) -> Response {
    let status = match &err {
        Error::NotRunning(_) => StatusCode::CONFLICT,
        Error::Store(
            aperture_store::StoreError::SessionNotFound(_)
            | aperture_store::StoreError::InvalidId(_),
        ) => StatusCode::NOT_FOUND,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    (status, err.to_string()).into_response()
}

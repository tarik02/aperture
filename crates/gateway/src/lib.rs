//! The way into a session from outside: who a request comes from (see [`auth`]), and the
//! routes the session is reached on, which pass what they get on to the session's own
//! sockets. Whoever serves sessions puts this in front of them.
//!
//! The routes say nothing of which session they are of: that is for whoever mounts them.
//! A session that runs on its own has them at the root; an executor has them below
//! `/sessions/{id}` for each of its sessions.
//!
//! A page of another origin reaches none of them from a browser unless its origin is named
//! (see [`Origin`]).
//!
//! - `/` shows the session, unless that is left out;
//! - `/ws` is the session socket;
//! - `/cdp` is its browser's DevTools endpoint;
//! - `/tunnel` is where a client attaches the session's local tunnel;
//! - the rest is the session's own to answer: `/mcp`, its automation, `/targets`,
//!   `/files`, `/uploads`, `/recordings` and so on.

mod access;
pub mod auth;
mod cdp;
mod live;

use std::{fmt, io, net::SocketAddr, path::PathBuf, str::FromStr, sync::Arc};

use axum::{
    Router,
    extract::{FromRequestParts, RawPathParams},
    http::{HeaderValue, StatusCode, request::Parts},
    middleware,
    response::{IntoResponse, Response},
};
use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use tower_http::cors::{AllowHeaders, AllowMethods, AllowOrigin, CorsLayer};

pub use access::{Access, Area};
pub use live::{ask, put, viewer};

/// Who a request to a session comes from, as whoever passed it on says: the subject and
/// the name to show, both percent-encoded, and what they may do (see [`Access`]).
pub const SUBJECT_HEADER: &str = "x-aperture-subject";
pub const NAME_HEADER: &str = "x-aperture-name";
pub const ACCESS_HEADER: &str = "x-aperture-access";

/// What the browser calls its DevTools endpoint: where it listens inside its sandbox. The
/// URLs it lists name it.
pub const DEVTOOLS_AUTHORITY: &str = "127.0.0.1:9222";

/// The browser's DevTools endpoint: HTTP and WebSockets on a Unix socket, as the browser
/// serves them on a port of its sandbox.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Cdp {
    pub socket: PathBuf,
    /// The path of the browser target's WebSocket, `/devtools/browser/<id>`.
    pub browser_path: String,
}

/// Where the session is watched and controlled: the session socket, screenshots and the
/// rest, as HTTP on a socket. Whoever reaches the socket is trusted.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Live {
    pub socket: PathBuf,
    /// Where a client's local tunnel is attached: a connection to this socket is the
    /// tunnel's bytes.
    pub tunnel_socket: PathBuf,
}

/// Why a session is not reached.
#[derive(Debug)]
pub struct Refused {
    pub status: StatusCode,
    pub reason: String,
}

impl IntoResponse for Refused {
    fn into_response(self) -> Response {
        (self.status, self.reason).into_response()
    }
}

/// The sessions behind the gateway.
pub trait Sessions: Send + Sync + 'static {
    /// The live endpoints of the session, for someone who reaches it.
    fn live<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Live, Refused>>;
    /// Its DevTools endpoint, likewise.
    fn cdp<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Cdp, Refused>>;
    /// A connection to the session that stays open, for as long as what this returns is
    /// kept.
    fn present(&self, id: &str) -> Box<dyn Send>;
}

/// Which session a request is for: the `id` in the path the routes are mounted at, and
/// nothing where they are mounted for one session only.
pub struct Which(pub String);

impl<S: Send + Sync> FromRequestParts<S> for Which {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let parameters = RawPathParams::from_request_parts(parts, state)
            .await
            .map_err(IntoResponse::into_response)?;
        let id = parameters.iter().find(|(name, _)| *name == "id");
        Ok(Self(id.map(|(_, id)| id.to_owned()).unwrap_or_default()))
    }
}

/// The routes one session is reached on, with the page that shows it or without. Mounted
/// below a path with an `id` in it, they are those of the session of that id. They let
/// anyone in: see [`guarded`].
pub fn router(sessions: Arc<dyn Sessions>, viewer: bool) -> Router {
    cdp::router(sessions.clone()).merge(live::router(sessions, viewer))
}

/// The routes, for those the keys let in. Pages of `origins` may reach them from a
/// browser; a browser refuses those of any other origin.
pub fn guarded(routes: Router, keys: auth::Keys, origins: &[Origin]) -> Router {
    let routes = routes.layer(middleware::from_fn_with_state(Arc::new(keys), auth::check));
    if origins.is_empty() {
        return routes;
    }
    let any = origins.iter().any(|origin| matches!(origin, Origin::Any));
    let named = origins.iter().filter_map(|origin| match origin {
        Origin::Any => None,
        Origin::One(origin) => Some(origin.clone()),
    });
    let allowed = match any {
        true => AllowOrigin::any(),
        false => AllowOrigin::list(named),
    };
    // Around the check of who asks: a browser asks whether it may before it says who for,
    // and nothing here goes by what a browser sends of itself, such as cookies.
    routes.layer(
        CorsLayer::new()
            .allow_origin(allowed)
            .allow_methods(AllowMethods::mirror_request())
            .allow_headers(AllowHeaders::mirror_request()),
    )
}

/// An origin whose pages may reach the routes from a browser, such as
/// `https://app.example.com`; `*` is any origin.
#[derive(Debug, Clone)]
pub enum Origin {
    Any,
    One(HeaderValue),
}

impl FromStr for Origin {
    type Err = String;

    fn from_str(given: &str) -> Result<Self, Self::Err> {
        if given == "*" {
            return Ok(Self::Any);
        }
        // As a browser sends it: a scheme and a host, a port where it is not the
        // scheme's own, and nothing after.
        let rest = given
            .strip_prefix("https://")
            .or_else(|| given.strip_prefix("http://"));
        let plain = rest.is_some_and(|rest| !rest.is_empty() && !rest.contains(['/', '?', '#']));
        let origin = HeaderValue::from_str(given).ok().filter(|_| plain);
        origin.map(Self::One).ok_or_else(|| {
            format!("{given:?} is no origin like https://app.example.com, nor `*` for any")
        })
    }
}

/// Where requests come in: an address, or a Unix socket given as `unix:PATH` or as a path
/// with a `/` in it.
#[derive(Debug, Clone)]
pub enum Listen {
    Address(SocketAddr),
    Socket(PathBuf),
}

impl FromStr for Listen {
    type Err = String;

    fn from_str(given: &str) -> Result<Self, Self::Err> {
        if let Some(path) = given.strip_prefix("unix:") {
            return Ok(Self::Socket(PathBuf::from(path)));
        }
        if given.contains('/') {
            return Ok(Self::Socket(PathBuf::from(given)));
        }
        given.parse().map(Self::Address).map_err(|_| {
            format!("{given:?} is neither an address like 127.0.0.1:7900 nor a socket's path")
        })
    }
}

impl fmt::Display for Listen {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Address(address) => write!(formatter, "{address}"),
            Self::Socket(path) => write!(formatter, "unix:{}", path.display()),
        }
    }
}

/// What was bound to listen on.
pub enum Listening {
    Address(tokio::net::TcpListener),
    Socket(tokio::net::UnixListener),
}

impl Listen {
    pub async fn bind(&self) -> io::Result<Listening> {
        match self {
            Self::Address(address) => tokio::net::TcpListener::bind(address)
                .await
                .map(Listening::Address),
            Self::Socket(path) => {
                // Whoever listened there before is gone, or this fails for the address
                // being theirs.
                if tokio::net::UnixStream::connect(path).await.is_err() {
                    let _ = std::fs::remove_file(path);
                }
                tokio::net::UnixListener::bind(path).map(Listening::Socket)
            }
        }
    }
}

impl Listening {
    /// Serves the routes until `stopped` is.
    pub async fn serve<F>(self, routes: Router, stopped: F) -> io::Result<()>
    where
        F: Future<Output = ()> + Send + 'static,
    {
        match self {
            Self::Address(listener) => {
                axum::serve(listener, routes)
                    .with_graceful_shutdown(stopped)
                    .await
            }
            Self::Socket(listener) => {
                axum::serve(listener, routes)
                    .with_graceful_shutdown(stopped)
                    .await
            }
        }
    }
}

//! A session that runs on its own: `aperture-runner serve` makes its directories, and
//! serves its endpoints to whoever holds its token, as an executor serves those of its
//! sessions.

use std::{
    fs,
    hash::{Hash, Hasher},
    os::unix::fs::DirBuilderExt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use anyhow::Context;
use aperture_gateway::{Listen, Listening, Origin, Refused, auth::Keys};
use aperture_runner::{
    Cdp, Live, Profile, Spec,
    options::{Directories, Options},
    proxy,
};
use futures_util::future::BoxFuture;
use tracing::{info, warn};

/// Runs one browser session on its own, for whoever holds its token: the session's
/// endpoints are served here, as an executor serves those of its sessions.
#[derive(clap::Parser)]
#[command(
    name = "aperture-runner serve",
    bin_name = "aperture-runner serve",
    version
)]
pub struct Serve {
    /// The session's own directory: its profile, its files and what else it keeps from
    /// one run to the next. Made when there is none.
    #[arg(long, env = "APERTURE_DATA")]
    data: PathBuf,
    /// An address, or a Unix socket as `unix:PATH`.
    #[arg(long, env = "APERTURE_LISTEN", default_value = "127.0.0.1:7900")]
    listen: Listen,
    /// The session's id, for whoever gives it one: tickets have to name it then. The
    /// session itself has no use for one.
    #[arg(long, env = "APERTURE_SESSION_ID")]
    id: Option<String>,
    /// Sockets and the state of the running session. A directory of its own below
    /// `$XDG_RUNTIME_DIR` by default.
    #[arg(long, env = "APERTURE_RUNTIME_DIR")]
    runtime_dir: Option<PathBuf>,
    /// The token requests carry. Generated into the session's directory by default.
    #[arg(long, env = "APERTURE_TOKEN_FILE")]
    token_file: Option<PathBuf>,
    /// The public key tickets are signed with: Ed25519, as PEM. A ticket lets one person
    /// into the session; none are taken without a key.
    #[arg(long, env = "APERTURE_TICKET_KEY")]
    ticket_key: Option<PathBuf>,
    /// An origin whose pages may reach the session from a browser, such as
    /// `https://app.example.com`, or `*` for any. A browser refuses the pages of every
    /// other origin but the session's own. May be repeated.
    #[arg(
        long = "cors-origin",
        env = "APERTURE_CORS_ORIGINS",
        value_delimiter = ','
    )]
    cors_origins: Vec<Origin>,
    #[command(flatten)]
    options: Options,
}

impl Serve {
    /// The session's spec, and what it is served with.
    pub fn session(self) -> anyhow::Result<(Spec, Front)> {
        let private = |dir: &Path| {
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(dir)
                .with_context(|| format!("failed to make {}", dir.display()))
        };
        for name in ["profile", "work", "cache", "files", "state"] {
            private(&self.data.join(name))?;
        }
        let data = self.data.canonicalize()?;
        let within = |name: &str| data.join(name);
        // The directory tells one session's sockets from another's.
        let named = {
            let mut hasher = std::hash::DefaultHasher::new();
            data.hash(&mut hasher);
            format!("aperture-session-{:016x}", hasher.finish())
        };
        let runtime_dir = match self.runtime_dir {
            Some(dir) => dir,
            None => match std::env::var_os("XDG_RUNTIME_DIR").filter(|dir| !dir.is_empty()) {
                Some(dir) => PathBuf::from(dir).join(named),
                None => std::env::temp_dir().join(named),
            },
        };
        private(&runtime_dir)?;
        let mut keys = Keys::read(
            &self.token_file.unwrap_or_else(|| within("token")),
            self.ticket_key.as_deref(),
            // At the root, for a ticket that names it, or any ticket when it has no name.
            Box::new({
                let id = self.id.clone();
                move |session| {
                    id.as_deref()
                        .is_none_or(|id| id == session)
                        .then(String::new)
                }
            }),
        )?;
        // Nobody else is there to say what the operator is called.
        keys.names = true;
        let directories = Directories {
            profile: Profile {
                lowers: Vec::new(),
                upper: within("profile"),
                work: within("work"),
            },
            cache: within("cache"),
            files: within("files"),
            state: within("state"),
        };
        let setup = self.options.setup()?;
        let spec = setup.spec(
            self.id.as_deref().unwrap_or("own"),
            runtime_dir.canonicalize()?,
            directories,
            proxy::Config::default(),
            setup.features(),
            setup.network(),
        );
        Ok((
            spec,
            Front {
                origins: self.cors_origins,
                listen: self.listen,
                listening: Mutex::new(None),
                keys: Mutex::new(Some(keys)),
            },
        ))
    }
}

/// Where a session that runs on its own is reached, and by whom.
pub struct Front {
    listen: Listen,
    /// From when the address is taken until the session is served.
    listening: Mutex<Option<Listening>>,
    origins: Vec<Origin>,
    /// Until the session is served.
    keys: Mutex<Option<Keys>>,
}

impl Front {
    /// Takes the address the session is served at, before anything of the session is
    /// started: an address that is another's fails the session while it has no browser
    /// yet, and nobody else takes it in the seconds a browser needs to start. Whoever
    /// connects before the session is served waits until it is.
    pub async fn listen(&self) -> anyhow::Result<()> {
        let listening = self
            .listen
            .bind()
            .await
            .with_context(|| format!("failed to listen on {}", self.listen))?;
        *self.listening.lock().expect("not poisoned") = Some(listening);
        Ok(())
    }

    /// Serves the session, from now until the task is aborted.
    pub async fn serve(
        &self,
        live: Live,
        cdp: Option<Cdp>,
    ) -> anyhow::Result<tokio::task::JoinHandle<()>> {
        let own = Own { live, cdp };
        let keys = self.keys.lock().expect("not poisoned").take();
        let keys = keys.context("the session is served already")?;
        let listening = self.listening.lock().expect("not poisoned").take();
        let listening = listening.context("the session's address was not taken")?;
        info!(listen = %self.listen, "session served");
        let routes = aperture_gateway::router(Arc::new(own), true);
        let app = aperture_gateway::guarded(routes, keys, &self.origins);
        Ok(tokio::spawn(async move {
            if let Err(err) = listening.serve(app, std::future::pending()).await {
                warn!("the session is no longer served: {err}");
            }
        }))
    }
}

/// The session itself, as the gateway reaches it.
struct Own {
    live: Live,
    /// None where the session does not serve its DevTools endpoint.
    cdp: Option<Cdp>,
}

impl aperture_gateway::Sessions for Own {
    fn live<'a>(&'a self, _id: &'a str) -> BoxFuture<'a, Result<Live, Refused>> {
        Box::pin(async move { Ok(self.live.clone()) })
    }

    fn cdp<'a>(&'a self, _id: &'a str) -> BoxFuture<'a, Result<Cdp, Refused>> {
        Box::pin(async move {
            self.cdp.clone().ok_or_else(|| Refused {
                status: axum::http::StatusCode::NOT_FOUND,
                reason: "the session's DevTools endpoint is off".to_owned(),
            })
        })
    }

    fn present(&self, _id: &str) -> Box<dyn Send> {
        Box::new(())
    }
}

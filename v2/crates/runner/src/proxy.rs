//! A session's proxy configuration: named upstreams and an ordered list of rules, each of
//! which routes the browser connections its match covers. The first rule that matches a
//! connection decides; one no rule matches goes direct.
//!
//! ```json
//! {
//!   "upstreams": {
//!     "operator": { "url": "wss+yamux+socks5://tunnel.example/x", "auth": "…" },
//!     "corp":     { "url": "socks5://user:pass@corp:1080" }
//!   },
//!   "rules": [
//!     { "match": "*.test",         "via": "operator" },
//!     { "match": "*.net",          "via": "http://proxy:8080" },
//!     { "match": "localhost:3000", "via": "local" },
//!     { "match": "*.ai",           "via": "refuse" }
//!   ]
//! }
//! ```
//!
//! A match is `host` or `host:port`, where the host is exact, `*.suffix` for subdomains or
//! `*` for any host. `*` never matches localhost: a catch-all would otherwise send what a
//! page means for its own machine to a remote one. A rule's `via` is `direct`, `refuse`,
//! `local` (the tunnel a client attached to the session), the name of an upstream, or a
//! proxy's URL.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use url::Url;

const MAX_UPSTREAMS: usize = 32;
const MAX_RULES: usize = 256;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub upstreams: BTreeMap<String, Upstream>,
    pub rules: Vec<Rule>,
}

/// A proxy, with its credentials in the URL, or a tunnel, with the secret it is dialed
/// with as `auth`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Upstream {
    pub url: String,
    #[serde(default)]
    pub auth: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rule {
    #[serde(rename = "match")]
    pub matches: String,
    pub via: String,
}

/// Where a connection goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    /// Made from the session's node.
    Direct,
    Refuse,
    /// Through the tunnel a client attached; refused while none is.
    Local,
    Proxy(Proxy),
    Tunnel(Tunnel),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scheme {
    Socks5,
    Http,
    Https,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proxy {
    pub scheme: Scheme,
    pub host: String,
    pub port: u16,
    pub credentials: Option<(String, String)>,
}

/// A tunnel the session dials: yamux over a WebSocket, SOCKS5 on its streams.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tunnel {
    /// The upstream's name, which the dialed tunnel is kept under.
    pub name: String,
    /// The WebSocket's URL, `ws://` or `wss://`.
    pub url: String,
    pub host: String,
    pub port: u16,
    pub auth: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Host {
    Any,
    /// `.suffix`, with its dot.
    Subdomains(String),
    Exact(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Pattern {
    host: Host,
    port: Option<u16>,
}

/// A configuration, checked and ready to route by.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Routes(Vec<(Pattern, Route)>);

impl Config {
    /// Checks the configuration and makes its routes. What is wrong is said for whoever
    /// wrote it.
    pub fn compile(&self) -> Result<Routes, String> {
        if self.upstreams.len() > MAX_UPSTREAMS {
            return Err(format!("at most {MAX_UPSTREAMS} upstreams are allowed"));
        }
        if self.rules.len() > MAX_RULES {
            return Err(format!("at most {MAX_RULES} rules are allowed"));
        }
        let mut upstreams = BTreeMap::new();
        for (name, upstream) in &self.upstreams {
            let named = name.starts_with(|first: char| first.is_ascii_lowercase())
                && name.len() <= 63
                && name
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
            if !named || matches!(name.as_str(), "direct" | "refuse" | "local") {
                return Err(format!(
                    "upstream name {name:?} must be lowercase letters, digits and dashes, and not direct, refuse or local"
                ));
            }
            let route = upstream_route(name, upstream)
                .map_err(|reason| format!("upstream {name:?}: {reason}"))?;
            upstreams.insert(name.as_str(), route);
        }
        let mut routes = Vec::new();
        for (index, rule) in self.rules.iter().enumerate() {
            let number = index + 1;
            let pattern =
                pattern(&rule.matches).map_err(|reason| format!("rule {number}: {reason}"))?;
            let route = match rule.via.trim() {
                "direct" => Route::Direct,
                "refuse" => Route::Refuse,
                "local" => Route::Local,
                via => match upstreams.get(via) {
                    Some(route) => route.clone(),
                    None if via.contains("://") => {
                        let inline = Upstream {
                            url: via.to_owned(),
                            auth: None,
                        };
                        match upstream_route("", &inline) {
                            Ok(Route::Tunnel(_)) | Err(_) if via.contains("+yamux+") => {
                                return Err(format!(
                                    "rule {number}: a tunnel needs auth, so declare it as a named upstream"
                                ));
                            }
                            Ok(route) => route,
                            Err(reason) => return Err(format!("rule {number}: {reason}")),
                        }
                    }
                    None => return Err(format!("rule {number}: unknown upstream {via:?}")),
                },
            };
            routes.push((pattern, route));
        }
        Ok(Routes(routes))
    }
}

impl Routes {
    pub fn route(&self, host: &str, port: u16) -> &Route {
        let host = host.trim_end_matches('.').to_ascii_lowercase();
        let local = host == "localhost" || host.ends_with(".localhost");
        self.0
            .iter()
            .find(|(pattern, _)| {
                pattern.port.is_none_or(|wanted| wanted == port)
                    && match &pattern.host {
                        Host::Any => !local,
                        Host::Subdomains(suffix) => host.ends_with(suffix.as_str()),
                        Host::Exact(exact) => host == *exact,
                    }
            })
            .map_or(&Route::Direct, |(_, route)| route)
    }
}

fn pattern(text: &str) -> Result<Pattern, String> {
    let text = text.trim().to_ascii_lowercase();
    let (host, port) = match text.rsplit_once(':') {
        Some((host, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => {
            let port = port
                .parse()
                .map_err(|_| format!("{text:?} has no valid port"))?;
            (host, Some(port))
        }
        _ => (text.as_str(), None),
    };
    let host = match host {
        "" => return Err("a match needs a host".into()),
        "*" => Host::Any,
        host => match host.strip_prefix("*.") {
            Some(suffix) if !suffix.is_empty() && !suffix.contains('*') => {
                Host::Subdomains(format!(".{suffix}"))
            }
            None if !host.contains('*') => Host::Exact(host.trim_end_matches('.').to_owned()),
            _ => return Err(format!("{text:?} is not a host, *.suffix or *")),
        },
    };
    Ok(Pattern { host, port })
}

fn upstream_route(name: &str, upstream: &Upstream) -> Result<Route, String> {
    let url = Url::parse(upstream.url.trim()).map_err(|err| format!("invalid url: {err}"))?;
    let host = url
        .host_str()
        .filter(|host| !host.is_empty())
        .ok_or("the url has no host")?;
    // IPv6 addresses come in brackets, which no resolver takes.
    let host = host.trim_matches(|c| c == '[' || c == ']').to_owned();
    let auth = upstream
        .auth
        .as_deref()
        .map(str::trim)
        .filter(|auth| !auth.is_empty());

    if let Some(carrier) = url.scheme().strip_suffix("+yamux+socks5") {
        let (secure, default_port) = match carrier {
            "ws" => (false, 80),
            "wss" => (true, 443),
            _ => return Err("a tunnel url is ws+yamux+socks5:// or wss+yamux+socks5://".into()),
        };
        let auth = auth.ok_or("auth is required for a tunnel url")?;
        let port = url.port().unwrap_or(default_port);
        let mut path = url.path().to_owned();
        if let Some(query) = url.query() {
            path = format!("{path}?{query}");
        }
        let carrier = if secure { "wss" } else { "ws" };
        let authority = if host.contains(':') {
            format!("[{host}]")
        } else {
            host.clone()
        };
        return Ok(Route::Tunnel(Tunnel {
            name: name.to_owned(),
            url: format!("{carrier}://{authority}:{port}{path}"),
            host,
            port,
            auth: auth.to_owned(),
        }));
    }
    if auth.is_some() {
        return Err("auth is only for a tunnel url; a proxy's credentials go in its url".into());
    }
    let (scheme, default_port) = match url.scheme() {
        "socks5" | "socks5h" | "socks" => (Scheme::Socks5, 1080),
        "http" => (Scheme::Http, 80),
        "https" => (Scheme::Https, 443),
        other => return Err(format!("unsupported proxy scheme {other:?}")),
    };
    let credentials = (!url.username().is_empty()).then(|| {
        (
            url.username().to_owned(),
            url.password().unwrap_or_default().to_owned(),
        )
    });
    Ok(Route::Proxy(Proxy {
        scheme,
        host,
        port: url.port().unwrap_or(default_port),
        credentials,
    }))
}

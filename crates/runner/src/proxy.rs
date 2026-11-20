//! A session's proxy configuration: named upstreams, an ordered list of rules, each of
//! which routes the browser connections its match covers, and how names are resolved. The
//! first rule that matches a connection decides; one no rule matches goes direct.
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
//!     { "match": "app.test:443",   "via": "local", "to": "localhost:3000", "tls": true },
//!     { "match": "*.ai",           "via": "refuse" }
//!   ],
//!   "dns": {
//!     "servers": ["1.1.1.1"],
//!     "records": [{ "name": "*.internal.test", "addresses": ["203.0.113.7"] }]
//!   }
//! }
//! ```
//!
//! A match is `host` or `host:port`, where the host is exact, `*.suffix` for subdomains or
//! `*` for any host. `*` never matches localhost: a catch-all would otherwise send what a
//! page means for its own machine to a remote one. A rule's `via` is `direct`, `refuse`,
//! `local` (the tunnel a client attached to the session), the name of an upstream, or a
//! proxy's URL.
//!
//! A rule's `to`, `host` or `host:port`, is where its connections are made instead of where
//! the browser named. With `tls` the session answers the browser's TLS itself, with a
//! certificate of its own that the session's browser takes for the name, and passes on
//! what is inside: a server that speaks no TLS is `https://` to the session's pages. Such a
//! rule is for port 443 unless its match names another.
//!
//! `dns` is for the names the session resolves itself: those of connections made from its
//! node, and those its browser asks for when it has a network of its own. A proxy or a
//! tunnel resolves what goes through it. A record's name is a host as in a match, and the
//! first record that covers a name gives its addresses; the other names are asked of
//! `servers`, or of the node's own resolvers when there are none.

use std::{collections::BTreeMap, net::IpAddr};

use serde::{Deserialize, Serialize};
use url::Url;

const MAX_UPSTREAMS: usize = 32;
const MAX_RULES: usize = 256;
const MAX_SERVERS: usize = 8;
const HTTPS_PORT: u16 = 443;
const MAX_RECORDS: usize = 256;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub upstreams: BTreeMap<String, Upstream>,
    pub rules: Vec<Rule>,
    pub dns: Dns,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Dns {
    /// The addresses of the resolvers to ask.
    pub servers: Vec<String>,
    pub records: Vec<Record>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Record {
    pub name: String,
    pub addresses: Vec<String>,
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
    #[serde(default)]
    pub to: Option<String>,
    #[serde(default)]
    pub tls: bool,
}

/// What a rule says of the connections it covers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Way {
    pub route: Route,
    /// Where the connection is made, when not where the browser named.
    pub to: Option<To>,
    /// Whether the session answers the browser's TLS itself.
    pub tls: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct To {
    pub host: String,
    /// The port the browser named, when none.
    pub port: Option<u16>,
}

static DIRECT: Way = Way {
    route: Route::Direct,
    to: None,
    tls: false,
};

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

impl Host {
    fn covers(&self, name: &str) -> bool {
        match self {
            Self::Any => name != "localhost" && !name.ends_with(".localhost"),
            Self::Subdomains(suffix) => name.ends_with(suffix.as_str()),
            Self::Exact(exact) => name == exact,
        }
    }
}

/// A configuration, checked and ready to route by.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Routes {
    rules: Vec<(Pattern, Way)>,
    pub names: Names,
}

/// How the session resolves names.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Names {
    /// The resolvers to ask; the node's own when there are none.
    pub servers: Vec<IpAddr>,
    records: Vec<(Host, Vec<IpAddr>)>,
}

impl Names {
    /// The addresses a record gives the name, when one covers it.
    pub fn recorded(&self, name: &str) -> Option<&[IpAddr]> {
        let name = name.trim_end_matches('.').to_ascii_lowercase();
        self.records
            .iter()
            .find(|(host, _)| host.covers(&name))
            .map(|(_, addresses)| addresses.as_slice())
    }
}

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
            let covered =
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
            let to = match rule.to.as_deref().map(str::trim) {
                None | Some("") => None,
                Some(to) => {
                    match pattern(to).map_err(|reason| format!("rule {number}: {reason}"))? {
                        Pattern {
                            host: Host::Exact(host),
                            port,
                        } => Some(To { host, port }),
                        _ => return Err(format!("rule {number}: {to:?} is not a host")),
                    }
                }
            };
            if route == Route::Refuse && (to.is_some() || rule.tls) {
                return Err(format!(
                    "rule {number}: a connection that is refused goes nowhere"
                ));
            }
            // What is not TLS is not answered as TLS: a rule that names no port is for
            // the port HTTPS has.
            let covered = Pattern {
                port: covered.port.or(rule.tls.then_some(HTTPS_PORT)),
                ..covered
            };
            let way = Way {
                route,
                to,
                tls: rule.tls,
            };
            routes.push((covered, way));
        }
        Ok(Routes {
            rules: routes,
            names: self.dns.compile()?,
        })
    }
}

impl Dns {
    fn compile(&self) -> Result<Names, String> {
        if self.servers.len() > MAX_SERVERS {
            return Err(format!("at most {MAX_SERVERS} dns servers are allowed"));
        }
        if self.records.len() > MAX_RECORDS {
            return Err(format!("at most {MAX_RECORDS} dns records are allowed"));
        }
        let address = |text: &String| {
            text.trim()
                .parse::<IpAddr>()
                .map_err(|_| format!("{text:?} is not an address"))
        };
        let servers = self
            .servers
            .iter()
            .map(|server| address(server).map_err(|reason| format!("dns server: {reason}")))
            .collect::<Result<_, _>>()?;
        let mut records = Vec::new();
        for (index, record) in self.records.iter().enumerate() {
            let said = |reason: String| format!("dns record {}: {reason}", index + 1);
            let host = match pattern(&record.name).map_err(said)? {
                Pattern { host, port: None } => host,
                _ => return Err(said("a name has no port".into())),
            };
            if record.addresses.is_empty() {
                return Err(said("a name needs an address".into()));
            }
            let addresses = record
                .addresses
                .iter()
                .map(address)
                .collect::<Result<_, _>>()
                .map_err(said)?;
            records.push((host, addresses));
        }
        Ok(Names { servers, records })
    }
}

impl Routes {
    pub fn route(&self, host: &str, port: u16) -> &Way {
        let host = host.trim_end_matches('.').to_ascii_lowercase();
        self.rules
            .iter()
            .find(|(pattern, _)| {
                pattern.port.is_none_or(|wanted| wanted == port) && pattern.host.covers(&host)
            })
            .map_or(&DIRECT, |(_, way)| way)
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

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
//! `*` for any host. `*` never matches localhost, by its name or by a loopback address: a
//! catch-all would otherwise send what a page means for its own machine to a remote one.
//! An exact host may be an address, and a network, `10.0.0.0/8` or `fd00::/8`, covers the
//! addresses in it: both are for connections the browser names by address, as what a name
//! resolves to is not known where rules are gone by. An IPv6 address or network has colons
//! of its own, so it takes a port in brackets alone: `[::1]:443`, and `::1` or `[::1]` for
//! any port. A rule's `via` is `direct`, `refuse`, `local` (the tunnel a client attached to
//! the session), the name of an upstream, or a proxy's URL.
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

use ipnet::IpNet;
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
    /// A name, or an address as [`IpAddr`] writes it.
    Exact(String),
    Network(IpNet),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Pattern {
    host: Host,
    port: Option<u16>,
}

impl Host {
    fn covers(&self, named: &Named) -> bool {
        let Named { name, address } = named;
        match self {
            Self::Any => {
                name != "localhost"
                    && !name.ends_with(".localhost")
                    && !address.is_some_and(|address| address.is_loopback())
            }
            Self::Subdomains(suffix) => address.is_none() && name.ends_with(suffix.as_str()),
            Self::Exact(exact) => name == exact,
            Self::Network(network) => address.is_some_and(|address| network.contains(&address)),
        }
    }
}

/// What a connection or a question names, as patterns have it: without the dot a name may
/// end with, in lowercase, and an address as [`IpAddr`] writes it, whatever way it came.
struct Named {
    name: String,
    address: Option<IpAddr>,
}

impl Named {
    fn new(name: &str) -> Self {
        let name = name.trim_end_matches('.').to_ascii_lowercase();
        let bare = name
            .strip_prefix('[')
            .and_then(|name| name.strip_suffix(']'));
        let address = bare.unwrap_or(&name).parse::<IpAddr>().ok().map(|address| {
            // An IPv4 address in IPv6's clothes is the IPv4 address.
            match address {
                IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(address, IpAddr::V4),
                v4 => v4,
            }
        });
        let name = address.map_or(name, |address| address.to_string());
        Self { name, address }
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
        let named = Named::new(name);
        self.records
            .iter()
            .find(|(host, _)| host.covers(&named))
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
                Pattern {
                    host: Host::Network(_),
                    ..
                } => return Err(said("a network is not a name".into())),
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
        let named = Named::new(host);
        self.rules
            .iter()
            .find(|(pattern, _)| {
                pattern.port.is_none_or(|wanted| wanted == port) && pattern.host.covers(&named)
            })
            .map_or(&DIRECT, |(_, way)| way)
    }
}

fn pattern(text: &str) -> Result<Pattern, String> {
    let text = text.trim().to_ascii_lowercase();
    let port = |port: &str| {
        port.parse::<u16>()
            .map_err(|_| format!("{text:?} has no valid port"))
    };
    let unknown = || format!("{text:?} is not a host, *.suffix, *, an address or a network");
    let (host, port) = if let Some(bracketed) = text.strip_prefix('[') {
        let (host, after) = bracketed.split_once(']').ok_or_else(unknown)?;
        // Brackets are for what has colons of its own.
        if !host.contains(':') {
            return Err(unknown());
        }
        match after.strip_prefix(':') {
            Some(after) => (host, Some(port(after)?)),
            None if after.is_empty() => (host, None),
            None => return Err(format!("{text:?} has no valid port")),
        }
    } else {
        match text.rsplit_once(':') {
            // More colons than one are an IPv6 address's own.
            Some((host, after)) if !host.contains(':') => (host, Some(port(after)?)),
            _ => (text.as_str(), None),
        }
    };
    let host = if let Ok(address) = host.parse::<IpAddr>() {
        Host::Exact(Named::new(&address.to_string()).name)
    } else if let Ok(network) = host.parse::<IpNet>() {
        Host::Network(network.trunc())
    } else if host.contains([':', '/', '[', ']']) {
        return Err(unknown());
    } else {
        match host {
            "" => return Err("a match needs a host".into()),
            "*" => Host::Any,
            host => match host.strip_prefix("*.") {
                Some(suffix) if !suffix.contains('*') => {
                    let suffix = suffix.trim_end_matches('.');
                    if suffix.is_empty() {
                        return Err(unknown());
                    }
                    Host::Subdomains(format!(".{suffix}"))
                }
                None if !host.contains('*') => Host::Exact(host.trim_end_matches('.').to_owned()),
                _ => return Err(unknown()),
            },
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(matches: &str, via: &str) -> Rule {
        Rule {
            matches: matches.to_owned(),
            via: via.to_owned(),
            to: None,
            tls: false,
        }
    }

    fn routes(rules: &[Rule]) -> Routes {
        let config = Config {
            rules: rules.to_vec(),
            ..Config::default()
        };
        config.compile().unwrap()
    }

    /// Whether a rule with this match covers the connection: it refuses, and what no rule
    /// covers goes direct.
    fn covers(matches: &str, host: &str, port: u16) -> bool {
        routes(&[rule(matches, "refuse")]).route(host, port).route == Route::Refuse
    }

    #[test]
    fn a_match_covers_the_connections_it_names() {
        let table = [
            ("example.test", "example.test", 443, true),
            ("example.test", "example.test", 8080, true),
            ("example.test", "www.example.test", 443, false),
            ("example.test", "badexample.test", 443, false),
            ("example.test", "example.test.other", 443, false),
            // However it is written, and however the browser names it.
            ("Example.TEST", "example.test", 443, true),
            ("example.test", "EXAMPLE.test", 443, true),
            ("example.test.", "example.test", 443, true),
            ("example.test", "example.test.", 443, true),
            ("  example.test  ", "example.test", 443, true),
            ("example.test:8080", "example.test", 8080, true),
            ("example.test:8080", "example.test", 443, false),
            ("*.example.test", "www.example.test", 443, true),
            ("*.example.test", "a.b.example.test", 443, true),
            ("*.Example.TEST.", "www.example.test", 443, true),
            ("*.example.test", "example.test", 443, false),
            ("*.example.test", "badexample.test", 443, false),
            ("*.example.test:8080", "www.example.test", 8080, true),
            ("*.example.test:8080", "www.example.test", 443, false),
            ("*", "example.test", 443, true),
            ("*", "203.0.113.7", 443, true),
            ("*", "2001:db8::1", 443, true),
            ("*:8080", "example.test", 8080, true),
            ("*:8080", "example.test", 443, false),
            // What a page means for its own machine is no catch-all's.
            ("*", "localhost", 3000, false),
            ("*", "LOCALHOST.", 3000, false),
            ("*", "app.localhost", 3000, false),
            ("*", "127.0.0.1", 3000, false),
            ("*", "127.8.9.10", 3000, false),
            ("*", "::1", 3000, false),
            ("*", "::ffff:127.0.0.1", 3000, false),
            ("*", "notlocalhost", 3000, true),
            ("*", "localhost.example.test", 3000, true),
            ("localhost", "localhost", 3000, true),
            ("localhost:3000", "localhost", 3000, true),
            ("localhost:3000", "localhost", 3001, false),
            ("*.localhost", "app.localhost", 3000, true),
            ("127.0.0.1", "127.0.0.1", 3000, true),
            // An address, with a port and without.
            ("203.0.113.7", "203.0.113.7", 443, true),
            ("203.0.113.7", "203.0.113.8", 443, false),
            ("203.0.113.7:8080", "203.0.113.7", 8080, true),
            ("203.0.113.7:8080", "203.0.113.7", 443, false),
            ("*.7", "203.0.113.7", 443, false),
            ("::1", "::1", 443, true),
            ("::1", "::1", 8080, true),
            ("[::1]", "::1", 8080, true),
            ("[::1]:443", "::1", 443, true),
            ("[::1]:443", "::1", 8080, false),
            ("[::1]:443", "::2", 443, false),
            ("2001:db8::1", "2001:db8::1", 443, true),
            ("2001:DB8:0:0:0:0:0:1", "2001:db8::1", 443, true),
            ("2001:db8::1", "2001:db8:0:0::1", 443, true),
            ("2001:db8::1", "[2001:db8::1]", 443, true),
            ("[2001:db8::1]:8443", "2001:db8::1", 8443, true),
            ("[2001:db8::1]:8443", "2001:db8::1", 443, false),
            // Colons that are an address's own name no port.
            ("2001:db8::443", "2001:db8::443", 80, true),
            ("2001:db8::443", "2001:db8::", 443, false),
            ("::ffff:203.0.113.7", "203.0.113.7", 443, true),
            ("203.0.113.7", "::ffff:203.0.113.7", 443, true),
            // A network covers the addresses in it, and no name.
            ("10.0.0.0/8", "10.1.2.3", 443, true),
            ("10.0.0.0/8", "11.0.0.1", 443, false),
            ("10.1.2.3/8", "10.200.0.1", 443, true),
            ("10.0.0.0/8:8080", "10.1.2.3", 8080, true),
            ("10.0.0.0/8:8080", "10.1.2.3", 443, false),
            ("10.0.0.0/8", "::ffff:10.1.2.3", 443, true),
            ("10.0.0.0/8", "10.example.test", 443, false),
            ("0.0.0.0/0", "203.0.113.7", 443, true),
            ("0.0.0.0/0", "2001:db8::1", 443, false),
            ("0.0.0.0/0", "example.test", 443, false),
            ("fd00::/8", "fd12:3456::1", 443, true),
            ("fd00::/8", "fe80::1", 443, false),
            ("[fd00::/8]", "fd12:3456::1", 443, true),
            ("[fd00::/8]:8443", "fd12:3456::1", 8443, true),
            ("[fd00::/8]:8443", "fd12:3456::1", 443, false),
            ("::/0", "2001:db8::1", 443, true),
            ("::/0", "203.0.113.7", 443, false),
        ];
        for (matches, host, port, covered) in table {
            assert_eq!(
                covers(matches, host, port),
                covered,
                "{matches:?} and {host}:{port}"
            );
        }
    }

    #[test]
    fn what_is_no_match_is_said_to_be_none() {
        let refused = [
            "",
            "  ",
            ":443",
            "*.",
            "*..",
            "*.*.test",
            "a*.test",
            "*test",
            "example.test:",
            "example.test:https",
            "example.test:65536",
            "example.test:-1",
            "example:test:443",
            "a:b:c",
            "[::1",
            "[::1]443",
            "[::1]:",
            "[::1]:https",
            "[::1]:65536",
            "[example.test]:443",
            "[203.0.113.7]:443",
            "[]",
            "::1]:443",
            "2001:db8::g",
            "10.0.0.0/33",
            "fd00::/129",
            "example.test/24",
            "http://example.test",
        ];
        for matches in refused {
            let config = Config {
                rules: vec![rule(matches, "direct")],
                ..Config::default()
            };
            assert!(config.compile().is_err(), "{matches:?}");
        }
    }

    #[test]
    fn the_first_rule_that_covers_a_connection_decides() {
        let routes = routes(&[
            rule("api.example.test:8443", "refuse"),
            rule("api.example.test", "direct"),
            rule("*.example.test", "local"),
            rule("192.0.2.0/24", "local"),
            rule("*", "refuse"),
            rule("late.test", "local"),
        ]);
        let table = [
            ("api.example.test", 8443, Route::Refuse),
            ("api.example.test", 443, Route::Direct),
            ("www.example.test", 443, Route::Local),
            ("192.0.2.9", 443, Route::Local),
            ("other.test", 443, Route::Refuse),
            // A rule after one that covers everything is never reached.
            ("late.test", 443, Route::Refuse),
            // What no rule covers is made from the node.
            ("localhost", 3000, Route::Direct),
            ("127.0.0.1", 3000, Route::Direct),
        ];
        for (host, port, route) in table {
            assert_eq!(routes.route(host, port).route, route, "{host}:{port}");
        }
    }

    #[test]
    fn a_rule_that_answers_tls_is_for_the_port_https_has_unless_it_names_another() {
        let answered = |matches: &str, to: &str| Rule {
            to: Some(to.to_owned()),
            tls: true,
            ..rule(matches, "local")
        };
        let routes = routes(&[
            answered("app.test", "localhost:3000"),
            answered("other.test:8443", "[::1]:3000"),
            answered("bare.test", "::1"),
        ]);
        let to = |host: &str, port| {
            let way = routes.route(host, port);
            (way.tls, way.to.clone().map(|to| (to.host, to.port)))
        };
        assert_eq!(
            to("app.test", 443),
            (true, Some(("localhost".into(), Some(3000))))
        );
        assert_eq!(to("app.test", 80), (false, None));
        assert_eq!(
            to("other.test", 8443),
            (true, Some(("::1".into(), Some(3000))))
        );
        assert_eq!(to("other.test", 443), (false, None));
        assert_eq!(to("bare.test", 443), (true, Some(("::1".into(), None))));

        for to in ["*.test", "*", "10.0.0.0/8", "[fd00::/8]:443"] {
            let config = Config {
                rules: vec![answered("app.test", to)],
                ..Config::default()
            };
            assert!(config.compile().is_err(), "{to:?}");
        }
    }

    #[test]
    fn a_record_is_for_a_name_and_no_network() {
        let recorded = |name: &str| Config {
            dns: Dns {
                servers: Vec::new(),
                records: vec![Record {
                    name: name.to_owned(),
                    addresses: vec!["203.0.113.7".to_owned()],
                }],
            },
            ..Config::default()
        };
        let names = recorded("*.internal.test").compile().unwrap().names;
        assert!(names.recorded("a.Internal.test.").is_some());
        assert!(names.recorded("internal.test").is_none());
        for name in ["10.0.0.0/8", "internal.test:53", "[::1]:53"] {
            assert!(recorded(name).compile().is_err(), "{name:?}");
        }
    }
}

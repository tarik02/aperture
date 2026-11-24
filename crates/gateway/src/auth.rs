//! Who a request comes from, and what they may do.
//!
//! The token of whoever serves the sessions is the operator's: whoever holds it may do
//! anything. Anyone else comes with a ticket, which whoever stands above signs for one
//! person and one session: a JWT signed with Ed25519 (`EdDSA`), checked against the public
//! key that was given. A ticket lets its holder watch the session it names, and do what
//! its `access` says, area by area (see [`Access`]). It lets them in for as long as it is
//! good: what was opened with it stays open after, but for a session socket whose ticket
//! says `until` when, and one whose caller the operator dismisses. A ticket that says a
//! `path` is good at that one route of its session and nowhere else: it is what a link to
//! one file is made of.

use std::{
    collections::HashMap,
    fs,
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::Context;

use axum::{
    extract::{Request, State},
    http::{HeaderValue, Method, StatusCode, header, header::InvalidHeaderValue},
    middleware::Next,
    response::{IntoResponse, Response},
};
use jsonwebtoken::{Algorithm, DecodingKey, Validation};
use percent_encoding::{NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};
use serde::Deserialize;
use subtle::ConstantTimeEq;

use crate::{ACCESS_HEADER, Access, Area, NAME_HEADER, Refused, SUBJECT_HEADER};

/// What a ticket says.
#[derive(Deserialize)]
struct Claims {
    /// Who it is for: whatever names the person to whoever signed it.
    sub: String,
    /// The name others in the session see; the subject without.
    name: Option<String>,
    /// The session it is for.
    sid: String,
    /// What its holder may do besides watching: an area's name to `r`, `w` or `rw`.
    #[serde(default)]
    access: HashMap<String, String>,
    /// When what let its holder in ends, in seconds since the epoch: a session socket
    /// opened with the ticket is closed then. One opened with a ticket that says nothing
    /// stays for as long as its client does.
    until: Option<u64>,
    /// The one route the ticket is good at, as a path below its session's own; at every
    /// route its access gives, without.
    path: Option<String>,
}

/// Who a request comes from; with every request that got in.
#[derive(Debug, Clone)]
pub struct Caller {
    pub subject: String,
    pub name: String,
    pub access: Access,
    /// When the caller's sockets into the session are closed whatever they do; never, without.
    pub until: Option<SystemTime>,
}

impl Caller {
    /// Tells the session's runner who the request comes from, in place of whatever the
    /// request itself says of that.
    pub fn name_in(&self, headers: &mut axum::http::HeaderMap) -> Result<(), InvalidHeaderValue> {
        let access = self.access.to_string();
        let name = utf8_percent_encode(&self.name, NON_ALPHANUMERIC).to_string();
        let subject = utf8_percent_encode(&self.subject, NON_ALPHANUMERIC).to_string();
        for (header, value) in [
            (SUBJECT_HEADER, subject.as_str()),
            (NAME_HEADER, name.as_str()),
            (ACCESS_HEADER, access.as_str()),
        ] {
            // A caller the runner is not told of would be nobody's, which there is the
            // operator: the request is not passed on without all three.
            headers.insert(header, HeaderValue::from_str(value)?);
        }
        Ok(())
    }
}

pub struct Keys {
    /// The operator's token.
    pub token: Arc<str>,
    /// What tickets are checked against; none are taken without.
    pub tickets: Option<DecodingKey>,
    /// Where the session a ticket names is reached, when it is one of those served here.
    pub place: Place,
    /// Whether the operator says what to be called, with `name` beside the token. That is
    /// for a session served on its own; where someone signs tickets, names are theirs to
    /// give.
    pub names: bool,
}

/// The path of a session by its id; none for a session that is not served.
pub type Place = Box<dyn Fn(&str) -> Option<String> + Send + Sync>;

impl Keys {
    /// The operator's token from the file `token`, which is made with a new one when
    /// there is none, and the public key tickets are checked against from `ticket_key`,
    /// in PEM.
    pub fn read(token: &Path, ticket_key: Option<&Path>, place: Place) -> anyhow::Result<Self> {
        if !token.exists() {
            let made = format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            );
            // Whoever waits for the file reads it the moment it is there: it is written
            // whole and as its owner's alone under another name, and given its name then.
            // Written where it is to be, it was empty for a moment, and anyone's to read.
            let mut making = token.as_os_str().to_owned();
            making.push(format!(".{}", std::process::id()));
            let making = PathBuf::from(making);
            let written = fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(&making)
                .and_then(|mut file| file.write_all(made.as_bytes()))
                .and_then(|()| fs::rename(&making, token));
            written.with_context(|| format!("failed to write {}", token.display()))?;
        }
        let read = fs::read_to_string(token)
            .with_context(|| format!("failed to read the token {}", token.display()))?;
        let read = read.trim();
        anyhow::ensure!(!read.is_empty(), "the token {} is empty", token.display());
        let tickets = match ticket_key {
            Some(key) => {
                let pem = fs::read(key)
                    .with_context(|| format!("failed to read the ticket key {}", key.display()))?;
                Some(DecodingKey::from_ed_pem(&pem).context("the ticket key is no Ed25519 key")?)
            }
            None => None,
        };
        Ok(Self {
            token: Arc::from(read),
            tickets,
            place,
            names: false,
        })
    }
}

/// The token or ticket comes in `Authorization: Bearer`, or in the query as `token` for
/// what cannot set headers: a page a person opens, and what that page loads.
pub async fn check(State(keys): State<Arc<Keys>>, mut request: Request, next: Next) -> Response {
    match caller(&keys, &request) {
        Ok(caller) => {
            request.extensions_mut().insert(caller);
            next.run(request).await
        }
        Err(refused) => refused.into_response(),
    }
}

fn caller(keys: &Keys, request: &Request) -> Result<Caller, Refused> {
    let refused = |status, reason: &str| Refused {
        status,
        reason: reason.to_owned(),
    };
    let header = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    let asked = |name: &str| {
        let query = request.uri().query()?;
        let mut pairs = query.split('&').filter_map(|pair| pair.split_once('='));
        pairs.find(|(key, _)| *key == name).map(|(_, value)| value)
    };
    let given = header
        .or(asked("token"))
        .ok_or_else(|| refused(StatusCode::UNAUTHORIZED, "no token or ticket was given"))?;
    if bool::from(given.as_bytes().ct_eq(keys.token.as_bytes())) {
        let name = asked("name")
            .filter(|_| keys.names)
            // A form writes a space as a plus.
            .map(|name| name.replace('+', " "))
            .map(|name| percent_decode_str(&name).decode_utf8_lossy().into_owned())
            .filter(|name| !name.is_empty());
        return Ok(Caller {
            subject: "operator".to_owned(),
            name: name.unwrap_or_else(|| "Operator".to_owned()),
            access: Access::ALL,
            until: None,
        });
    }
    let key = keys
        .tickets
        .as_ref()
        .ok_or_else(|| refused(StatusCode::UNAUTHORIZED, "that is not the token"))?;
    // Why a ticket is no good is its holder's to know: it says nothing of the key.
    let claims = ticket(key, given).map_err(|err| {
        let reason = format!("that is not the token, and no good ticket: {err}");
        refused(StatusCode::UNAUTHORIZED, &reason)
    })?;
    let access = Access::of(&claims.access);
    if !allows(
        keys,
        &claims.sid,
        access,
        claims.path.as_deref(),
        request.method(),
        request.uri().path(),
    ) {
        return Err(refused(
            StatusCode::FORBIDDEN,
            "the ticket does not give this",
        ));
    }
    Ok(Caller {
        name: claims.name.unwrap_or_else(|| claims.sub.clone()),
        subject: claims.sub,
        access,
        until: claims
            .until
            .map(|seconds| UNIX_EPOCH + Duration::from_secs(seconds)),
    })
}

/// What a ticket says, when it is signed with the key and still good.
fn ticket(key: &DecodingKey, given: &str) -> Result<Claims, jsonwebtoken::errors::Error> {
    let mut validation = Validation::new(Algorithm::EdDSA);
    validation.set_required_spec_claims(&["exp", "sub"]);
    validation.validate_aud = false;
    Ok(jsonwebtoken::decode::<Claims>(given, key, &validation)?.claims)
}

/// What a request to a session takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Needs {
    /// Nothing but being let into the session.
    Watching,
    Reading(Area),
    Writing(Area),
    /// The operator's token: no ticket gives it.
    Operator,
}

/// What the request for `rest`, a path below the session's own, takes. A route that is
/// not named here is the operator's, so that a new one is nobody's by oversight.
fn needs(method: &Method, rest: &str) -> Needs {
    let mut parts = rest.trim_start_matches('/').split('/');
    let (first, second) = (parts.next().unwrap_or_default(), parts.next());
    let reads = *method == Method::GET || *method == Method::HEAD;
    let either = |area| match reads {
        true => Needs::Reading(area),
        false => Needs::Writing(area),
    };
    match (first, second) {
        ("" | "ws" | "busy", None) if reads => Needs::Watching,
        ("targets", _) if reads => Needs::Watching,
        // What the session showed when it last rested, for whoever may watch it.
        ("preview.png", None) if reads => Needs::Watching,
        ("targets", Some(_)) if rest.ends_with("/viewport") || rest.ends_with("/mode") => {
            Needs::Writing(Area::Tabs)
        }
        ("recordings" | "screenshots", _) => either(Area::Recordings),
        // How the automation moves in what is recorded is for whoever may record.
        ("pace", None) => either(Area::Recordings),
        ("uploads", _) => either(Area::Uploads),
        ("downloads", None) if reads => Needs::Reading(Area::Downloads),
        ("files", Some("recordings" | "screenshots")) if reads => Needs::Reading(Area::Recordings),
        ("files", Some("downloads")) if reads => Needs::Reading(Area::Downloads),
        ("files", Some("uploads")) if reads => Needs::Reading(Area::Uploads),
        ("proxy", None) if !reads => Needs::Writing(Area::Proxy),
        // What the browser keeps for the sites it visits is whose its DevTools endpoint
        // is: that tells the same, a cookie at a time.
        ("storage-state", None) if !reads => Needs::Writing(Area::Cdp),
        ("mcp", _) => Needs::Writing(Area::Mcp),
        ("cdp", _) => Needs::Writing(Area::Cdp),
        ("tunnel", None) => Needs::Writing(Area::Tunnel),
        _ => Needs::Operator,
    }
}

/// Whether a ticket for the session `sid` with this access lets its holder do this.
/// Nothing outside the session is a ticket's, and of the session nothing but the route
/// `only`, where the ticket names one.
fn allows(
    keys: &Keys,
    sid: &str,
    access: Access,
    only: Option<&str>,
    method: &Method,
    path: &str,
) -> bool {
    let Some(session) = (keys.place)(sid) else {
        return false;
    };
    let Some(rest) = path.strip_prefix(&session) else {
        return false;
    };
    if !rest.is_empty() && !rest.starts_with('/') {
        return false;
    }
    if only.is_some_and(|only| only != rest) {
        return false;
    }
    match needs(method, rest) {
        Needs::Watching => true,
        Needs::Reading(area) => access.reads(area),
        Needs::Writing(area) => access.writes(area),
        Needs::Operator => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use Area::{Cdp, Downloads, Mcp, Proxy, Recordings, Tabs, Tunnel, Uploads};
    use Needs::{Operator, Reading, Watching, Writing};

    #[test]
    fn a_route_takes_what_is_said_of_it_and_one_that_is_not_named_the_operator() {
        let (get, head, post, put, delete) = (
            Method::GET,
            Method::HEAD,
            Method::POST,
            Method::PUT,
            Method::DELETE,
        );
        let table = [
            (&get, "", Watching),
            (&get, "/", Watching),
            (&head, "/", Watching),
            (&get, "/ws", Watching),
            (&get, "/busy", Watching),
            (&get, "/preview.png", Watching),
            (&get, "/targets", Watching),
            (&get, "/targets/7", Watching),
            (&post, "/", Operator),
            (&delete, "/", Operator),
            (&post, "/ws", Operator),
            (&get, "/ws/more", Operator),
            (&get, "/preview.png/more", Operator),
            (&put, "/targets/7/viewport", Writing(Tabs)),
            (&put, "/targets/7/mode", Writing(Tabs)),
            (&post, "/targets", Operator),
            (&delete, "/targets/7", Operator),
            (&put, "/targets/7/other", Operator),
            (&get, "/recordings", Reading(Recordings)),
            (&post, "/recordings", Writing(Recordings)),
            (&get, "/pace", Reading(Recordings)),
            (&put, "/pace", Writing(Recordings)),
            (&delete, "/recordings/one.mp4", Writing(Recordings)),
            (&get, "/screenshots", Reading(Recordings)),
            (&post, "/screenshots", Writing(Recordings)),
            (&get, "/uploads", Reading(Uploads)),
            (&put, "/uploads/a.txt", Writing(Uploads)),
            (&delete, "/uploads/a.txt", Writing(Uploads)),
            (&get, "/downloads", Reading(Downloads)),
            (&post, "/downloads", Operator),
            (&delete, "/downloads", Operator),
            (&get, "/downloads/a.txt", Operator),
            (&get, "/files/recordings/one.mp4", Reading(Recordings)),
            (&head, "/files/recordings/one.mp4", Reading(Recordings)),
            (&get, "/files/screenshots/one.png", Reading(Recordings)),
            (&get, "/files/downloads/a.txt", Reading(Downloads)),
            (&get, "/files/uploads/a.txt", Reading(Uploads)),
            (&put, "/files/uploads/a.txt", Operator),
            (&delete, "/files/downloads/a.txt", Operator),
            (&get, "/files", Operator),
            (&get, "/files/profile/Cookies", Operator),
            (&put, "/proxy", Writing(Proxy)),
            (&get, "/proxy", Operator),
            (&put, "/proxy/more", Operator),
            (&put, "/storage-state", Writing(Cdp)),
            (&post, "/storage-state", Writing(Cdp)),
            (&get, "/storage-state", Operator),
            (&get, "/mcp", Writing(Mcp)),
            (&post, "/mcp", Writing(Mcp)),
            (&get, "/cdp", Writing(Cdp)),
            (&get, "/cdp/devtools/page/7", Writing(Cdp)),
            (&get, "/tunnel", Writing(Tunnel)),
            (&post, "/tunnel", Writing(Tunnel)),
            (&get, "/tunnel/more", Operator),
            (&get, "/suspend", Operator),
            (&post, "/suspend", Operator),
            (&get, "/anything-new", Operator),
        ];
        for (method, rest, needed) in table {
            assert_eq!(needs(method, rest), needed, "{method} {rest}");
        }
    }

    #[test]
    fn a_ticket_gives_its_own_session_what_its_access_says_and_nothing_else() {
        let keys = Keys {
            token: Arc::from("operator"),
            tickets: None,
            place: Box::new(|sid| (sid == "abc").then(|| "/sessions/abc".to_owned())),
            names: false,
        };
        let nothing = Access::default();
        let uploads: Access = "uploads:rw".parse().unwrap();
        let reads: Access = "uploads:r recordings:r downloads:r".parse().unwrap();
        let tabs: Access = "tabs:w".parse().unwrap();
        let file = Some("/files/uploads/a.txt");
        let (get, put) = (Method::GET, Method::PUT);
        let table = [
            // Watching is everyone's who is let into the session.
            ("abc", nothing, None, &get, "/sessions/abc", true),
            ("abc", nothing, None, &get, "/sessions/abc/", true),
            ("abc", nothing, None, &get, "/sessions/abc/ws", true),
            ("abc", nothing, None, &get, "/sessions/abc/targets", true),
            // An area is its reader's to read and its writer's to write.
            ("abc", nothing, None, &get, "/sessions/abc/uploads", false),
            ("abc", reads, None, &get, "/sessions/abc/uploads", true),
            (
                "abc",
                reads,
                None,
                &put,
                "/sessions/abc/uploads/a.txt",
                false,
            ),
            (
                "abc",
                uploads,
                None,
                &put,
                "/sessions/abc/uploads/a.txt",
                true,
            ),
            ("abc", uploads, None, &get, "/sessions/abc/downloads", false),
            (
                "abc",
                reads,
                None,
                &get,
                "/sessions/abc/files/downloads/a",
                true,
            ),
            (
                "abc",
                reads,
                None,
                &get,
                "/sessions/abc/files/recordings/a",
                true,
            ),
            (
                "abc",
                nothing,
                None,
                &put,
                "/sessions/abc/targets/7/viewport",
                false,
            ),
            (
                "abc",
                tabs,
                None,
                &put,
                "/sessions/abc/targets/7/viewport",
                true,
            ),
            (
                "abc",
                tabs,
                None,
                &put,
                "/sessions/abc/targets/7/mode",
                true,
            ),
            ("abc", Access::ALL, None, &get, "/sessions/abc/tunnel", true),
            ("abc", reads, None, &get, "/sessions/abc/tunnel", false),
            // What is the operator's is no ticket's, whatever it says.
            (
                "abc",
                Access::ALL,
                None,
                &Method::DELETE,
                "/sessions/abc",
                false,
            ),
            (
                "abc",
                Access::ALL,
                None,
                &Method::POST,
                "/sessions/abc/suspend",
                false,
            ),
            (
                "abc",
                Access::ALL,
                None,
                &get,
                "/sessions/abc/anything-new",
                false,
            ),
            // Nothing outside the session, and no session whose name only starts as its own.
            ("abc", Access::ALL, None, &get, "/sessions/abcd", false),
            ("abc", Access::ALL, None, &get, "/sessions/abcd/ws", false),
            ("abc", Access::ALL, None, &get, "/sessions/ab", false),
            ("abc", Access::ALL, None, &get, "/sessions", false),
            ("abc", Access::ALL, None, &get, "/", false),
            (
                "abc",
                Access::ALL,
                None,
                &get,
                "/other/sessions/abc/ws",
                false,
            ),
            // A session that is not served here.
            ("gone", Access::ALL, None, &get, "/sessions/gone/ws", false),
            ("gone", Access::ALL, None, &get, "/sessions/abc/ws", false),
            // A ticket for one route is good there alone, and gives no more there than its
            // access does.
            (
                "abc",
                reads,
                file,
                &get,
                "/sessions/abc/files/uploads/a.txt",
                true,
            ),
            (
                "abc",
                reads,
                file,
                &get,
                "/sessions/abc/files/uploads/b.txt",
                false,
            ),
            (
                "abc",
                reads,
                file,
                &get,
                "/sessions/abc/files/uploads/a.txt/",
                false,
            ),
            ("abc", reads, file, &get, "/sessions/abc/ws", false),
            ("abc", reads, file, &get, "/sessions/abc", false),
            (
                "abc",
                nothing,
                file,
                &get,
                "/sessions/abc/files/uploads/a.txt",
                false,
            ),
        ];
        for (sid, access, only, method, path, allowed) in table {
            assert_eq!(
                allows(&keys, sid, access, only, method, path),
                allowed,
                "{sid} {access} {only:?} {method} {path}"
            );
        }
    }
}

//! Who a request comes from.
//!
//! The token of whoever serves the sessions is the operator's: whoever holds it may do
//! anything. Anyone else comes with a ticket, which whoever stands above signs for one
//! person and one session: a JWT signed with Ed25519 (`EdDSA`), checked against the public
//! key that was given. A ticket lets its holder into the session's live endpoints, as
//! far as its role goes.

use std::{fs, os::unix::fs::PermissionsExt, path::Path, sync::Arc};

use anyhow::Context;

use axum::{
    extract::{Request, State},
    http::{HeaderValue, Method, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use jsonwebtoken::{Algorithm, DecodingKey, Validation};
use percent_encoding::{NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};
use serde::Deserialize;
use subtle::ConstantTimeEq;

use crate::{NAME_HEADER, ROLE_HEADER, SUBJECT_HEADER};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    /// Watches the session.
    View,
    /// Gives it input, and files.
    Control,
    /// Does all a session's live endpoints do.
    Admin,
}

/// What a ticket says.
#[derive(Deserialize)]
struct Claims {
    /// Who it is for: whatever names the person to whoever signed it.
    sub: String,
    /// The name others in the session see; the subject without.
    name: Option<String>,
    role: Role,
    /// The session it is for.
    sid: String,
}

/// Who a request comes from; with every request that got in.
#[derive(Debug, Clone)]
pub struct Caller {
    pub subject: String,
    pub name: String,
    pub role: Role,
}

impl Caller {
    /// Tells the session's runner who the request comes from, in place of whatever the
    /// request itself says of that.
    pub fn name_in(&self, headers: &mut axum::http::HeaderMap) {
        let role = match self.role {
            Role::View => "view",
            Role::Control => "control",
            Role::Admin => "admin",
        };
        let name = utf8_percent_encode(&self.name, NON_ALPHANUMERIC).to_string();
        let subject = utf8_percent_encode(&self.subject, NON_ALPHANUMERIC).to_string();
        for (header, value) in [
            (SUBJECT_HEADER, subject.as_str()),
            (NAME_HEADER, name.as_str()),
            (ROLE_HEADER, role),
        ] {
            match HeaderValue::from_str(value) {
                Ok(value) => headers.insert(header, value),
                Err(_) => headers.remove(header),
            };
        }
    }
}

pub struct Keys {
    /// The operator's token.
    pub token: Arc<str>,
    /// What tickets are checked against; none are taken without.
    pub tickets: Option<DecodingKey>,
    /// Where the session a ticket names is reached, when it is one of those served here.
    pub place: Place,
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
            fs::write(token, &made)
                .with_context(|| format!("failed to write {}", token.display()))?;
            fs::set_permissions(token, fs::Permissions::from_mode(0o600))?;
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

fn caller(keys: &Keys, request: &Request) -> Result<Caller, StatusCode> {
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
    let given = header.or(asked("token")).ok_or(StatusCode::UNAUTHORIZED)?;
    if bool::from(given.as_bytes().ct_eq(keys.token.as_bytes())) {
        // The operator says what to be called: there is nobody to say otherwise.
        let name = asked("name")
            .map(|name| percent_decode_str(name).decode_utf8_lossy().into_owned())
            .filter(|name| !name.is_empty());
        return Ok(Caller {
            subject: "operator".to_owned(),
            name: name.unwrap_or_else(|| "Operator".to_owned()),
            role: Role::Admin,
        });
    }
    let claims = keys
        .tickets
        .as_ref()
        .and_then(|key| ticket(key, given))
        .ok_or(StatusCode::UNAUTHORIZED)?;
    if !allows(keys, &claims, request.method(), request.uri().path()) {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(Caller {
        name: claims.name.unwrap_or_else(|| claims.sub.clone()),
        subject: claims.sub,
        role: claims.role,
    })
}

/// What a ticket says, when it is signed with the key and still good.
fn ticket(key: &DecodingKey, given: &str) -> Option<Claims> {
    let mut validation = Validation::new(Algorithm::EdDSA);
    validation.set_required_spec_claims(&["exp", "sub"]);
    validation.validate_aud = false;
    jsonwebtoken::decode::<Claims>(given, key, &validation)
        .ok()
        .map(|ticket| ticket.claims)
}

/// Whether a ticket lets its holder do this: watching is anyone's, files and a target's
/// viewport take a role that gives input, and the rest of what the session itself answers
/// is an admin's. Its browser's DevTools, its automation and its tunnel are no ticket's,
/// and nor is anything outside the session.
fn allows(keys: &Keys, claims: &Claims, method: &Method, path: &str) -> bool {
    let Some(session) = (keys.place)(&claims.sid) else {
        return false;
    };
    let Some(rest) = path.strip_prefix(&session) else {
        return false;
    };
    if !rest.is_empty() && !rest.starts_with('/') {
        return false;
    }
    let below = |part: &str| {
        rest.strip_prefix(part)
            .is_some_and(|more| more.is_empty() || more.starts_with('/'))
    };
    if below("/cdp") || below("/mcp") || below("/tunnel") {
        return false;
    }
    let needed = if method == Method::GET {
        Role::View
    } else if rest.starts_with("/uploads/") || rest.ends_with("/viewport") {
        Role::Control
    } else {
        Role::Admin
    };
    claims.role >= needed
}

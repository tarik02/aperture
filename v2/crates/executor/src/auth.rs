//! Who a request comes from.
//!
//! The executor's own token is the operator's: whoever holds it may do anything. Anyone
//! else comes with a ticket, which whoever runs the executors signs for one person and
//! one session: a JWT signed with Ed25519 (`EdDSA`), which the executor checks against the
//! public key it is given. A ticket lets its holder into the session's live endpoints, as
//! far as its role goes.

use std::sync::Arc;

use aperture_runner::{NAME_HEADER, ROLE_HEADER, SUBJECT_HEADER};
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
    if !allows(&claims, request.method(), request.uri().path()) {
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
/// viewport take a role that gives input, and the rest of a session's live endpoints is
/// an admin's. Nothing outside them is a ticket's.
fn allows(claims: &Claims, method: &Method, path: &str) -> bool {
    let live = crate::live::path(&claims.sid);
    let Some(rest) = path.strip_prefix(&live) else {
        return false;
    };
    if !rest.is_empty() && !rest.starts_with('/') {
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

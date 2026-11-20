//! What the session's browser keeps for the sites it visits, taken out of a session and
//! put into another: its cookies, and what pages stored for their origins. The form is
//! JSON that an export gives and an import takes:
//!
//! ```json
//! {
//!   "cookies": [{ "name": "sid", "value": "…", "domain": ".example.com", "hostOnly": false,
//!                 "path": "/", "expires": 1767225600, "httpOnly": true, "secure": true,
//!                 "sameSite": "Lax" }],
//!   "origins": [{ "origin": "https://example.com",
//!                 "localStorage": [{ "name": "k", "value": "v" }] }]
//! }
//! ```
//!
//! An origin's storage is reached from a page of that origin, so each origin gets one for
//! a moment: a hidden page that is no tab, which is answered here with an empty document
//! instead of by the site. Nothing is asked of the site, and nobody in the session sees
//! the page.
//!
//! Of what a page may store, local storage is what is carried. A state that holds more,
//! as earlier versions exported it (IndexedDB, caches, private files, storage partitioned
//! by the site it is embedded in), is refused rather than taken in part.

use std::time::Duration;

use anyhow::{Context, bail, ensure};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::time::{Instant, sleep};
use url::Url;

use crate::{
    cdp::{self, Events},
    targets::Target,
};

const MAX_COOKIES: usize = 10_000;
const MAX_ORIGINS: usize = 100;
/// How long an origin's page gets to be there.
const PAGE_WITHIN: Duration = Duration::from_secs(10);
const POLL: Duration = Duration::from_millis(25);

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct State {
    pub cookies: Vec<Cookie>,
    pub origins: Vec<Origin>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Cookie {
    pub name: String,
    pub value: String,
    pub domain: String,
    /// It goes to this host alone, not to the hosts below it.
    #[serde(default)]
    pub host_only: bool,
    pub path: String,
    /// Seconds since the epoch; a cookie without it ends with the browser.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires: Option<f64>,
    #[serde(default)]
    pub http_only: bool,
    #[serde(default)]
    pub secure: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub same_site: Option<String>,
    /// For a cookie that is kept apart for the site it was set under.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub partition_key: Option<Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Origin {
    pub origin: String,
    pub local_storage: Vec<Entry>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    ancestor_origins: Vec<Value>,
    #[serde(rename = "indexedDB", skip_serializing_if = "Vec::is_empty")]
    indexed_db: Vec<Value>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    cache_storage: Vec<Value>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    opfs: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub name: String,
    pub value: String,
}

/// What an export takes.
#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Asked {
    pub origins: Origins,
    pub cookies: Cookies,
}

#[derive(Debug, Default, Deserialize)]
#[serde(untagged)]
pub enum Origins {
    /// `"open-tabs"`: the origins of the pages the session's tabs show.
    #[default]
    #[serde(deserialize_with = "open_tabs")]
    OpenTabs,
    Named(Vec<String>),
}

fn open_tabs<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<(), D::Error> {
    match String::deserialize(deserializer)?.as_str() {
        "open-tabs" => Ok(()),
        other => Err(serde::de::Error::custom(format!(
            "{other:?} is neither \"open-tabs\" nor a list of origins"
        ))),
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Cookies {
    /// Those the browser would send to one of the origins.
    #[default]
    Matching,
    All,
}

impl State {
    /// Says what of the state is not one that is put into a session.
    pub fn check(&self) -> Result<(), String> {
        if self.cookies.len() > MAX_COOKIES {
            return Err(format!("at most {MAX_COOKIES} cookies are taken"));
        }
        if self.origins.len() > MAX_ORIGINS {
            return Err(format!("at most {MAX_ORIGINS} origins are taken"));
        }
        for (index, origin) in self.origins.iter().enumerate() {
            let said = |what: &str| format!("origins[{index}]: {what}");
            origin_of(&origin.origin).map_err(|err| said(&err))?;
            let more = [
                ("ancestorOrigins", &origin.ancestor_origins),
                ("indexedDB", &origin.indexed_db),
                ("cacheStorage", &origin.cache_storage),
                ("opfs", &origin.opfs),
            ];
            if let Some((name, _)) = more.into_iter().find(|(_, held)| !held.is_empty()) {
                return Err(said(&format!("{name} is not carried between sessions")));
            }
        }
        for (index, cookie) in self.cookies.iter().enumerate() {
            if cookie.name.is_empty() && cookie.value.is_empty() || cookie.domain.is_empty() {
                return Err(format!(
                    "cookies[{index}]: a cookie has a name and a domain"
                ));
            }
        }
        Ok(())
    }
}

/// The origin as the browser writes it; what is wrong with one that is none.
fn origin_of(given: &str) -> Result<String, String> {
    let url = Url::parse(given).map_err(|err| format!("{given:?} is not an origin: {err}"))?;
    let web = matches!(url.scheme(), "http" | "https");
    let bare = url.path() == "/" && url.query().is_none() && url.fragment().is_none();
    if !web || !bare || url.host_str().is_none() {
        return Err(format!(
            "{given:?} is not an origin like https://example.com"
        ));
    }
    Ok(url.origin().ascii_serialization())
}

/// Takes the state out of the session's browser.
pub async fn export(
    browser: &cdp::Client,
    targets: &[Target],
    asked: Asked,
) -> anyhow::Result<State> {
    let mut origins: Vec<String> = match asked.origins {
        Origins::OpenTabs => targets
            .iter()
            .filter_map(|target| {
                origin_of(&Url::parse(&target.url).ok()?.origin().ascii_serialization()).ok()
            })
            .collect(),
        Origins::Named(named) => named
            .iter()
            .map(|origin| origin_of(origin).map_err(anyhow::Error::msg))
            .collect::<anyhow::Result<_>>()?,
    };
    origins.sort();
    origins.dedup();
    ensure!(
        origins.len() <= MAX_ORIGINS,
        "at most {MAX_ORIGINS} origins are taken"
    );

    let kept = browser.call("Storage.getCookies", json!({})).await?;
    let kept = kept["cookies"].as_array().cloned().unwrap_or_default();
    let cookies = kept
        .iter()
        .map(cookie_from)
        .collect::<anyhow::Result<Vec<Cookie>>>()?
        .into_iter()
        .filter(|cookie| {
            asked.cookies == Cookies::All || origins.iter().any(|origin| goes_to(cookie, origin))
        })
        .collect();

    let mut stored = Vec::new();
    if !origins.is_empty() {
        let mut page = Aside::open(browser).await?;
        let read = async {
            for origin in &origins {
                page.go(origin).await?;
                let entries = page
                    .evaluate("Object.keys(localStorage).map((name) => [name, localStorage.getItem(name)])")
                    .await?;
                let entries: Vec<(String, String)> =
                    serde_json::from_value(entries).context("local storage is not read")?;
                if entries.is_empty() {
                    continue;
                }
                stored.push(Origin {
                    origin: origin.clone(),
                    local_storage: entries
                        .into_iter()
                        .map(|(name, value)| Entry { name, value })
                        .collect(),
                    ..Default::default()
                });
            }
            anyhow::Ok(())
        }
        .await;
        page.close().await;
        read?;
    }
    Ok(State {
        cookies,
        origins: stored,
    })
}

/// Puts the state into the session's browser: its cookies beside those there are, and
/// each origin's local storage in place of what the origin had.
pub async fn import(browser: &cdp::Client, state: &State) -> anyhow::Result<()> {
    state.check().map_err(anyhow::Error::msg)?;
    if !state.origins.is_empty() {
        let mut page = Aside::open(browser).await?;
        let written = async {
            for origin in &state.origins {
                page.go(&origin_of(&origin.origin).map_err(anyhow::Error::msg)?)
                    .await?;
                let entries: Vec<(&str, &str)> = origin
                    .local_storage
                    .iter()
                    .map(|entry| (entry.name.as_str(), entry.value.as_str()))
                    .collect();
                let entries = serde_json::to_string(&entries)?;
                page.evaluate(&format!(
                    "(() => {{ localStorage.clear(); \
                     for (const [name, value] of {entries}) localStorage.setItem(name, value); }})()"
                ))
                .await
                .with_context(|| format!("{} did not take its storage", origin.origin))?;
            }
            anyhow::Ok(())
        }
        .await;
        page.close().await;
        written?;
    }
    if !state.cookies.is_empty() {
        let cookies: Vec<Value> = state.cookies.iter().map(cookie_into).collect();
        browser
            .call("Storage.setCookies", json!({ "cookies": cookies }))
            .await
            .context("the browser did not take the cookies")?;
    }
    Ok(())
}

/// A cookie as the browser tells it.
fn cookie_from(told: &Value) -> anyhow::Result<Cookie> {
    let text = |name: &str| told[name].as_str().map(str::to_owned);
    let domain = text("domain").context("a cookie has no domain")?;
    Ok(Cookie {
        name: text("name").unwrap_or_default(),
        value: text("value").unwrap_or_default(),
        host_only: !domain.starts_with('.'),
        domain,
        path: text("path").unwrap_or_else(|| "/".to_owned()),
        // The browser says -1 for one that ends with it.
        expires: told["expires"].as_f64().filter(|expires| *expires > 0.0),
        http_only: told["httpOnly"].as_bool().unwrap_or(false),
        secure: told["secure"].as_bool().unwrap_or(false),
        same_site: text("sameSite"),
        partition_key: told
            .get("partitionKey")
            .filter(|key| !key.is_null())
            .cloned(),
    })
}

/// A cookie as the browser takes it.
fn cookie_into(cookie: &Cookie) -> Value {
    let mut given = json!({
        "name": cookie.name,
        "value": cookie.value,
        "path": cookie.path,
        "httpOnly": cookie.http_only,
        "secure": cookie.secure,
    });
    let host = cookie.domain.trim_start_matches('.');
    if cookie.host_only {
        // Given a domain the browser sends it to the hosts below as well.
        let scheme = if cookie.secure { "https" } else { "http" };
        given["url"] = format!("{scheme}://{host}{}", cookie.path).into();
    } else {
        given["domain"] = cookie.domain.clone().into();
    }
    if let Some(expires) = cookie.expires {
        given["expires"] = expires.into();
    }
    if let Some(same_site) = &cookie.same_site {
        given["sameSite"] = same_site.clone().into();
    }
    if let Some(key) = &cookie.partition_key {
        given["partitionKey"] = key.clone();
    }
    given
}

/// Whether the browser would send the cookie to the origin.
fn goes_to(cookie: &Cookie, origin: &str) -> bool {
    let Ok(url) = Url::parse(origin) else {
        return false;
    };
    let host = url.host_str().unwrap_or_default();
    let domain = cookie.domain.trim_start_matches('.');
    let below = host
        .strip_suffix(domain)
        .is_some_and(|rest| rest.ends_with('.'));
    (host == domain || !cookie.host_only && below) && (!cookie.secure || url.scheme() == "https")
}

/// A page beside the session's tabs, for reaching the storage of origins.
struct Aside<'a> {
    browser: &'a cdp::Client,
    target: String,
    session: String,
    events: Events,
}

impl<'a> Aside<'a> {
    async fn open(browser: &'a cdp::Client) -> anyhow::Result<Self> {
        // Before the page is there, so that nothing of it is missed.
        let events = browser.events();
        let created = browser
            .call(
                "Target.createTarget",
                json!({ "url": "about:blank", "hidden": true }),
            )
            .await
            .context("the browser made no page to reach storage from")?;
        let target = created["targetId"]
            .as_str()
            .context("the browser named no page")?
            .to_owned();
        let attached = browser
            .call(
                "Target.attachToTarget",
                json!({ "targetId": target, "flatten": true }),
            )
            .await?;
        let session = attached["sessionId"]
            .as_str()
            .context("the browser attached no session")?
            .to_owned();
        let page = Self {
            browser,
            target,
            session,
            events,
        };
        // Every request of the page is answered here, the page's own included: a worker
        // the site left would answer it otherwise.
        for (method, params) in [
            ("Network.enable", json!({})),
            ("Network.setBypassServiceWorker", json!({ "bypass": true })),
            (
                "Fetch.enable",
                json!({ "patterns": [{ "urlPattern": "*" }] }),
            ),
        ] {
            if let Err(err) = page.call(method, params).await {
                page.close().await;
                return Err(err).context("the page to reach storage from was not set up");
            }
        }
        Ok(page)
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value, cdp::Error> {
        self.browser
            .call_in(Some(&self.session), method, params)
            .await
    }

    /// Takes the page to an empty document of the origin.
    async fn go(&mut self, origin: &str) -> anyhow::Result<()> {
        let navigate = self.browser.call_in(
            Some(&self.session),
            "Page.navigate",
            json!({ "url": format!("{origin}/") }),
        );
        tokio::pin!(navigate);
        let deadline = Instant::now() + PAGE_WITHIN;
        let mut navigated = false;
        loop {
            tokio::select! {
                answered = &mut navigate, if !navigated => {
                    let answered = answered?;
                    if let Some(refused) = answered["errorText"].as_str() {
                        bail!("{origin} was not opened: {refused}");
                    }
                    navigated = true;
                }
                event = self.events.next() => {
                    let event = event.context("the browser is gone")?;
                    let ours = event.session.as_deref() == Some(self.session.as_str());
                    if ours && event.method == "Fetch.requestPaused" {
                        let empty = base64::engine::general_purpose::STANDARD.encode("<!doctype html>");
                        let fulfilled = json!({
                            "requestId": event.params["requestId"],
                            "responseCode": 200,
                            "responseHeaders": [{ "name": "Content-Type", "value": "text/html" }],
                            "body": empty,
                        });
                        self.browser
                            .call_in(Some(&self.session), "Fetch.fulfillRequest", fulfilled)
                            .await?;
                    }
                }
                () = sleep(POLL), if navigated => {
                    // The document of a moment ago may still be the one that answers.
                    let there = self.evaluate("location.origin").await.ok();
                    if there.as_ref().and_then(Value::as_str) == Some(origin) {
                        return Ok(());
                    }
                }
            }
            ensure!(Instant::now() < deadline, "{origin} was not opened in time");
        }
    }

    async fn evaluate(&self, expression: &str) -> anyhow::Result<Value> {
        let evaluated = self
            .call(
                "Runtime.evaluate",
                json!({ "expression": expression, "returnByValue": true }),
            )
            .await?;
        if let Some(thrown) = evaluated.get("exceptionDetails") {
            let said = thrown["exception"]["description"].as_str();
            bail!("{}", said.unwrap_or("the page threw"));
        }
        Ok(evaluated["result"]["value"].clone())
    }

    async fn close(self) {
        let close = json!({ "targetId": self.target });
        // A browser that is gone took the page with it.
        if let Err(err) = self.browser.call("Target.closeTarget", close).await {
            tracing::debug!("the page storage was reached from was not closed: {err}");
        }
    }
}

//! What the session's browser keeps for the sites it visits, taken out of a session and
//! put into another: its cookies, what pages stored for their origins, and the tabs that
//! were open. The form is JSON that an export gives and an import takes:
//!
//! ```json
//! {
//!   "cookies": [{ "name": "sid", "value": "…", "domain": ".example.com", "hostOnly": false,
//!                 "path": "/", "expires": 1767225600, "httpOnly": true, "secure": true,
//!                 "sameSite": "Lax" }],
//!   "origins": [{ "origin": "https://example.com",
//!                 "localStorage": [{ "name": "k", "value": "v" }],
//!                 "indexedDB": [{ "name": "db", "version": 1, "stores": [{
//!                   "name": "kept", "keyPath": "id", "autoIncrement": false,
//!                   "indexes": [{ "name": "by", "keyPath": "by", "unique": false,
//!                                 "multiEntry": false }],
//!                   "records": [{ "key": 1, "value": { "id": 1, "by": "a" } }] }] }],
//!                 "cacheStorage": [{ "name": "v1", "entries": [{
//!                   "url": "https://example.com/app.js", "requestHeaders": {},
//!                   "status": 200, "statusText": "OK",
//!                   "headers": { "content-type": "text/javascript" }, "body": "<base64>" }] }],
//!                 "opfs": [{ "path": "notes/a.txt", "body": "<base64>" }] },
//!               { "origin": "https://widget.example", "ancestorOrigins": ["https://example.com"],
//!                 "localStorage": [] }],
//!   "tabs": [{ "url": "https://example.com/inbox", "active": true,
//!              "sessionStorage": [{ "origin": "https://example.com",
//!                                   "entries": [{ "name": "k", "value": "v" }] }],
//!              "document": { "scroll": { "x": 0, "y": 240 }, "windowName": "inbox" } },
//!            { "url": "https://example.com/compose", "opener": 0 }]
//! }
//! ```
//!
//! A key or a value of a database that JSON does not hold as it is, such as a date or
//! bytes, goes encoded as `keyEncoded` or `valueEncoded`; `stored.js` says how. A tab's
//! `document` is what `document.js` reads and writes.
//!
//! An origin's storage is reached from a page of that origin, so each origin gets one for
//! a moment: a hidden page that is no tab, which is answered here with an empty document
//! instead of by the site. Nothing is asked of the site, and nobody in the session sees
//! the page.
//!
//! Of what a page may store, local storage is what an export carries, and the origin's
//! databases, caches and private files where it is asked for them: many sites keep who is
//! signed in there. A database holding what cannot be written down, such as a key that may
//! not leave the browser, fails the export rather than being taken in part, and so does a
//! cache holding an answer that is not read.
//!
//! What an origin stores while it is embedded in a page of another site is kept apart by
//! the browser from what it stores on its own. An import takes that as well, for an origin
//! that names its `ancestorOrigins`, the top one first: the hidden page is then made of
//! frames, one in another as they were. An export gives the storage of origins on their
//! own alone.
//!
//! Tabs are what an import takes and an export does not give: each is opened beside the
//! tabs there are, with its session storage and its `window.name` there before the page's
//! scripts run, and the rest of its document put back once the page has loaded. One that
//! names an `opener` is opened by that tab's page. The `active` one is opened last where
//! its opener lets it, as the newest tab is what a client is shown first. A tab that shows
//! nothing, as the one a session starts with, is closed once others are opened.

use std::time::Duration;

use anyhow::{Context, bail, ensure};
use base64::Engine as _;
use futures_util::future::join_all;
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
const MAX_TABS: usize = 50;
/// How many frames an origin's storage is reached through at most.
const MAX_ANCESTORS: usize = 8;
/// How long an origin's page gets to be there.
const PAGE_WITHIN: Duration = Duration::from_secs(10);
/// How long an origin's storage gets to be read or written.
const STORED_WITHIN: Duration = Duration::from_secs(60);
/// What an origin's databases, its caches or its files may come to, written down.
const MAX_STORED: usize = 32 * 1024 * 1024;
/// What reads and writes an origin's storage, in a page of the origin.
const STORED: &str = include_str!("stored.js");
/// What reads and writes a tab's document, given what `STORED` evaluates to.
const DOCUMENT: &str = include_str!("document.js");
/// How long a tab's page gets to load before its document is put back as far as it is.
const LOADS_WITHIN: Duration = Duration::from_secs(15);
/// How long a tab's document gets to take what is put back into it.
const WRITES_WITHIN: Duration = Duration::from_secs(15);
/// Where the frames an embedded origin is reached through are, in each origin.
const FRAMES: &str = "/.aperture-state/";
/// What a tab shows that shows nothing.
const EMPTY: [&str; 2] = ["about:blank", "chrome://newtab/"];
const POLL: Duration = Duration::from_millis(25);

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct State {
    pub cookies: Vec<Cookie>,
    pub origins: Vec<Origin>,
    /// The tabs to open, which an import takes and an export does not give.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tabs: Vec<Tab>,
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
    /// The origins of the frames it was embedded in, the top one first, for what it
    /// stores there and not on its own.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub ancestor_origins: Vec<String>,
    /// The origin's databases, see the module's description.
    #[serde(rename = "indexedDB", skip_serializing_if = "Vec::is_empty")]
    pub indexed_db: Vec<Value>,
    /// Its caches, each with the answers it keeps.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub cache_storage: Vec<Value>,
    /// Its private files, each with its path and its bytes.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub opfs: Vec<Value>,
}

/// A tab to open.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Tab {
    pub url: String,
    /// The one a client is shown first.
    pub active: bool,
    /// Which of the tabs opens it, counted from zero: a page that was opened by another
    /// keeps that one as its opener.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opener: Option<usize>,
    /// What its pages kept for as long as the tab lasts, by origin.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub session_storage: Vec<Kept>,
    /// What its document had, see `document.js`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Kept {
    pub origin: String,
    pub entries: Vec<Entry>,
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
    /// The origins' databases as well.
    pub indexed_db: bool,
    /// Their caches as well.
    pub cache_storage: bool,
    /// Their private files as well.
    pub opfs: bool,
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
            if origin.ancestor_origins.len() > MAX_ANCESTORS {
                return Err(said(&format!(
                    "at most {MAX_ANCESTORS} ancestorOrigins are taken"
                )));
            }
            for ancestor in &origin.ancestor_origins {
                origin_of(ancestor).map_err(|err| said(&err))?;
            }
        }
        if self.tabs.len() > MAX_TABS {
            return Err(format!("at most {MAX_TABS} tabs are taken"));
        }
        for (index, tab) in self.tabs.iter().enumerate() {
            let said = |what: &str| format!("tabs[{index}]: {what}");
            let web = Url::parse(&tab.url).is_ok_and(|url| {
                matches!(url.scheme(), "http" | "https") && url.host_str().is_some()
            });
            if !web {
                return Err(said(&format!("{:?} is no page on the web", tab.url)));
            }
            if tab.opener.is_some_and(|opener| opener >= self.tabs.len()) {
                return Err(said("its opener is none of the tabs"));
            }
            for kept in &tab.session_storage {
                origin_of(&kept.origin).map_err(|err| said(&err))?;
            }
            if tab.document.as_ref().is_some_and(|held| !held.is_object()) {
                return Err(said("its document is not an object"));
            }
        }
        if !self.tabs.is_empty() && order(&self.tabs).len() != self.tabs.len() {
            return Err("the tabs open each other around a circle".to_owned());
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
        Origins::OpenTabs => {
            // As the browser says now: what the session knows of a tab's address is a
            // moment behind a page that has just opened.
            let told = browser.call("Target.getTargets", json!({})).await?;
            let told = told["targetInfos"].as_array().cloned().unwrap_or_default();
            targets
                .iter()
                .filter_map(|target| {
                    let now = told
                        .iter()
                        .find(|info| info["targetId"] == target.id.as_str());
                    let url = now
                        .and_then(|info| info["url"].as_str())
                        .unwrap_or(&target.url);
                    origin_of(&Url::parse(url).ok()?.origin().ascii_serialization()).ok()
                })
                .collect()
        }
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
                let which = json!({
                    "indexedDB": asked.indexed_db,
                    "cacheStorage": asked.cache_storage,
                    "opfs": asked.opfs,
                });
                let take = format!("{STORED}.take({which}, {MAX_STORED})");
                let told = page
                    .evaluate_within(&take, STORED_WITHIN)
                    .await
                    .with_context(|| format!("the storage of {origin} is not read"))?;
                let mut taken: Origin = serde_json::from_str(told.as_str().unwrap_or("{}"))
                    .with_context(|| format!("the storage of {origin} is not read"))?;
                let nothing = taken.local_storage.is_empty()
                    && taken.indexed_db.is_empty()
                    && taken.cache_storage.is_empty()
                    && taken.opfs.is_empty();
                if nothing {
                    continue;
                }
                taken.origin = origin.clone();
                stored.push(taken);
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
        tabs: Vec::new(),
    })
}

/// Puts the state into the session's browser: its cookies beside those there are, each
/// origin's local storage in place of what the origin had, each of its databases, caches
/// and files in place of the origin's one of that name, and its tabs beside those that
/// show something.
pub async fn import(browser: &cdp::Client, state: &State) -> anyhow::Result<()> {
    state.check().map_err(anyhow::Error::msg)?;
    let (embedded, alone): (Vec<&Origin>, Vec<&Origin>) = state
        .origins
        .iter()
        .partition(|origin| !origin.ancestor_origins.is_empty());
    if !alone.is_empty() {
        let mut page = Aside::open(browser).await?;
        let written = async {
            for origin in alone {
                page.go(&origin_of(&origin.origin).map_err(anyhow::Error::msg)?)
                    .await?;
                let given = serde_json::to_string(origin)?;
                page.evaluate_within(&format!("{STORED}.put({given})"), STORED_WITHIN)
                    .await
                    .with_context(|| format!("{} did not take its storage", origin.origin))?;
            }
            anyhow::Ok(())
        }
        .await;
        page.close().await;
        written?;
    }
    for origin in embedded {
        // A page of its own each: the frames of one would be those of the next as well.
        let mut page = Aside::open(browser).await?;
        let written = page.put_embedded(origin).await;
        page.close().await;
        written.with_context(|| {
            format!(
                "{} did not take its storage in {}",
                origin.origin,
                origin.ancestor_origins.join(", ")
            )
        })?;
    }
    if !state.cookies.is_empty() {
        let cookies: Vec<Value> = state.cookies.iter().map(cookie_into).collect();
        browser
            .call("Storage.setCookies", json!({ "cookies": cookies }))
            .await
            .context("the browser did not take the cookies")?;
    }
    if !state.tabs.is_empty() {
        open_all(browser, &state.tabs).await?;
    }
    Ok(())
}

/// The order tabs are opened in: one after its opener, and the active one as late as
/// that lets it be. Tabs that open each other around a circle are left out.
fn order(tabs: &[Tab]) -> Vec<usize> {
    let mut order = Vec::with_capacity(tabs.len());
    let mut opened = vec![false; tabs.len()];
    loop {
        let ready = |index: &usize| {
            !opened[*index] && tabs[*index].opener.is_none_or(|opener| opened[opener])
        };
        let next = (0..tabs.len())
            .find(|index| ready(index) && !tabs[*index].active)
            .or_else(|| (0..tabs.len()).find(ready));
        let Some(next) = next else {
            return order;
        };
        opened[next] = true;
        order.push(next);
    }
}

/// A tab that was opened, and the DevTools session its page is attached as.
struct Opened {
    target: String,
    session: String,
}

/// The browser's pages, each with the page that opened it and what it shows.
async fn pages(browser: &cdp::Client) -> anyhow::Result<Vec<(String, Option<String>, String)>> {
    let told = browser.call("Target.getTargets", json!({})).await?;
    let told = told["targetInfos"].as_array().cloned().unwrap_or_default();
    Ok(told
        .iter()
        .filter(|info| info["type"] == "page")
        .filter_map(|info| {
            Some((
                info["targetId"].as_str()?.to_owned(),
                info["openerId"].as_str().map(str::to_owned),
                info["url"].as_str().unwrap_or_default().to_owned(),
            ))
        })
        .collect())
}

async fn open_all(browser: &cdp::Client, tabs: &[Tab]) -> anyhow::Result<()> {
    let empty: Vec<String> = pages(browser)
        .await?
        .into_iter()
        .filter(|(_, _, url)| EMPTY.contains(&url.as_str()))
        .map(|(id, _, _)| id)
        .collect();
    let mut opened: Vec<Option<Opened>> = tabs.iter().map(|_| None).collect();
    let made = async {
        for index in order(tabs) {
            let tab = &tabs[index];
            let opens = tabs.iter().any(|other| other.opener == Some(index));
            let opener = tab.opener.and_then(|opener| opened[opener].as_ref());
            let tab_opened = open_tab(browser, tab, opens, opener)
                .await
                .with_context(|| format!("{} was not opened", tab.url))?;
            if opens {
                // Its page is what opens the others.
                loaded(browser, &tab_opened.session).await;
            }
            opened[index] = Some(tab_opened);
        }
        anyhow::Ok(())
    }
    .await;
    join_all(tabs.iter().zip(&opened).filter_map(|(tab, opened)| {
        let opened = opened.as_ref()?;
        Some(async move {
            loaded(browser, &opened.session).await;
            let Some(document) = &tab.document else {
                return;
            };
            let url = Value::from(tab.url.as_str());
            let write = format!("({DOCUMENT})({STORED}).write({document}, {url})");
            let written = evaluate_within(browser, &opened.session, &write, WRITES_WITHIN);
            // The tab is there with its page, which is most of it.
            if let Err(err) = written.await {
                tracing::warn!(tab = %tab.url, "a tab's document was not put back: {err:#}");
            }
        })
    }))
    .await;
    // What was added to its pages for their start goes with the session.
    for (index, opened) in opened.iter().enumerate() {
        let Some(opened) = opened else {
            continue;
        };
        if tabs.iter().any(|other| other.opener == Some(index)) {
            let forget = format!("({DOCUMENT})(null).forget()");
            // A page that is gone kept nothing.
            let _ = evaluate(browser, &opened.session, &forget).await;
        }
        let detach = json!({ "sessionId": opened.session });
        if let Err(err) = browser.call("Target.detachFromTarget", detach).await {
            tracing::debug!(tab = %opened.target, "a tab was not let go: {err}");
        }
    }
    made?;
    for target in empty {
        // One that is gone meanwhile was closed by someone.
        let close = json!({ "targetId": target });
        if let Err(err) = browser.call("Target.closeTarget", close).await {
            tracing::debug!("an empty tab was not closed: {err}");
        }
    }
    Ok(())
}

/// Opens a tab and sends it to its page, with what the page finds as it starts.
async fn open_tab(
    browser: &cdp::Client,
    tab: &Tab,
    opens: bool,
    opener: Option<&Opened>,
) -> anyhow::Result<Opened> {
    let target = match opener {
        None => {
            let made = browser
                .call("Target.createTarget", json!({ "url": "about:blank" }))
                .await?;
            made["targetId"]
                .as_str()
                .context("the browser named no tab")?
                .to_owned()
        }
        Some(opener) => {
            let before = pages(browser).await?;
            let open = json!({
                "expression": format!("({DOCUMENT})(null).open()"),
                "returnByValue": true,
                // A page opens another when someone asked it to.
                "userGesture": true,
            });
            let asked = browser
                .call_in(Some(&opener.session), "Runtime.evaluate", open)
                .await?;
            ensure!(
                asked["result"]["value"] == true,
                "its opener was not let open it"
            );
            let deadline = Instant::now() + PAGE_WITHIN;
            loop {
                let new = pages(browser).await?.into_iter().find(|(id, by, _)| {
                    by.as_deref() == Some(opener.target.as_str())
                        && !before.iter().any(|(known, _, _)| known == id)
                });
                if let Some((id, _, _)) = new {
                    break id;
                }
                ensure!(
                    Instant::now() < deadline,
                    "its opener opened nothing in time"
                );
                sleep(POLL).await;
            }
        }
    };
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
    let early = json!({
        "url": tab.url,
        "windowName": tab.document.as_ref().and_then(|held| held.get("windowName")),
        "sessionStorage": tab.session_storage,
        "opens": opens,
    });
    browser
        .call_in(Some(&session), "Page.enable", json!({}))
        .await?;
    browser
        .call_in(
            Some(&session),
            "Page.addScriptToEvaluateOnNewDocument",
            json!({ "source": format!("({DOCUMENT})(null).early({early})") }),
        )
        .await?;
    let gone = browser
        .call_in(Some(&session), "Page.navigate", json!({ "url": tab.url }))
        .await?;
    if let Some(refused) = gone["errorText"].as_str() {
        // The tab stays, saying what is wrong as a tab does.
        tracing::warn!(tab = %tab.url, "a tab did not reach its page: {refused}");
    }
    Ok(Opened { target, session })
}

/// Waits for the page of a tab that was sent somewhere to have loaded, for as long as
/// that is worth waiting for.
async fn loaded(browser: &cdp::Client, session: &str) {
    let deadline = Instant::now() + LOADS_WITHIN;
    let there = "document.readyState === 'complete' && location.href !== 'about:blank'";
    while Instant::now() < deadline {
        match evaluate(browser, session, there).await {
            Ok(Value::Bool(true)) => return,
            // A document that is being left answers nothing; the next one will.
            Ok(_) | Err(_) => sleep(POLL).await,
        }
    }
}

/// Evaluates what may take a page a while, such as what waits for its storage.
async fn evaluate_within(
    browser: &cdp::Client,
    session: &str,
    expression: &str,
    within: Duration,
) -> anyhow::Result<Value> {
    tokio::time::timeout(within, evaluate(browser, session, expression))
        .await
        .context("the page did not answer in time")?
}

async fn evaluate(browser: &cdp::Client, session: &str, expression: &str) -> anyhow::Result<Value> {
    let evaluated = browser
        .call_in(
            Some(session),
            "Runtime.evaluate",
            json!({ "expression": expression, "returnByValue": true, "awaitPromise": true }),
        )
        .await?;
    if let Some(thrown) = evaluated.get("exceptionDetails") {
        // The first line says what; the rest is where in the page's script.
        let said = thrown["exception"]["description"].as_str();
        let said = said.and_then(|said| said.lines().next());
        bail!("{}", said.unwrap_or("the page threw"));
    }
    Ok(evaluated["result"]["value"].clone())
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

    /// Puts what an origin stores while it is embedded into the browser: the page becomes
    /// its top ancestor's, each frame holds the next, and the innermost is the origin's,
    /// whose document writes the storage and says how that went.
    async fn put_embedded(&mut self, origin: &Origin) -> anyhow::Result<()> {
        let mut chain = Vec::new();
        for one in origin.ancestor_origins.iter().chain([&origin.origin]) {
            chain.push(origin_of(one).map_err(anyhow::Error::msg)?);
        }
        // A frame of another site is a target of its own, which is held until what it
        // asks for is answered here as well.
        let follow = json!({ "autoAttach": true, "waitForDebuggerOnStart": true, "flatten": true });
        self.call("Target.setAutoAttach", follow.clone()).await?;
        // A `<` in what is written would end the script it is written in.
        let given = serde_json::to_string(origin)?.replace('<', "\\u003c");
        let writing = format!(
            "<!doctype html><script>(async () => {{ let failed = ''; \
             try {{ await {STORED}.put({given}); }} \
             catch (error) {{ failed = String(error?.message ?? error) || 'it failed'; }} \
             await fetch('{FRAMES}done?failed=' + encodeURIComponent(failed)); }})()</script>"
        );
        let empty = |code: u16, body: &str| {
            json!({
                "responseCode": code,
                "responseHeaders": [{ "name": "Content-Type", "value": "text/html" }],
                "body": base64::engine::general_purpose::STANDARD.encode(body),
            })
        };
        let mut sessions = vec![self.session.clone()];
        let navigate = self.browser.call_in(
            Some(&self.session),
            "Page.navigate",
            json!({ "url": format!("{}{FRAMES}0", chain[0]) }),
        );
        tokio::pin!(navigate);
        let deadline = Instant::now() + PAGE_WITHIN + STORED_WITHIN;
        let mut navigated = false;
        loop {
            tokio::select! {
                answered = &mut navigate, if !navigated => {
                    let answered = answered?;
                    if let Some(refused) = answered["errorText"].as_str() {
                        bail!("{} was not opened: {refused}", chain[0]);
                    }
                    navigated = true;
                }
                event = self.events.next() => {
                    let event = event.context("the browser is gone")?;
                    let Some(from) = event.session.as_deref() else {
                        continue;
                    };
                    if !sessions.iter().any(|ours| ours == from) {
                        continue;
                    }
                    if event.method == "Target.attachedToTarget" {
                        let Some(child) = event.params["sessionId"].as_str() else {
                            continue;
                        };
                        if event.params["targetInfo"]["type"] == "iframe" {
                            sessions.push(child.to_owned());
                            for (method, params) in [
                                ("Network.setBypassServiceWorker", json!({ "bypass": true })),
                                ("Fetch.enable", json!({ "patterns": [{ "urlPattern": "*" }] })),
                                ("Target.setAutoAttach", follow.clone()),
                            ] {
                                self.browser.call_in(Some(child), method, params).await?;
                            }
                        }
                        self.browser
                            .call_in(Some(child), "Runtime.runIfWaitingForDebugger", json!({}))
                            .await?;
                    } else if event.method == "Fetch.requestPaused" {
                        let url = event.params["request"]["url"].as_str().unwrap_or_default();
                        let url = Url::parse(url).ok();
                        let asked = url.as_ref().and_then(|url| url.path().strip_prefix(FRAMES));
                        let said = url.as_ref().and_then(|url| {
                            let mut query = url.query_pairs();
                            query.find(|(name, _)| name == "failed").map(|(_, said)| said.into_owned())
                        });
                        let level = asked.and_then(|asked| asked.parse::<usize>().ok());
                        let mut fulfilled = match level {
                            Some(level) if level + 1 == chain.len() => empty(200, &writing),
                            Some(level) if level + 1 < chain.len() => empty(200, &format!(
                                "<!doctype html><iframe src=\"{}{FRAMES}{}\"></iframe>",
                                chain[level + 1],
                                level + 1
                            )),
                            _ if asked == Some("done") => empty(200, ""),
                            _ => empty(404, ""),
                        };
                        fulfilled["requestId"] = event.params["requestId"].clone();
                        self.browser
                            .call_in(Some(from), "Fetch.fulfillRequest", fulfilled)
                            .await?;
                        if asked == Some("done") {
                            return match said.as_deref() {
                                Some("") => Ok(()),
                                said => bail!("{}", said.unwrap_or("it did not say how it went")),
                            };
                        }
                    }
                }
                () = sleep(POLL) => {}
            }
            ensure!(
                Instant::now() < deadline,
                "its frames did not answer in time"
            );
        }
    }

    /// Evaluates what may take the page a while, such as what waits for its storage.
    async fn evaluate_within(&self, expression: &str, within: Duration) -> anyhow::Result<Value> {
        evaluate_within(self.browser, &self.session, expression, within).await
    }

    async fn evaluate(&self, expression: &str) -> anyhow::Result<Value> {
        evaluate(self.browser, &self.session, expression).await
    }

    async fn close(self) {
        let close = json!({ "targetId": self.target });
        // A browser that is gone took the page with it.
        if let Err(err) = self.browser.call("Target.closeTarget", close).await {
            tracing::debug!("the page storage was reached from was not closed: {err}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tab(opener: Option<usize>, active: bool) -> Tab {
        Tab {
            url: "https://example.com/".to_owned(),
            active,
            opener,
            ..Default::default()
        }
    }

    fn state(tabs: Vec<Tab>) -> State {
        State {
            tabs,
            ..Default::default()
        }
    }

    #[test]
    fn a_tab_is_opened_after_the_one_that_opens_it() {
        let tabs = [tab(Some(2), false), tab(None, false), tab(Some(1), false)];
        assert_eq!(order(&tabs), [1, 2, 0]);
    }

    #[test]
    fn the_active_tab_is_opened_last_where_nothing_waits_for_it() {
        let tabs = [tab(None, true), tab(None, false), tab(None, false)];
        assert_eq!(order(&tabs), [1, 2, 0]);
        // What it opens comes after it all the same.
        let tabs = [tab(None, true), tab(Some(0), false), tab(None, false)];
        assert_eq!(order(&tabs), [2, 0, 1]);
    }

    #[test]
    fn tabs_that_open_each_other_are_refused() {
        let around = state(vec![tab(Some(1), false), tab(Some(0), false)]);
        assert!(around.check().unwrap_err().contains("circle"));
        let itself = state(vec![tab(Some(0), false)]);
        assert!(itself.check().is_err());
        let nobody = state(vec![tab(Some(4), false)]);
        assert!(nobody.check().unwrap_err().contains("opener"));
    }

    #[test]
    fn a_tab_is_a_page_on_the_web() {
        let mut blank = tab(None, false);
        blank.url = "about:blank".to_owned();
        assert!(state(vec![blank]).check().is_err());
        assert!(state(vec![tab(None, false)]).check().is_ok());
    }

    #[test]
    fn an_origin_names_the_frames_it_is_embedded_in_as_origins() {
        let embedded = |ancestor: &str| State {
            origins: vec![Origin {
                origin: "https://widget.example".to_owned(),
                ancestor_origins: vec![ancestor.to_owned()],
                ..Default::default()
            }],
            ..Default::default()
        };
        assert!(embedded("https://example.com").check().is_ok());
        assert!(embedded("https://example.com/page").check().is_err());
    }

    #[test]
    fn a_state_of_before_tabs_is_read_as_it_was() {
        let state: State = serde_json::from_str(
            r#"{ "cookies": [], "origins": [{ "origin": "https://example.com",
                 "localStorage": [{ "name": "k", "value": "v" }] }] }"#,
        )
        .unwrap();
        assert!(state.tabs.is_empty());
        assert!(!serde_json::to_string(&state).unwrap().contains("tabs"));
    }
}

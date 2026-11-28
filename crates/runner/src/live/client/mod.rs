//! One client of the session: the session socket it speaks the live protocol on, the
//! target it watches, and the way that target's pixels reach it.

mod picture;
mod tell;

use std::{
    collections::{BTreeSet, HashMap, HashSet},
    time::{Duration, Instant},
};

use anyhow::{Context as _, bail, ensure};
use aperture_compositor::{Button, Cursor, Form, Forms, Input, WindowId, data};
use aperture_runner::{Access, Area};
use axum::extract::ws::{Message as Frame, WebSocket};
use buffa::Message as _;
use tokio::sync::{broadcast, mpsc, watch};
use tracing::{debug, warn};

use self::picture::format_from;
use super::{
    adapt::Delivery,
    encode::{Format, Quality},
    encoders,
    http::Live,
    rtc::{self, FromPeer},
    sound,
    stream::{Key, Subscription},
    tiles,
};
use crate::{
    files::{self, Download},
    pace::Pace,
    pages::{self, Along, History},
    presence::{Identity, Mark, Membership, Phase, Present, Shown},
    proto::aperture::live::v1::{self as pb, client_message, server_message},
    restore::Restore,
    targets::{Like, Mode, Target},
};

/// What a client may do in one area.
#[derive(Clone, Copy)]
struct Grant {
    read: bool,
    write: bool,
}

/// Why a client that may not do what it asked for is told it was not done.
const NOT_ALLOWED: &str = "the session does not let this client do it";

/// Why a client that is let see one tab alone is told it was not taken to another.
const ONE_TAB: &str = "this client is let see one tab alone";

/// How often the others are told where a client's pointer is, and how many points of
/// its strokes they are shown in a second.
const POINTED_EVERY: Duration = Duration::from_millis(40);
const DRAWN_A_SECOND: u32 = 120;

/// How often a client's socket is pinged, and how long one that says nothing is kept. A
/// socket that carries no picture is silent for as long as nothing changes, and what
/// stands between the client and the session closes a silent one, or keeps one whose
/// client is long gone.
const PINGED_EVERY: Duration = Duration::from_secs(15);
const SILENT_FOR: Duration = Duration::from_secs(50);

/// What a client's WebRTC connection has to tell that waits for its session socket's turn.
const CHANNEL_MESSAGES: usize = 256;

/// Serves the client until its socket closes or the session ends.
pub async fn serve(live: Live, socket: WebSocket, identity: Identity) {
    let access = identity.access;
    let only = identity.tab;
    let (tiles_watch, tiles) = tiles::start(live.compositor.clone());
    let (from_peer, peer_events) = mpsc::channel(CHANNEL_MESSAGES);
    let mut client = Client {
        cursor: live.compositor.cursor(),
        clipboard: live.compositor.clipboard(),
        pace: live.pace.watch(),
        restore: live.restore.watch(),
        upload_most: live.uploads.watch_most(),
        downloads: live.downloads.clone(),
        file_requests: live.pages.requests(),
        menus: live.pages.menus(),
        present: live.presence.present(),
        marks: live.presence.marks(),
        pointed: Instant::now(),
        drawn: (Instant::now(), 0),
        sounding: live.sound.sounding(),
        sound: None,
        access,
        only,
        member: live.presence.join(identity, false),
        history: live.pages.history(),
        live,
        socket,
        phone: false,
        greeted: false,
        json: false,
        pixels: pb::Pixels::PIXELS_UNSPECIFIED,
        selected: None,
        opened: None,
        known: HashSet::new(),
        video: None,
        pinned: None,
        fps: None,
        formats: Vec::new(),
        format: Format::H264,
        frames: None,
        next_frames: None,
        delivery: Delivery::new(),
        awaits_keyframe: false,
        tiles_watch,
        from_peer,
    };
    if let Err(err) = client.run(tiles, peer_events).await {
        debug!(%err, "a client's session socket failed");
    }
}

struct Client {
    live: Live,
    cursor: watch::Receiver<Cursor>,
    /// What the session copied; the client is told what is copied from now on.
    clipboard: watch::Receiver<Option<Forms>>,
    pace: watch::Receiver<Pace>,
    /// Whether the session is being given what its browser starts with.
    restore: watch::Receiver<Restore>,
    /// The largest file that is put into the session.
    upload_most: watch::Receiver<Option<u64>>,
    downloads: watch::Receiver<Vec<Download>>,
    file_requests: watch::Receiver<Vec<pages::Request>>,
    menus: broadcast::Receiver<pages::Menu>,
    present: watch::Receiver<Present>,
    /// What the members show each other.
    marks: broadcast::Receiver<Mark>,
    /// When the others were last told where the client's pointer is.
    pointed: Instant,
    /// Since when the points of the client's strokes are counted, and how many came.
    drawn: (Instant, u32),
    /// What the client may do, as whoever let it in says.
    access: Access,
    /// The one tab the client sees, as whoever let it in says: it is told of no other, and
    /// is taken to none. Every tab, without.
    only: Option<u32>,
    /// The session's sound, for a client that takes it on the socket.
    sound: Option<sound::Listener>,
    /// The browser's tabs that play something now.
    sounding: watch::Receiver<BTreeSet<i64>>,
    /// The client as one of those in the session.
    member: Membership,
    socket: WebSocket,
    /// The client is used from a phone, as it says.
    phone: bool,
    /// The client said hello.
    greeted: bool,
    /// The client's last message came as JSON text.
    json: bool,
    pixels: pb::Pixels,
    /// The target the client watches, and the window that shows the target.
    selected: Option<(String, WindowId)>,
    /// The page of a tab the client opened and does not watch yet.
    opened: Option<String>,
    /// The targets there were when the watched one was last settled.
    known: HashSet<String>,
    /// Which ways the history of each target's page goes.
    history: watch::Receiver<HashMap<String, History>>,
    /// The client's WebRTC connection, which lives as long as this does.
    video: Option<rtc::Watch>,
    /// The quality the client asked for, whatever its link carries.
    pinned: Option<Quality>,
    /// The most frames a second the client asked for.
    fps: Option<u32>,
    /// The forms of video the client would have that are made here, the one it would
    /// rather have first.
    formats: Vec<Format>,
    /// The form of the frames the client takes.
    format: Format,
    /// The watched target's video, for a client that takes it as frames.
    frames: Option<Subscription>,
    /// The stream of another quality that replaces `frames` once it has a keyframe.
    next_frames: Option<Subscription>,
    /// What became of the frames sent.
    delivery: Delivery,
    /// Frames were missed or held back, and those that follow build on them: none is sent
    /// before the next keyframe.
    awaits_keyframe: bool,
    tiles_watch: watch::Sender<tiles::Watched>,
    from_peer: mpsc::Sender<FromPeer>,
}

impl Client {
    async fn run(
        &mut self,
        mut tiles: mpsc::Receiver<pb::Tile>,
        mut peer_events: mpsc::Receiver<FromPeer>,
    ) -> Result<(), axum::Error> {
        let mut ping = tokio::time::interval(PINGED_EVERY);
        let mut said = Instant::now();
        loop {
            let heard = self.heard();
            tokio::select! {
                frame = self.socket.recv() => match frame {
                    Some(Ok(Frame::Close(_))) | None => return Ok(()),
                    Some(Ok(frame)) => {
                        said = Instant::now();
                        self.read(frame).await?;
                    }
                    Some(Err(err)) => return Err(err),
                },
                _ = ping.tick() => {
                    if said.elapsed() > SILENT_FOR {
                        debug!("a client that says nothing is gone");
                        return Ok(());
                    }
                    self.socket.send(Frame::Ping(Default::default())).await?;
                }
                Some(event) = peer_events.recv() => match event {
                    FromPeer::Message(message) => self.handle(message).await?,
                    FromPeer::Stream(key) => self.send_status(key).await?,
                },
                Some(tile) = tiles.recv() => {
                    self.send(server_message::Message::Tile(Box::new(tile))).await?;
                }
                packet = rtc::next_packet(&mut self.frames) => match packet {
                    Ok(packet) => self.send_frame(&packet).await?,
                    Err(broadcast::error::RecvError::Lagged(_)) => self.request_keyframe(),
                    // The window closed; the targets say what the client watches next.
                    Err(broadcast::error::RecvError::Closed) => self.frames = None,
                },
                packet = rtc::next_packet(&mut self.next_frames) => match packet {
                    Ok(packet) if packet.keyframe => {
                        self.frames = self.next_frames.take();
                        self.awaits_keyframe = false;
                        if let Some(frames) = &self.frames {
                            self.send_status(frames.key).await?;
                        }
                        self.send_frame(&packet).await?;
                    }
                    Ok(_) => {}
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        if let Some(next) = &self.next_frames {
                            next.keyframe();
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => self.next_frames = None,
                },
                packet = sound::next(&mut self.sound, heard) => match packet {
                    Ok(packet) => self.send_sound(&packet).await?,
                    // What was missed is not played late.
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => self.sound = None,
                },
                menu = self.menus.recv() => match menu {
                    Ok(menu) => self.send_menu(menu).await?,
                    // A menu that was missed is asked for again with another click.
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => return Ok(()),
                },
                // What ends with the session ends the client.
                changed = self.live.targets.changed() => {
                    if changed.is_err() {
                        return Ok(());
                    }
                    self.send_targets().await?;
                    // A client watches nothing before its hello says which tab it would.
                    if self.greeted && self.select(None).await? {
                        self.send_selected().await?;
                    }
                }
                changed = self.history.changed() => {
                    if changed.is_err() {
                        return Ok(());
                    }
                    self.send_targets().await?;
                }
                changed = self.sounding.changed() => {
                    if changed.is_err() {
                        return Ok(());
                    }
                    self.send_targets().await?;
                }
                changed = self.cursor.changed() => {
                    if changed.is_err() {
                        return Ok(());
                    }
                    self.send_cursor().await?;
                }
                changed = self.present.changed() => {
                    if changed.is_err() {
                        return Ok(());
                    }
                    self.send_presence().await?;
                    self.drive();
                    self.keep_up().await?;
                }
                mark = self.marks.recv() => match mark {
                    Ok(mark) => self.send_mark(mark).await?,
                    // What was missed is not shown late.
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => return Ok(()),
                },
                changed = self.file_requests.changed() => {
                    if changed.is_err() {
                        return Ok(());
                    }
                    self.send_file_requests().await?;
                }
                changed = self.downloads.changed() => {
                    if changed.is_err() {
                        return Ok(());
                    }
                    self.send_downloads().await?;
                }
                changed = self.clipboard.changed() => {
                    if changed.is_err() {
                        return Ok(());
                    }
                    self.send_copied().await?;
                }
                changed = self.pace.changed() => {
                    if changed.is_err() {
                        return Ok(());
                    }
                    self.send_pace().await?;
                }
                changed = self.restore.changed(), if self.greeted => {
                    if changed.is_err() {
                        return Ok(());
                    }
                    self.send_restore().await?;
                }
                changed = self.upload_most.changed(), if self.greeted => {
                    if changed.is_err() {
                        return Ok(());
                    }
                    self.send_features().await?;
                }
            }
        }
    }

    /// Takes a frame of the session socket: a message, in the encoding the client reads
    /// the answers in.
    async fn read(&mut self, frame: Frame) -> Result<(), axum::Error> {
        let (envelope, json) = match frame {
            Frame::Binary(data) => (
                pb::ClientMessage::decode_from_slice(&data).map_err(|err| err.to_string()),
                false,
            ),
            Frame::Text(text) => (
                serde_json::from_str::<pb::ClientMessage>(&text).map_err(|err| err.to_string()),
                true,
            ),
            Frame::Ping(_) | Frame::Pong(_) | Frame::Close(_) => return Ok(()),
        };
        match envelope.map(|envelope| envelope.message) {
            Ok(Some(message)) => {
                self.json = json;
                self.handle(message).await
            }
            Ok(None) => Ok(()),
            Err(reason) => {
                warn!(%reason, "malformed client message");
                Ok(())
            }
        }
    }

    async fn handle(&mut self, message: client_message::Message) -> Result<(), axum::Error> {
        use client_message::Message;
        match message {
            Message::Hello(hello) => self.greet(&hello).await,
            Message::Select(select) => {
                // Whoever goes somewhere itself follows nobody there.
                if let Err(reason) = self.live.presence.follow(self.member.id, None) {
                    debug!(reason, "a client still follows");
                }
                if self.select(Some(select.tab)).await? {
                    self.send_selected().await?;
                }
                Ok(())
            }
            Message::Lease(lease) => {
                self.lease(lease.action.as_known());
                Ok(())
            }
            Message::Viewport(viewport) => {
                self.resize(&viewport);
                Ok(())
            }
            Message::Device(device) => {
                self.phone = device.phone;
                self.drive();
                Ok(())
            }
            Message::SetMode(set) => {
                let set = self.set_mode(set.mode.as_known());
                self.answer(pb::Asked::ASKED_SET_MODE, set).await
            }
            Message::RtcOffer(offer) => self.connect_video(&offer.sdp).await,
            Message::VideoShown(shown) => match self.delivery.shown(shown.time_us) {
                Some(quality) => self.take_quality(quality).await,
                None => Ok(()),
            },
            Message::Clipboard(content) => {
                if self.grant(Area::Clipboard).write
                    && let Some(content) = self.content(*content)
                    && self.holds()
                {
                    self.live.compositor.set_clipboard(content);
                }
                Ok(())
            }
            Message::Go(go) => {
                let gone = match self.restored() {
                    Ok(()) => self.go(*go).await,
                    Err(held) => Err(held),
                };
                self.answer(pb::Asked::ASKED_GO, gone).await?;
                // A tab the client opened may be there already.
                if self.select(None).await? {
                    self.send_selected().await?;
                }
                Ok(())
            }
            Message::Close(close) => {
                let closed = match self.restored() {
                    Ok(()) => self.close(close.tab).await,
                    Err(held) => Err(held),
                };
                self.answer(pb::Asked::ASKED_CLOSE, closed).await
            }
            Message::CopyPicture(picture) => match self.picture(&picture.url).await {
                Ok(picture) => {
                    self.send(server_message::Message::Clipboard(Box::new(picture)))
                        .await
                }
                Err(err) => self.answer(pb::Asked::ASKED_COPY_PICTURE, Err(err)).await,
            },
            Message::Follow(follow) => {
                // Whom it follows goes to other tabs.
                let followed = match self.only {
                    Some(_) => Err(anyhow::anyhow!(ONE_TAB)),
                    None => self
                        .live
                        .presence
                        .follow(self.member.id, follow.member)
                        .map_err(anyhow::Error::msg),
                };
                self.answer(pb::Asked::ASKED_FOLLOW, followed).await?;
                self.keep_up().await
            }
            Message::Draw(draw) => {
                self.draw(&draw);
                Ok(())
            }
            Message::Pointing(pointing) => {
                self.point(pointing.at.as_option().map(|at| (at.x, at.y)));
                Ok(())
            }
            Message::FilesChosen(chosen) => {
                let answered = self.choose_files(&chosen).await;
                self.answer(pb::Asked::ASKED_FILES_CHOSEN, answered).await
            }
            Message::PointerMotion(_)
            | Message::PointerButton(_)
            | Message::PointerScroll(_)
            | Message::PointerLeave(_)
            | Message::Key(_)
            | Message::Text(_)
            | Message::Drop(_) => {
                match &message {
                    Message::PointerMotion(motion) => self.point(Some((motion.x, motion.y))),
                    Message::PointerLeave(_) => self.point(None),
                    _ => {}
                }
                // A click on a page that is not yet what it is to be is a wrong click. What
                // was pressed before still comes up: it would stay down otherwise.
                let lets_go = match &message {
                    Message::Key(key) => !key.pressed,
                    Message::PointerButton(button) => !button.pressed,
                    _ => false,
                };
                if lets_go || self.restored().is_ok() {
                    self.input(message);
                }
                Ok(())
            }
        }
    }

    /// Takes how the client would have the session, and tells it all it needs to know of it.
    async fn greet(&mut self, hello: &pb::Hello) -> Result<(), axum::Error> {
        self.greeted = true;
        self.pixels = hello.pixels.as_known().unwrap_or_default();
        self.pinned = match hello.quality.as_known() {
            Some(pb::VideoQuality::VIDEO_QUALITY_LOW) => Some(Quality::Low),
            Some(pb::VideoQuality::VIDEO_QUALITY_MEDIUM) => Some(Quality::Medium),
            Some(pb::VideoQuality::VIDEO_QUALITY_FULL) => Some(Quality::Full),
            Some(pb::VideoQuality::VIDEO_QUALITY_UNSPECIFIED) | None => None,
        };
        self.delivery.pin(self.pinned);
        let hears = hello.audio && self.grant(Area::Sound).read;
        self.sound = hears.then(|| self.live.sound.listen());
        self.fps = hello
            .fps
            .map(|fps| fps.clamp(*Key::FPS.start(), *Key::FPS.end()));
        let wanted: Vec<Format> = hello
            .formats
            .iter()
            .filter_map(|format| format_from(format.as_known()?))
            .collect();
        // Finding out what encodes here takes a moment the first time.
        let made = tokio::task::spawn_blocking(move || {
            wanted
                .into_iter()
                .filter(|format| encoders::encodes(*format))
                .collect()
        });
        self.formats = made.await.map_err(axum::Error::new)?;
        self.format = self.formats.first().copied().unwrap_or(Format::H264);
        self.send_features().await?;
        self.send_pace().await?;
        self.send_restore().await?;
        self.send_targets().await?;
        self.send_cursor().await?;
        self.send_downloads().await?;
        self.send_file_requests().await?;
        self.send_presence().await?;
        // The tab asked for is the one to start with, and no more: a hello that comes again
        // finds the client watching one.
        let first = hello.tab.filter(|_| self.selected.is_none());
        if !self.select(first).await? {
            self.show().await?;
        }
        self.send_selected().await
    }

    fn lease(&self, action: Option<pb::LeaseAction>) {
        let Some(tab) = self.tab() else {
            return;
        };
        let (presence, id) = (&self.live.presence, self.member.id);
        match action {
            Some(pb::LeaseAction::LEASE_ACTION_TAKE) => presence.ask(id, tab),
            Some(pb::LeaseAction::LEASE_ACTION_RELEASE) => presence.release(id, tab),
            Some(pb::LeaseAction::LEASE_ACTION_ALLOW) => presence.answer(id, tab, true),
            Some(pb::LeaseAction::LEASE_ACTION_KEEP) => presence.answer(id, tab, false),
            Some(pb::LeaseAction::LEASE_ACTION_UNSPECIFIED) | None => {}
        }
    }

    /// Gives the watched target another size, for a client that holds its tab.
    fn resize(&self, viewport: &pb::Viewport) {
        if let Some((target, _)) = &self.selected
            && self.grant(Area::Tabs).write
            && self.holds()
        {
            let tabs = &self.live.tabs;
            tabs.resize(target, viewport.width, viewport.height, viewport.scale);
        }
    }

    /// Has the tab the client holds shown as on what the client is used from, where the
    /// tab goes by its holder. Watching a tab holds nothing, and changes nothing.
    fn drive(&self) {
        if let Some((target, _)) = &self.selected
            && self.grant(Area::Tabs).write
            && self.leads()
        {
            self.live.tabs.drive(target, self.phone);
        }
    }

    /// Sets how the watched tab's pages are shown, for a client that holds the tab.
    fn set_mode(&self, mode: Option<pb::PageMode>) -> anyhow::Result<()> {
        ensure!(self.grant(Area::Tabs).write, NOT_ALLOWED);
        let mode = match mode {
            Some(pb::PageMode::PAGE_MODE_AUTO) => Mode::Auto,
            Some(pb::PageMode::PAGE_MODE_DESKTOP) => Mode::Desktop,
            Some(pb::PageMode::PAGE_MODE_MOBILE) => Mode::Mobile,
            Some(pb::PageMode::PAGE_MODE_UNSPECIFIED) | None => bail!("no mode was named"),
        };
        let target = self.held()?;
        let tabs = &self.live.tabs;
        tabs.set_mode(&target, mode, Some(self.phone), true);
        Ok(())
    }

    /// The target the client watches, as it is told now.
    fn target(&self) -> Option<Target> {
        let (id, _) = self.selected.as_ref()?;
        let targets = self.live.targets.borrow();
        targets.iter().find(|target| target.id == *id).cloned()
    }

    /// The target the client watches, for what only its tab's holder does to it.
    /// Whether the client holds the lease of the tab it watches, without taking it.
    fn leads(&self) -> bool {
        let tab = self.tab();
        let present = self.present.borrow();
        let mut leases = present.leases.iter();
        leases.any(|lease| Some(lease.tab) == tab && lease.holder == self.member.id)
    }

    /// The target the client watches.
    fn watched(&self) -> anyhow::Result<String> {
        let (target, _) = self.selected.as_ref().context("no tab is watched")?;
        Ok(target.clone())
    }

    /// The target the client watches, when the client is the one that gives it input.
    fn held(&self) -> anyhow::Result<String> {
        let target = self.watched()?;
        ensure!(self.holds(), "someone else holds the tab");
        Ok(target)
    }

    async fn go(&mut self, go: pb::Go) -> anyhow::Result<()> {
        ensure!(self.grant(Area::Tabs).write, NOT_ALLOWED);
        let pages = self.live.pages.clone();
        if go.new_tab {
            ensure!(self.only.is_none(), ONE_TAB);
            // A tab that is not there yet is nobody's: no lease stands in its way.
            let url = match go.to {
                Some(pb::go::To::Url(url)) => url,
                Some(pb::go::To::Along(_)) => bail!("a new tab has no history to go along"),
                None => String::new(),
            };
            // A tab opened from one that is shown as on a phone is shown so too.
            let like = self.target().as_ref().map(Like::of);
            self.opened = Some(pages.open_tab(&url, like).await?);
            return Ok(());
        }
        // Where a tab goes is no input to its page: it takes no lease.
        let target = self.watched()?;
        match go.to {
            Some(pb::go::To::Url(url)) => pages.open(&target, &url).await,
            Some(pb::go::To::Along(along)) => {
                let along = match along.as_known() {
                    Some(pb::Along::ALONG_BACK) => Along::Back,
                    Some(pb::Along::ALONG_FORWARD) => Along::Forward,
                    Some(pb::Along::ALONG_RELOAD) => Along::Reload,
                    Some(pb::Along::ALONG_UNSPECIFIED) | None => bail!("no way to go was named"),
                };
                pages.go(&target, along).await
            }
            None => pages.open(&target, "").await,
        }
    }

    async fn close(&mut self, tab: u32) -> anyhow::Result<()> {
        ensure!(self.grant(Area::Tabs).write, NOT_ALLOWED);
        // Its own tab gone, nothing is left that it sees.
        ensure!(self.only.is_none(), ONE_TAB);
        let target = {
            let targets = self.live.targets.borrow();
            let closed = targets.iter().find(|closed| closed.tab == tab);
            closed.map(|closed| closed.id.clone())
        };
        // A tab that is gone already is closed as asked.
        let Some(target) = target else {
            return Ok(());
        };
        self.live.pages.close(&target).await
    }

    /// A picture the watched page shows, as what the session copied.
    async fn picture(&mut self, url: &str) -> anyhow::Result<pb::Clipboard> {
        ensure!(self.grant(Area::Clipboard).read, NOT_ALLOWED);
        let target = self.watched()?;
        let (kind, data) = self.live.pages.picture(&target, url).await?;
        let form = pb::clipboard::Form {
            r#type: kind.to_owned(),
            data,
            ..Default::default()
        };
        Ok(pb::Clipboard {
            forms: vec![form],
            ..Default::default()
        })
    }

    /// Answers a page's request for files with uploads, named.
    async fn choose_files(&mut self, chosen: &pb::FilesChosen) -> anyhow::Result<()> {
        ensure!(self.grant(Area::Uploads).write, NOT_ALLOWED);
        self.held()?;
        let uploads = self.live.files.join(files::UPLOADS);
        let files = chosen.files.iter().map(|name| {
            files::named(&uploads, name)
                .filter(|path| path.is_file())
                .with_context(|| format!("{name} is not among the uploads"))
        });
        let files = files.collect::<anyhow::Result<_>>()?;
        self.live.pages.answer(chosen.id, files).await?;
        Ok(())
    }

    /// Tells the client of what it asked for and was not done.
    /// Fails while the session is being given what its browser starts with.
    fn restored(&self) -> anyhow::Result<()> {
        ensure!(
            *self.restore.borrow() == Restore::None,
            "the session is being restored"
        );
        Ok(())
    }

    async fn answer(
        &mut self,
        asked: pb::Asked,
        done: anyhow::Result<()>,
    ) -> Result<(), axum::Error> {
        let Err(err) = done else {
            return Ok(());
        };
        let failed = pb::Failed {
            asked: asked.into(),
            reason: format!("{err:#}"),
            ..Default::default()
        };
        self.send(server_message::Message::Failed(Box::new(failed)))
            .await
    }

    /// Goes to the tab the member the client follows watches, where that is another.
    async fn keep_up(&mut self) -> Result<(), axum::Error> {
        let ahead = {
            let present = self.present.borrow();
            let member = |id| present.members.iter().find(|member| member.id == id);
            let followed = member(self.member.id).and_then(|own| own.follows);
            followed.and_then(member).and_then(|followed| followed.tab)
        };
        let Some(tab) = ahead.filter(|tab| self.tab() != Some(*tab)) else {
            return Ok(());
        };
        if self.select(Some(tab)).await? {
            self.send_selected().await?;
        }
        Ok(())
    }

    /// Shows the others who watch the tab where the client's pointer is, as often as they
    /// take it.
    fn point(&mut self, at: Option<(f64, f64)>) {
        let Some(tab) = self.tab() else {
            return;
        };
        // That it left is always told; where it is, when the last word is old enough.
        if at.is_some() {
            if self.pointed.elapsed() < POINTED_EVERY {
                return;
            }
            self.pointed = Instant::now();
        }
        self.live.presence.show(Mark {
            member: self.member.id,
            tab,
            what: Shown::Pointer(at),
        });
    }

    /// Shows the others who watch the tab a point of a stroke the client draws.
    fn draw(&mut self, draw: &pb::Draw) {
        let phase = match draw.phase.as_known() {
            Some(pb::StrokePhase::STROKE_PHASE_START) => Phase::Start,
            Some(pb::StrokePhase::STROKE_PHASE_MOVE) => Phase::Move,
            Some(pb::StrokePhase::STROKE_PHASE_END) => Phase::End,
            Some(pb::StrokePhase::STROKE_PHASE_UNSPECIFIED) | None => return,
        };
        let Some(tab) = self.tab() else {
            return;
        };
        if self.drawn.0.elapsed() >= Duration::from_secs(1) {
            self.drawn = (Instant::now(), 0);
        }
        self.drawn.1 += 1;
        // A stroke that ends always does: the others would keep it open otherwise.
        if self.drawn.1 > DRAWN_A_SECOND && phase != Phase::End {
            return;
        }
        self.live.presence.show(Mark {
            member: self.member.id,
            tab,
            what: Shown::Stroke {
                stroke: draw.stroke,
                phase,
                x: draw.x,
                y: draw.y,
            },
        });
    }

    /// Gives the watched tab what the client's pointer and keys do, if the tab takes it of
    /// this client.
    fn input(&self, message: client_message::Message) {
        use client_message::Message;
        // A key that comes up does so though the tab it went down in is gone.
        let lifted = match &message {
            Message::Key(m) if !m.pressed => Some(m.code),
            _ => None,
        };
        let (Some(window), Some(tab)) = (
            self.selected.as_ref().map(|(_, window)| *window),
            self.tab(),
        ) else {
            if let Some(code) = lifted {
                self.live.presence.lift(self.member.id, code);
            }
            return;
        };
        // Positions come in the page's pixels, which a window has more of where the page
        // is narrower than a window gets.
        let zoom = self.target().map_or(1.0, |target| target.zoom);
        let input = match message {
            Message::PointerMotion(m) => Input::PointerMotion {
                window,
                x: m.x * zoom,
                y: m.y * zoom,
            },
            Message::PointerButton(m) => {
                let button = match m.button.as_known() {
                    Some(pb::MouseButton::MOUSE_BUTTON_LEFT) => Button::Left,
                    Some(pb::MouseButton::MOUSE_BUTTON_RIGHT) => Button::Right,
                    Some(pb::MouseButton::MOUSE_BUTTON_MIDDLE) => Button::Middle,
                    Some(pb::MouseButton::MOUSE_BUTTON_BACK) => Button::Back,
                    Some(pb::MouseButton::MOUSE_BUTTON_FORWARD) => Button::Forward,
                    Some(pb::MouseButton::MOUSE_BUTTON_UNSPECIFIED) | None => return,
                };
                Input::PointerButton {
                    window,
                    x: m.x * zoom,
                    y: m.y * zoom,
                    button,
                    pressed: m.pressed,
                }
            }
            Message::PointerScroll(m) => Input::PointerScroll {
                window,
                x: m.x * zoom,
                y: m.y * zoom,
                dx: m.dx,
                dy: m.dy,
            },
            Message::PointerLeave(_) => Input::PointerLeave,
            Message::Key(m) => Input::Key {
                window,
                code: m.code,
                pressed: m.pressed,
            },
            Message::Text(m) => Input::Text {
                window,
                text: m.text,
                composing: m.composing,
            },
            Message::Drop(m) => {
                let Some(content) = m.content.into_option().and_then(|m| self.content(m)) else {
                    return;
                };
                Input::Drop {
                    window,
                    x: m.x * zoom,
                    y: m.y * zoom,
                    content,
                }
            }
            Message::Hello(_)
            | Message::Select(_)
            | Message::Viewport(_)
            | Message::Device(_)
            | Message::SetMode(_)
            | Message::Lease(_)
            | Message::RtcOffer(_)
            | Message::VideoShown(_)
            | Message::Clipboard(_)
            | Message::Go(_)
            | Message::CopyPicture(_)
            | Message::Close(_)
            | Message::Follow(_)
            | Message::Draw(_)
            | Message::Pointing(_)
            | Message::FilesChosen(_) => return,
        };
        self.live.presence.input(self.member.id, tab, input);
    }

    fn watches(&self, target: &str) -> bool {
        self.selected.as_ref().is_some_and(|(id, _)| id == target)
    }

    /// The number of the tab the client watches.
    fn tab(&self) -> Option<u32> {
        let (id, _) = self.selected.as_ref()?;
        let targets = self.live.targets.borrow();
        targets
            .iter()
            .find(|target| target.id == *id)
            .map(|target| target.tab)
    }

    /// The browser's own id of the tab the client watches, which is whose sound it hears.
    fn heard(&self) -> Option<i64> {
        let (id, _) = self.selected.as_ref()?;
        let targets = self.live.targets.borrow();
        targets
            .iter()
            .find(|target| target.id == *id)
            .map(|target| target.browser_tab)
    }

    /// Whether the client holds the tab it watches, which it takes when nobody does.
    fn holds(&self) -> bool {
        self.tab()
            .is_some_and(|tab| self.live.presence.hold(self.member.id, tab, true))
    }

    /// Settles which target the client watches: the one of the tab it asks for, else a
    /// tab it opened itself, else one the page it gives input to opened, else the one it
    /// has, else the one watched last, else the newest. A tab someone else opened takes
    /// nobody along. A target that moved to another window is followed there. What the
    /// client comes to watch is the tab watched last. A client that sees one tab watches
    /// that one, and nothing once it is closed. Tells whether it changed.
    async fn select(&mut self, wanted: Option<u32>) -> Result<bool, axum::Error> {
        let leads = self.leads();
        // Before the targets are borrowed: what tells of them holds what this asks.
        let opened = self
            .opened
            .as_ref()
            .map(|opened| self.live.tabs.known_as(opened));
        let watched = self.live.tabs.watched();
        let (selected, came) = {
            let targets = self.live.targets.borrow();
            let kept = self
                .selected
                .as_ref()
                .and_then(|(id, _)| targets.iter().find(|target| target.id == *id));
            let opened = opened
                .as_ref()
                .and_then(|opened| targets.iter().find(|target| target.id == *opened));
            let popped = kept.filter(|_| leads).and_then(|kept| {
                let new = |target: &&Target| !self.known.contains(&target.id);
                let of = |target: &&Target| target.opener.as_deref() == Some(kept.id.as_str());
                targets.iter().rev().filter(new).find(of)
            });
            let selected = match self.only {
                Some(only) => targets.iter().find(|target| target.tab == only),
                None => wanted
                    .and_then(|tab| targets.iter().find(|target| target.tab == tab))
                    .or(opened)
                    .or(popped)
                    .or(kept)
                    .or_else(|| targets.iter().find(|target| Some(target.tab) == watched))
                    .or(targets.last()),
            }
            .map(|target| (target.id.clone(), target.window));
            self.known = targets.iter().map(|target| target.id.clone()).collect();
            (selected, opened.is_some())
        };
        if came {
            self.opened = None;
        }
        if selected == self.selected {
            return Ok(false);
        }
        self.selected = selected;
        let tab = self.tab();
        self.live.presence.watch(self.member.id, tab);
        if let Some(tab) = tab {
            self.live.tabs.watch(tab);
        }
        self.show().await?;
        Ok(true)
    }

    /// What the client may do in an area: what whoever let it in gave it, of what the
    /// session offers at all.
    fn grant(&self, area: Area) -> Grant {
        let features = self.live.features;
        let offered = match area {
            Area::Input | Area::Tabs | Area::Lease | Area::Proxy => true,
            Area::Sound => features.sound,
            Area::Clipboard => features.clipboard,
            Area::Uploads => features.uploads,
            Area::Downloads => features.downloads,
            Area::Recordings => features.recordings,
            Area::Mcp => features.mcp,
            Area::Cdp => features.cdp,
            Area::Tunnel => features.tunnel,
        };
        Grant {
            read: offered && self.access.reads(area),
            write: offered && self.access.writes(area),
        }
    }

    /// What a client copied or dragged, in the forms that are carried; none when nothing
    /// is left of it, or it is too much.
    fn content(&self, content: pb::Clipboard) -> Option<Forms> {
        let forms: Vec<Form> = content
            .forms
            .into_iter()
            .filter(|form| data::KINDS.contains(&form.r#type.as_str()))
            // Files are the session's own or none: the browser reads what it is named.
            .filter(|form| form.r#type != "text/uri-list" || self.names_own_files(&form.data))
            .map(|form| Form {
                kind: form.r#type,
                data: form.data,
            })
            .collect();
        let size: usize = forms.iter().map(|form| form.data.len()).sum();
        (!forms.is_empty() && size <= data::MOST).then(|| forms.into())
    }

    /// Whether every line of a list of URIs is a file of the session's files.
    fn names_own_files(&self, list: &[u8]) -> bool {
        let Ok(list) = std::str::from_utf8(list) else {
            return false;
        };
        list.lines().filter(|line| !line.is_empty()).all(|line| {
            let path = url::Url::parse(line)
                .ok()
                .filter(|uri| uri.scheme() == "file")
                .and_then(|uri| uri.to_file_path().ok());
            path.is_some_and(|path| {
                let plain = path
                    .components()
                    .all(|part| !matches!(part, std::path::Component::ParentDir));
                plain && path.starts_with(&self.live.files)
            })
        })
    }

    /// Nothing is sent before the client's hello, which tells the encoding it reads; what
    /// it needs to know by then is sent in answer to it.
    async fn send(&mut self, message: server_message::Message) -> Result<(), axum::Error> {
        if !self.greeted {
            return Ok(());
        }
        let envelope = pb::ServerMessage {
            message: Some(message),
            ..Default::default()
        };
        let frame = if self.json {
            match serde_json::to_string(&envelope) {
                Ok(text) => Frame::Text(text.into()),
                Err(err) => {
                    warn!(%err, "failed to encode a message");
                    return Ok(());
                }
            }
        } else {
            Frame::Binary(envelope.encode_to_vec().into())
        };
        self.socket.send(frame).await
    }
}

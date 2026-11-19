//! One client of the session: the session socket it speaks the live protocol on, the
//! target it watches, and the way that target's pixels reach it.

mod picture;
mod tell;

use std::collections::BTreeSet;

use anyhow::{Context as _, bail, ensure};
use aperture_compositor::{Button, Cursor, Form, Forms, Input, Viewport, WindowId, data};
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
    pages::{self, Along},
    presence::{Identity, Membership, Present},
    proto::aperture::live::v1::{self as pb, client_message, server_message},
};

/// What a client may do in one area.
#[derive(Clone, Copy)]
struct Grant {
    read: bool,
    write: bool,
}

/// Why a client that may not do what it asked for is told it was not done.
const NOT_ALLOWED: &str = "the session does not let this client do it";

/// What a client's WebRTC connection has to tell that waits for its session socket's turn.
const CHANNEL_MESSAGES: usize = 256;

/// Serves the client until its socket closes or the session ends.
pub async fn serve(live: Live, socket: WebSocket, identity: Identity) {
    let access = identity.access;
    let (tiles_watch, tiles) = tiles::start(live.compositor.clone());
    let (from_peer, peer_events) = mpsc::channel(CHANNEL_MESSAGES);
    let mut client = Client {
        cursor: live.compositor.cursor(),
        clipboard: live.compositor.clipboard(),
        downloads: live.downloads.clone(),
        file_requests: live.pages.requests(),
        menus: live.pages.menus(),
        present: live.presence.present(),
        sounding: live.sound.sounding(),
        sound: None,
        access,
        member: live.presence.join(identity, false),
        live,
        socket,
        greeted: false,
        json: false,
        pixels: pb::Pixels::PIXELS_UNSPECIFIED,
        selected: None,
        chosen: false,
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
    downloads: watch::Receiver<Vec<Download>>,
    file_requests: watch::Receiver<Vec<pages::Request>>,
    menus: broadcast::Receiver<pages::Menu>,
    present: watch::Receiver<Present>,
    /// What the client may do, as whoever let it in says.
    access: Access,
    /// The session's sound, for a client that takes it on the socket.
    sound: Option<sound::Listener>,
    /// The browser's tabs that play something now.
    sounding: watch::Receiver<BTreeSet<i64>>,
    /// The client as one of those in the session.
    member: Membership,
    socket: WebSocket,
    /// The client said hello.
    greeted: bool,
    /// The client's last message came as JSON text.
    json: bool,
    pixels: pb::Pixels,
    /// The target the client watches, and the window that shows the target.
    selected: Option<(String, WindowId)>,
    /// The client selected a target itself; until then it watches the newest one.
    chosen: bool,
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
        loop {
            let heard = self.heard();
            tokio::select! {
                frame = self.socket.recv() => match frame {
                    Some(Ok(Frame::Close(_))) | None => return Ok(()),
                    Some(Ok(frame)) => self.read(frame).await?,
                    Some(Err(err)) => return Err(err),
                },
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
                    if self.select(None).await? {
                        self.send_selected().await?;
                    }
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
                }
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
                self.chosen = true;
                if self.select(Some(&select.target)).await? {
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
                let gone = self.go(*go).await;
                self.answer(pb::Asked::ASKED_GO, gone).await
            }
            Message::Close(close) => {
                let closed = self.close(&close.target).await;
                self.answer(pb::Asked::ASKED_CLOSE, closed).await
            }
            Message::CopyPicture(picture) => match self.picture(&picture.url).await {
                Ok(picture) => {
                    self.send(server_message::Message::Clipboard(Box::new(picture)))
                        .await
                }
                Err(err) => self.answer(pb::Asked::ASKED_COPY_PICTURE, Err(err)).await,
            },
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
                self.input(message);
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
        self.send_targets().await?;
        self.send_cursor().await?;
        self.send_downloads().await?;
        self.send_file_requests().await?;
        self.send_presence().await?;
        if !self.select(None).await? {
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
        let watched = self.selected.as_ref().and_then(|(id, window)| {
            let targets = self.live.targets.borrow();
            let target = targets.iter().find(|target| target.id == *id)?;
            Some((*window, target.scale))
        });
        if let Some((window, scale)) = watched
            && self.grant(Area::Tabs).write
            && self.holds()
        {
            self.live.compositor.set_viewport(
                window,
                Viewport {
                    width: viewport.width,
                    height: viewport.height,
                    scale: viewport.scale.unwrap_or(scale),
                },
            );
        }
    }

    /// The target the client watches, for what only its tab's holder does to it.
    fn held(&self) -> anyhow::Result<String> {
        let (target, _) = self.selected.as_ref().context("no tab is watched")?;
        ensure!(self.holds(), "someone else holds the tab");
        Ok(target.clone())
    }

    async fn go(&mut self, go: pb::Go) -> anyhow::Result<()> {
        ensure!(self.grant(Area::Tabs).write, NOT_ALLOWED);
        let target = self.held()?;
        let pages = &self.live.pages;
        match go.to {
            Some(pb::go::To::Url(url)) => pages.open(&target, &url, go.new_tab).await,
            Some(pb::go::To::Along(along)) => {
                let along = match along.as_known() {
                    Some(pb::Along::ALONG_BACK) => Along::Back,
                    Some(pb::Along::ALONG_FORWARD) => Along::Forward,
                    Some(pb::Along::ALONG_RELOAD) => Along::Reload,
                    Some(pb::Along::ALONG_UNSPECIFIED) | None => bail!("no way to go was named"),
                };
                pages.go(&target, along).await
            }
            None => pages.open(&target, "", go.new_tab).await,
        }
    }

    async fn close(&mut self, target: &str) -> anyhow::Result<()> {
        ensure!(self.grant(Area::Tabs).write, NOT_ALLOWED);
        let tab = {
            let targets = self.live.targets.borrow();
            let closed = targets.iter().find(|closed| closed.id == target);
            closed.map(|closed| closed.tab)
        };
        // A tab that is gone already is closed as asked.
        let Some(tab) = tab else {
            return Ok(());
        };
        ensure!(
            self.live.presence.hold(self.member.id, tab, true),
            "someone else holds the tab"
        );
        self.live.pages.close(target).await
    }

    /// A picture the watched page shows, as what the session copied.
    async fn picture(&mut self, url: &str) -> anyhow::Result<pb::Clipboard> {
        ensure!(self.grant(Area::Clipboard).read, NOT_ALLOWED);
        let target = self.held()?;
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

    /// Gives the watched tab what the client's pointer and keys do, if the tab takes it of
    /// this client.
    fn input(&self, message: client_message::Message) {
        use client_message::Message;
        let Some((_, window)) = self.selected else {
            return;
        };
        let input = match message {
            Message::PointerMotion(m) => Input::PointerMotion {
                window,
                x: m.x,
                y: m.y,
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
                    x: m.x,
                    y: m.y,
                    button,
                    pressed: m.pressed,
                }
            }
            Message::PointerScroll(m) => Input::PointerScroll {
                window,
                x: m.x,
                y: m.y,
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
                    x: m.x,
                    y: m.y,
                    content,
                }
            }
            Message::Hello(_)
            | Message::Select(_)
            | Message::Viewport(_)
            | Message::Lease(_)
            | Message::RtcOffer(_)
            | Message::VideoShown(_)
            | Message::Clipboard(_)
            | Message::Go(_)
            | Message::CopyPicture(_)
            | Message::Close(_)
            | Message::FilesChosen(_) => return,
        };
        if let Some(tab) = self.tab() {
            self.live.presence.input(self.member.id, tab, input);
        }
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

    /// Settles which target the client watches: the one it asks for, else the one it has,
    /// else, and always until the client chose one, the newest. A target that moved to
    /// another window is followed there. Tells whether it changed.
    async fn select(&mut self, wanted: Option<&str>) -> Result<bool, axum::Error> {
        let selected = {
            let targets = self.live.targets.borrow();
            let find = |id: &str| targets.iter().find(|target| target.id == id);
            let kept = self
                .selected
                .as_ref()
                .filter(|_| self.chosen)
                .and_then(|(id, _)| find(id));
            wanted
                .and_then(find)
                .or(kept)
                .or(targets.last())
                .map(|target| (target.id.clone(), target.window))
        };
        if selected == self.selected {
            return Ok(false);
        }
        self.selected = selected;
        self.live.presence.watch(self.member.id, self.tab());
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

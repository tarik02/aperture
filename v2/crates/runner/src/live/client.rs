//! One client of the session: the session socket it speaks the live protocol on, the
//! target it watches, and the way that target's pixels reach it.

use aperture_compositor::{Button, Cursor, Form, Forms, Input, Viewport, WindowId, data};
use axum::extract::ws::{Message as Frame, WebSocket};
use buffa::Message as _;
use tokio::sync::{broadcast, mpsc, watch};
use tracing::{debug, warn};

use super::{
    adapt::Delivery,
    encode::{Format, Quality},
    encoders,
    http::Live,
    rtc::{self, FromPeer},
    stream::{Key, Packet, Subscription},
    tiles,
};
use crate::{
    files::{self, Download, Progress},
    proto::aperture::live::v1::{self as pb, client_message, server_message},
};

/// What a client's WebRTC connection has to tell that waits for its session socket's turn.
const CHANNEL_MESSAGES: usize = 256;

/// Serves the client until its socket closes or the session ends.
pub async fn serve(live: Live, socket: WebSocket) {
    let (tiles_watch, tiles) = tiles::start(live.compositor.clone());
    let (from_peer, peer_events) = mpsc::channel(CHANNEL_MESSAGES);
    let mut client = Client {
        cursor: live.compositor.cursor(),
        clipboard: live.compositor.clipboard(),
        downloads: live.downloads.clone(),
        file_requests: live.file_requests.open(),
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
    file_requests: watch::Receiver<Vec<files::Request>>,
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
            tokio::select! {
                frame = self.socket.recv() => {
                    let (envelope, json) = match frame {
                        Some(Ok(Frame::Binary(data))) => (
                            pb::ClientMessage::decode_from_slice(&data).map_err(|err| err.to_string()),
                            false,
                        ),
                        Some(Ok(Frame::Text(text))) => (
                            serde_json::from_str::<pb::ClientMessage>(&text)
                                .map_err(|err| err.to_string()),
                            true,
                        ),
                        Some(Ok(Frame::Close(_))) | None => return Ok(()),
                        Some(Ok(_)) => continue,
                        Some(Err(err)) => return Err(err),
                    };
                    match envelope.map(|envelope| envelope.message) {
                        Ok(Some(message)) => {
                            self.json = json;
                            self.handle(message).await?;
                        }
                        Ok(None) => {}
                        Err(reason) => warn!(%reason, "malformed client message"),
                    }
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
                changed = self.live.targets.changed() => {
                    // The session ended.
                    if changed.is_err() {
                        return Ok(());
                    }
                    self.send_targets().await?;
                    if self.select(None).await {
                        self.send_selected().await?;
                    }
                }
                changed = self.cursor.changed() => {
                    if changed.is_err() {
                        return Ok(());
                    }
                    self.send_cursor().await?;
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
                    let copied = self.clipboard.borrow_and_update().clone();
                    if let Some(copied) = copied {
                        let forms = copied.iter().map(|form| pb::clipboard::Form {
                            r#type: form.kind.clone(),
                            data: form.data.clone(),
                            ..Default::default()
                        });
                        let clipboard = pb::Clipboard {
                            forms: forms.collect(),
                            ..Default::default()
                        };
                        self.send(server_message::Message::Clipboard(Box::new(clipboard)))
                            .await?;
                    }
                }
            }
        }
    }

    async fn handle(&mut self, message: client_message::Message) -> Result<(), axum::Error> {
        use client_message::Message;
        let input = match message {
            Message::Hello(hello) => {
                self.greeted = true;
                self.pixels = hello.pixels.as_known().unwrap_or_default();
                self.pinned = match hello.quality.as_known() {
                    Some(pb::VideoQuality::VIDEO_QUALITY_LOW) => Some(Quality::Low),
                    Some(pb::VideoQuality::VIDEO_QUALITY_MEDIUM) => Some(Quality::Medium),
                    Some(pb::VideoQuality::VIDEO_QUALITY_FULL) => Some(Quality::Full),
                    Some(pb::VideoQuality::VIDEO_QUALITY_UNSPECIFIED) | None => None,
                };
                self.delivery.pin(self.pinned);
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
                self.formats = made.await.unwrap_or_default();
                self.format = self.formats.first().copied().unwrap_or(Format::H264);
                self.send_targets().await?;
                self.send_cursor().await?;
                self.send_downloads().await?;
                self.send_file_requests().await?;
                self.select(None).await;
                self.show().await;
                return self.send_selected().await;
            }
            Message::Select(select) => {
                self.chosen = true;
                if self.select(Some(&select.target)).await {
                    self.send_selected().await?;
                }
                if let Some((_, window)) = self.selected {
                    self.live.compositor.focus(window);
                }
                return Ok(());
            }
            Message::Viewport(viewport) => {
                let watched = self.selected.as_ref().and_then(|(id, window)| {
                    let targets = self.live.targets.borrow();
                    let target = targets.iter().find(|target| target.id == *id)?;
                    Some((*window, target.scale))
                });
                if let Some((window, scale)) = watched {
                    self.live.compositor.set_viewport(
                        window,
                        Viewport {
                            width: viewport.width,
                            height: viewport.height,
                            scale: viewport.scale.unwrap_or(scale),
                        },
                    );
                }
                return Ok(());
            }
            Message::RtcOffer(offer) => return self.connect_video(&offer.sdp).await,
            Message::VideoShown(shown) => {
                if let Some(quality) = self.delivery.shown(shown.time_us) {
                    self.take_quality(quality).await?;
                }
                return Ok(());
            }
            input => input,
        };
        let Some((_, window)) = self.selected else {
            return Ok(());
        };
        let input = match input {
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
                    Some(pb::MouseButton::MOUSE_BUTTON_UNSPECIFIED) | None => return Ok(()),
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
            Message::Clipboard(m) => {
                if let Some(content) = self.content(*m) {
                    self.live.compositor.set_clipboard(content);
                }
                return Ok(());
            }
            Message::FilesChosen(m) => {
                let uploads = self.live.files.join(files::UPLOADS);
                // Files that are not there are left out, as names that are no names.
                let chosen = m
                    .files
                    .iter()
                    .filter_map(|name| files::named(&uploads, name))
                    .filter(|path| path.is_file())
                    .collect();
                if let Err(err) = self.live.file_requests.answer(m.id, chosen).await {
                    debug!(%err, "a page did not take the files it asked for");
                }
                return Ok(());
            }
            Message::Drop(m) => {
                let Some(content) = m.content.into_option().and_then(|m| self.content(m)) else {
                    return Ok(());
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
            | Message::RtcOffer(_)
            | Message::VideoShown(_) => return Ok(()),
        };
        self.live.compositor.input(input);
        Ok(())
    }

    /// Answers the client's offer; the connection it makes replaces the one before it.
    async fn connect_video(&mut self, offer: &str) -> Result<(), axum::Error> {
        let connected = rtc::connect(
            self.live.streams.clone(),
            self.live.rtc_ports,
            offer,
            self.from_peer.clone(),
        );
        match connected.await {
            Ok((sdp, video)) => {
                self.video = Some(video);
                self.show().await;
                self.send(server_message::Message::RtcAnswer(Box::new(
                    pb::RtcAnswer {
                        sdp,
                        ..Default::default()
                    },
                )))
                .await
            }
            Err(err) => {
                self.send(server_message::Message::RtcRefused(Box::new(
                    pb::RtcRefused {
                        reason: err.to_string(),
                        ..Default::default()
                    },
                )))
                .await
            }
        }
    }

    /// Settles which target the client watches: the one it asks for, else the one it has,
    /// else, and always until the client chose one, the newest. A target that moved to
    /// another window is followed there. Tells whether it changed.
    async fn select(&mut self, wanted: Option<&str>) -> bool {
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
            return false;
        }
        self.selected = selected;
        self.show().await;
        true
    }

    /// Points the client's pixels at the target it watches.
    async fn show(&mut self) {
        if let Some(video) = &self.video {
            let watched = rtc::Watched {
                window: self.selected.as_ref().map(|(_, window)| *window),
                quality: self.pinned,
                fps: self.fps,
                formats: self.formats.clone(),
            };
            // A connection that ended takes nothing; the client offers another.
            let _ = video.send(watched).await;
        }
        self.next_frames = None;
        self.delivery.restart();
        self.frames = self.subscribe().await;
        self.request_keyframe();
        if let Some(frames) = &self.frames {
            // A socket that fails says so at the client's next message.
            let _ = self.send_status(frames.key).await;
        }
        let tiles = self
            .selected
            .clone()
            .filter(|_| self.pixels == pb::Pixels::PIXELS_TILES);
        self.tiles_watch.send_if_modified(|watched| {
            let changed = *watched != tiles;
            *watched = tiles;
            changed
        });
    }

    /// The watched target's frames at the quality the link carries; none for a client
    /// that does not take frames.
    async fn subscribe(&mut self) -> Option<Subscription> {
        if self.pixels != pb::Pixels::PIXELS_FRAMES {
            return None;
        }
        let (_, window) = self.selected.as_ref()?;
        let key = Key {
            window: *window,
            format: self.format,
            quality: self.delivery.quality(),
            fps: self.fps,
        };
        self.live.streams.subscribe(key).await.ok()
    }

    /// Changes the quality of the frames. A better one takes over at its first keyframe,
    /// which is when the client is told; a lower one at once, since what it replaces is what the link does not carry.
    async fn take_quality(&mut self, quality: Quality) -> Result<(), axum::Error> {
        let lower = self
            .frames
            .as_ref()
            .is_some_and(|frames| quality < frames.key.quality);
        let stream = self.subscribe().await;
        if lower {
            self.frames = stream;
            self.next_frames = None;
            self.awaits_keyframe = true;
            match &self.frames {
                Some(frames) => self.send_status(frames.key).await,
                None => Ok(()),
            }
        } else {
            self.next_frames = stream;
            Ok(())
        }
    }

    fn request_keyframe(&mut self) {
        if let Some(frames) = &self.frames {
            self.awaits_keyframe = true;
            frames.keyframe();
        }
    }

    async fn send_frame(&mut self, packet: &Packet) -> Result<(), axum::Error> {
        let (clogged, lowered) = self.delivery.clogged();
        if let Some(quality) = lowered {
            self.take_quality(quality).await?;
        }
        if clogged {
            // The frames after this one build on it: the next one sent is a keyframe,
            // asked for once there is room for it.
            self.awaits_keyframe = true;
            return Ok(());
        }
        if self.awaits_keyframe && !packet.keyframe {
            if let Some(frames) = &self.frames {
                frames.keyframe();
            }
            return Ok(());
        }
        self.awaits_keyframe = false;
        let Some((target, _)) = &self.selected else {
            return Ok(());
        };
        let time_us = packet.time.as_micros() as u64;
        let frame = pb::VideoFrame {
            target: target.clone(),
            keyframe: packet.keyframe,
            time_us,
            data: packet.data.clone(),
            format: format_of(self.format).into(),
            width: packet.size.0,
            height: packet.size.1,
            ..Default::default()
        };
        self.delivery.sent(time_us, packet.data.len());
        self.send(server_message::Message::VideoFrame(Box::new(frame)))
            .await
    }

    async fn send_status(&mut self, key: Key) -> Result<(), axum::Error> {
        let quality = match key.quality {
            Quality::Low => pb::VideoQuality::VIDEO_QUALITY_LOW,
            Quality::Medium => pb::VideoQuality::VIDEO_QUALITY_MEDIUM,
            Quality::Full => pb::VideoQuality::VIDEO_QUALITY_FULL,
        };
        let status = pb::VideoStatus {
            format: format_of(key.format).into(),
            quality: quality.into(),
            fps: key.fps(),
            ..Default::default()
        };
        self.send(server_message::Message::VideoStatus(Box::new(status)))
            .await
    }

    async fn send_targets(&mut self) -> Result<(), axum::Error> {
        let targets = self
            .live
            .targets
            .borrow_and_update()
            .iter()
            .map(|target| pb::Target {
                id: target.id.clone(),
                tab: target.tab,
                title: target.title.clone(),
                url: target.url.clone(),
                width: target.width,
                height: target.height,
                scale: target.scale,
                ..Default::default()
            })
            .collect();
        self.send(server_message::Message::Targets(Box::new(pb::Targets {
            targets,
            ..Default::default()
        })))
        .await
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

    async fn send_file_requests(&mut self) -> Result<(), axum::Error> {
        let requests = self
            .file_requests
            .borrow_and_update()
            .iter()
            .map(|request| pb::FileRequest {
                id: request.id,
                target: request.target.clone(),
                multiple: request.multiple,
                ..Default::default()
            })
            .collect();
        let requests = pb::FileRequests {
            requests,
            ..Default::default()
        };
        self.send(server_message::Message::FileRequests(Box::new(requests)))
            .await
    }

    async fn send_downloads(&mut self) -> Result<(), axum::Error> {
        let downloads = self
            .downloads
            .borrow_and_update()
            .iter()
            .map(|download| pb::Download {
                id: download.id.clone(),
                name: download.name.clone(),
                url: download.url.clone(),
                received_bytes: download.received,
                total_bytes: download.total,
                state: match download.state {
                    Progress::Running => pb::DownloadState::DOWNLOAD_STATE_RUNNING,
                    Progress::Done => pb::DownloadState::DOWNLOAD_STATE_DONE,
                    Progress::Failed => pb::DownloadState::DOWNLOAD_STATE_FAILED,
                }
                .into(),
                ..Default::default()
            })
            .collect();
        self.send(server_message::Message::Downloads(Box::new(
            pb::Downloads {
                downloads,
                ..Default::default()
            },
        )))
        .await
    }

    async fn send_selected(&mut self) -> Result<(), axum::Error> {
        let target = self.selected.as_ref().map(|(id, _)| id.clone());
        self.send(server_message::Message::Selected(Box::new(pb::Selected {
            target,
            ..Default::default()
        })))
        .await
    }

    async fn send_cursor(&mut self) -> Result<(), axum::Error> {
        let cursor = match &*self.cursor.borrow_and_update() {
            Cursor::Hidden => pb::cursor::Cursor::Hidden(Box::default()),
            Cursor::Named(name) => pb::cursor::Cursor::Named((*name).to_owned()),
        };
        self.send(server_message::Message::Cursor(Box::new(pb::Cursor {
            cursor: Some(cursor),
            ..Default::default()
        })))
        .await
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

fn format_of(format: Format) -> pb::VideoFormat {
    match format {
        Format::H264 => pb::VideoFormat::VIDEO_FORMAT_H264,
        Format::FullChroma => pb::VideoFormat::VIDEO_FORMAT_FULL_CHROMA,
        Format::H265 => pb::VideoFormat::VIDEO_FORMAT_H265,
        Format::Vp9 => pb::VideoFormat::VIDEO_FORMAT_VP9,
        Format::Vp9FullChroma => pb::VideoFormat::VIDEO_FORMAT_VP9_FULL_CHROMA,
        Format::Av1 => pb::VideoFormat::VIDEO_FORMAT_AV1,
    }
}

fn format_from(format: pb::VideoFormat) -> Option<Format> {
    match format {
        pb::VideoFormat::VIDEO_FORMAT_UNSPECIFIED => None,
        pb::VideoFormat::VIDEO_FORMAT_H264 => Some(Format::H264),
        pb::VideoFormat::VIDEO_FORMAT_FULL_CHROMA => Some(Format::FullChroma),
        pb::VideoFormat::VIDEO_FORMAT_H265 => Some(Format::H265),
        pb::VideoFormat::VIDEO_FORMAT_VP9 => Some(Format::Vp9),
        pb::VideoFormat::VIDEO_FORMAT_VP9_FULL_CHROMA => Some(Format::Vp9FullChroma),
        pb::VideoFormat::VIDEO_FORMAT_AV1 => Some(Format::Av1),
    }
}

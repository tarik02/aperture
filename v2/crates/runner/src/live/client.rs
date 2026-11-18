//! One client of the session: the session socket it speaks the live protocol on, the
//! target it watches, and the way that target's pixels reach it.

use aperture_compositor::{Button, Cursor, Input, Viewport, WindowId};
use axum::extract::ws::{Message as Frame, WebSocket};
use buffa::Message as _;
use tokio::sync::{broadcast, mpsc, watch};
use tracing::{debug, warn};

use super::{
    adapt::Delivery,
    encode::{self, Format, Quality},
    http::Live,
    rtc::{self, FromPeer},
    stream::{Key, Packet, Subscription},
    tiles,
};
use crate::proto::aperture::live::v1::{self as pb, client_message, server_message};

/// What a client's WebRTC connection has to tell that waits for its session socket's turn.
const CHANNEL_MESSAGES: usize = 256;

/// Serves the client until its socket closes or the session ends.
pub async fn serve(live: Live, socket: WebSocket) {
    let (tiles_watch, tiles) = tiles::start(live.compositor.clone());
    let (from_peer, peer_events) = mpsc::channel(CHANNEL_MESSAGES);
    let mut client = Client {
        cursor: live.compositor.cursor(),
        live,
        socket,
        greeted: false,
        json: false,
        pixels: pb::Pixels::PIXELS_UNSPECIFIED,
        selected: None,
        chosen: false,
        video: None,
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
                    FromPeer::Quality(quality) => self.send_status(Format::H264, quality).await?,
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
                        self.send_status(self.format, self.delivery.quality()).await?;
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
            }
        }
    }

    async fn handle(&mut self, message: client_message::Message) -> Result<(), axum::Error> {
        use client_message::Message;
        let input = match message {
            Message::Hello(hello) => {
                self.greeted = true;
                self.pixels = hello.pixels.as_known().unwrap_or_default();
                let wanted = hello
                    .formats
                    .iter()
                    .filter_map(|format| match format.as_known()? {
                        pb::VideoFormat::VIDEO_FORMAT_H264 => Some(Format::H264),
                        pb::VideoFormat::VIDEO_FORMAT_FULL_CHROMA => Some(Format::FullChroma),
                        pb::VideoFormat::VIDEO_FORMAT_UNSPECIFIED => None,
                    });
                let wanted: Vec<Format> = wanted.collect();
                // Finding out what encodes here takes a moment the first time.
                let made = tokio::task::spawn_blocking(move || {
                    wanted.into_iter().find(|format| encode::encodes(*format))
                });
                self.format = made.await.ok().flatten().unwrap_or(Format::H264);
                self.send_targets().await?;
                self.send_cursor().await?;
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
                self.live.compositor.set_viewport(Viewport {
                    width: viewport.width,
                    height: viewport.height,
                });
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
            },
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
            let window = self.selected.as_ref().map(|(_, window)| *window);
            // A connection that ended takes nothing; the client offers another.
            let _ = video.send(window).await;
        }
        self.next_frames = None;
        self.delivery.restart();
        self.frames = self.subscribe().await;
        self.request_keyframe();
        if self.frames.is_some() {
            // A socket that fails says so at the client's next message.
            let _ = self.send_status(self.format, self.delivery.quality()).await;
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
            self.send_status(self.format, quality).await
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

    async fn send_status(&mut self, format: Format, quality: Quality) -> Result<(), axum::Error> {
        let quality = match quality {
            Quality::Low => pb::VideoQuality::VIDEO_QUALITY_LOW,
            Quality::Medium => pb::VideoQuality::VIDEO_QUALITY_MEDIUM,
            Quality::Full => pb::VideoQuality::VIDEO_QUALITY_FULL,
        };
        let status = pb::VideoStatus {
            format: format_of(format).into(),
            quality: quality.into(),
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
                title: target.title.clone(),
                url: target.url.clone(),
                width: target.width,
                height: target.height,
                ..Default::default()
            })
            .collect();
        self.send(server_message::Message::Targets(Box::new(pb::Targets {
            targets,
            ..Default::default()
        })))
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
    }
}

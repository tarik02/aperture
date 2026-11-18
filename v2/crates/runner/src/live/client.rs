//! One client of the session: the session socket it speaks the live protocol on, the
//! target it watches, and the way that target's pixels reach it.

use aperture_compositor::{Button, Cursor, Input, Viewport, WindowId};
use axum::extract::ws::{Message as Frame, WebSocket};
use buffa::Message as _;
use tokio::sync::{broadcast, mpsc, watch};
use tracing::{debug, warn};

use super::{
    http::Live,
    rtc,
    stream::{Packet, Subscription},
    tiles,
};
use crate::proto::aperture::live::v1::{self as pb, client_message, server_message};

/// Messages from a client's data channels that wait for its session socket's turn.
const CHANNEL_MESSAGES: usize = 256;

/// Serves the client until its socket closes or the session ends.
pub async fn serve(live: Live, socket: WebSocket) {
    let (tiles_watch, tiles) = tiles::start(live.compositor.clone());
    let (from_channels, channel_messages) = mpsc::channel(CHANNEL_MESSAGES);
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
        frames: None,
        awaits_keyframe: false,
        tiles_watch,
        from_channels,
    };
    if let Err(err) = client.run(tiles, channel_messages).await {
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
    /// The watched target's video, for a client that takes it as frames.
    frames: Option<Subscription>,
    /// Frames were missed, and those that follow build on them: none is sent before the
    /// next keyframe.
    awaits_keyframe: bool,
    tiles_watch: watch::Sender<tiles::Watched>,
    from_channels: mpsc::Sender<client_message::Message>,
}

impl Client {
    async fn run(
        &mut self,
        mut tiles: mpsc::Receiver<pb::Tile>,
        mut channel_messages: mpsc::Receiver<client_message::Message>,
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
                Some(message) = channel_messages.recv() => self.handle(message).await?,
                Some(tile) = tiles.recv() => {
                    self.send(server_message::Message::Tile(Box::new(tile))).await?;
                }
                packet = rtc::next_packet(&mut self.frames) => match packet {
                    Ok(packet) => self.send_frame(&packet).await?,
                    Err(broadcast::error::RecvError::Lagged(_)) => self.request_keyframe(),
                    // The window closed; the targets say what the client watches next.
                    Err(broadcast::error::RecvError::Closed) => self.frames = None,
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
            | Message::RtcOffer(_) => {
                return Ok(());
            }
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
            self.from_channels.clone(),
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
        self.frames = match &self.selected {
            Some((_, window)) if self.pixels == pb::Pixels::PIXELS_FRAMES => {
                self.live.streams.subscribe(*window).await.ok()
            }
            _ => None,
        };
        self.request_keyframe();
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

    fn request_keyframe(&mut self) {
        if let Some(frames) = &self.frames {
            self.awaits_keyframe = true;
            frames.keyframe();
        }
    }

    async fn send_frame(&mut self, packet: &Packet) -> Result<(), axum::Error> {
        if self.awaits_keyframe && !packet.keyframe {
            return Ok(());
        }
        self.awaits_keyframe = false;
        let Some((target, _)) = &self.selected else {
            return Ok(());
        };
        let frame = pb::VideoFrame {
            target: target.clone(),
            keyframe: packet.keyframe,
            time_us: packet.time.as_micros() as u64,
            data: packet.data.clone(),
            ..Default::default()
        };
        self.send(server_message::Message::VideoFrame(Box::new(frame)))
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

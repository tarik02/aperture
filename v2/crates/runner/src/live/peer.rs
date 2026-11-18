//! One client's WebRTC connection: a video track that shows the target the client selected,
//! and the data channels the live protocol runs on.
//!
//! The client offers, with one video track to receive and its channels; the session answers
//! as ICE-lite with host candidates only (see [`net`](super::net)). The video is the
//! target's one stream (see [`stream`](super::stream)), which every client of it shares.

use std::{sync::Arc, time::Instant};

use aperture_compositor::{Button, Cursor, Handle, Input, Viewport, WindowId};
use aperture_runner::PortRange;
use buffa::Message as _;
use str0m::{
    Event, IceConnectionState, Input as RtcInput, Output, Rtc, RtcError,
    change::SdpOffer,
    channel::ChannelId,
    format::Codec,
    media::{Frequency, MediaKind, MediaTime, Mid},
    net::{Protocol, Receive},
};
use tokio::sync::{broadcast, watch};
use tracing::{info, warn};

use super::{
    net::{Datagram, Sockets},
    stream::{Packet, Streams, Subscription},
};
use crate::{
    proto::aperture::live::v1::{self as pb, client_message, server_message},
    targets::Target,
};

/// Payload type of the only video codec offered: H.264 constrained baseline, the profile
/// every browser decodes.
const H264_PT: u8 = 108;
const H264_RTX_PT: u8 = 109;
const H264_PROFILE_LEVEL_ID: u32 = 0x42e01f;

/// The channel the session's messages go out on.
const CONTROL_CHANNEL: &str = "control";

#[derive(Debug, thiserror::Error)]
pub enum ConnectError {
    #[error("invalid offer: {0}")]
    Offer(String),
    #[error("no local address for WebRTC")]
    NoAddress,
    #[error(transparent)]
    Rtc(#[from] RtcError),
}

/// Answers a client's offer and runs its connection until it ends.
pub async fn connect(
    compositor: Handle,
    streams: Arc<Streams>,
    targets: watch::Receiver<Vec<Target>>,
    ports: Option<PortRange>,
    offer: &str,
) -> Result<String, ConnectError> {
    let mut config = Rtc::builder().set_ice_lite(true).clear_codecs();
    config.codec_config().add_h264(
        H264_PT.into(),
        Some(H264_RTX_PT.into()),
        true,
        H264_PROFILE_LEVEL_ID,
    );
    let mut rtc = config.build(Instant::now());

    let (sockets, candidates) = Sockets::bind(ports).await;
    if candidates.is_empty() {
        return Err(ConnectError::NoAddress);
    }
    for candidate in candidates {
        rtc.add_local_candidate(candidate);
    }
    let offer =
        SdpOffer::from_sdp_string(offer).map_err(|err| ConnectError::Offer(err.to_string()))?;
    let answer = rtc.sdp_api().accept_offer(offer)?;

    let mut peer = Peer {
        rtc,
        sockets,
        targets,
        cursor: compositor.cursor(),
        compositor,
        video: None,
        control: None,
        greeted: false,
        json: false,
        connected: false,
        selected: None,
        chosen: false,
        streams,
        video_feed: None,
    };
    tokio::spawn(async move {
        match peer.run().await {
            Ok(()) => info!("webrtc peer closed"),
            Err(err) => info!(%err, "webrtc peer failed"),
        }
    });
    Ok(answer.to_sdp_string())
}

struct Peer {
    rtc: Rtc,
    sockets: Sockets,
    compositor: Handle,
    targets: watch::Receiver<Vec<Target>>,
    cursor: watch::Receiver<Cursor>,
    /// The client's video track, once it is known.
    video: Option<Mid>,
    control: Option<ChannelId>,
    /// The client said hello.
    greeted: bool,
    /// The client's last message came as JSON text.
    json: bool,
    connected: bool,
    /// The target the client's video shows, and the window that shows the target.
    selected: Option<(String, WindowId)>,
    /// The client selected a target itself; until then the newest one shows.
    chosen: bool,
    streams: Arc<Streams>,
    /// The selected target's stream.
    video_feed: Option<Subscription>,
}

impl Peer {
    async fn run(&mut self) -> Result<(), RtcError> {
        loop {
            let deadline = self.drive().await?;
            if !self.rtc.is_alive() {
                return Ok(());
            }
            tokio::select! {
                () = tokio::time::sleep_until(deadline.into()) => {
                    self.rtc.handle_input(RtcInput::Timeout(Instant::now()))?;
                }
                datagram = self.sockets.recv() => {
                    let Some(datagram) = datagram else { return Ok(()) };
                    self.receive(datagram)?;
                }
                packet = next_packet(&mut self.video_feed) => match packet {
                    Ok(packet) => self.write(&packet)?,
                    // Frames were missed, and those that follow build on them.
                    Err(broadcast::error::RecvError::Lagged(_)) => self.request_keyframe(),
                    // The window closed; the targets say what shows next.
                    Err(broadcast::error::RecvError::Closed) => self.video_feed = None,
                },
                changed = self.targets.changed() => {
                    // The session ended.
                    if changed.is_err() {
                        return Ok(());
                    }
                    self.send_targets()?;
                    self.select(None).await?;
                }
                changed = self.cursor.changed() => {
                    if changed.is_err() {
                        return Ok(());
                    }
                    self.send_cursor()?;
                }
            }
        }
    }

    /// Handles everything str0m has to say until it wants to be woken at a deadline.
    async fn drive(&mut self) -> Result<Instant, RtcError> {
        loop {
            match self.rtc.poll_output()? {
                Output::Timeout(deadline) => return Ok(deadline),
                Output::Transmit(transmit) => {
                    self.sockets
                        .send(transmit.source, transmit.destination, &transmit.contents)
                        .await;
                }
                Output::Event(event) => self.handle_event(event).await?,
            }
        }
    }

    async fn handle_event(&mut self, event: Event) -> Result<(), RtcError> {
        match event {
            Event::Connected => {
                info!("webrtc peer connected");
                self.connected = true;
                self.request_keyframe();
            }
            Event::IceConnectionStateChange(IceConnectionState::Disconnected) => {
                self.rtc.disconnect();
            }
            Event::MediaAdded(media) if media.kind == MediaKind::Video => {
                self.video = Some(media.mid);
            }
            Event::KeyframeRequest(_) => self.request_keyframe(),
            Event::ChannelOpen(id, label) if label == CONTROL_CHANNEL => {
                self.control = Some(id);
            }
            Event::ChannelData(data) => {
                let message = if data.binary {
                    pb::ClientMessage::decode_from_slice(&data.data).map_err(|err| err.to_string())
                } else {
                    serde_json::from_slice::<pb::ClientMessage>(&data.data)
                        .map_err(|err| err.to_string())
                };
                match message.map(|envelope| envelope.message) {
                    Ok(Some(message)) => {
                        self.json = !data.binary;
                        self.handle_message(message).await?;
                    }
                    Ok(None) => {}
                    Err(reason) => warn!(%reason, "malformed client message"),
                }
            }
            _ => {}
        }
        Ok(())
    }

    async fn handle_message(&mut self, message: client_message::Message) -> Result<(), RtcError> {
        use client_message::Message;
        if let Message::Hello(_) = &message {
            self.greeted = true;
            self.send_targets()?;
            self.send_cursor()?;
            self.select(None).await?;
            return self.send_selected();
        }
        if let Message::Select(select) = &message {
            self.chosen = true;
            self.select(Some(&select.target)).await?;
            if let Some((_, window)) = self.selected {
                self.compositor.focus(window);
            }
            return Ok(());
        }
        if let Message::Viewport(viewport) = &message {
            self.compositor.set_viewport(Viewport {
                width: viewport.width,
                height: viewport.height,
            });
            return Ok(());
        }
        let Some((_, window)) = self.selected else {
            return Ok(());
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
            Message::Hello(_) | Message::Select(_) | Message::Viewport(_) => return Ok(()),
        };
        self.compositor.input(input);
        Ok(())
    }

    /// Settles which target the client's video shows: the one it asks for, else the one it
    /// has, else, and always until the client chose one, the newest. A target that moved to
    /// another window is followed there.
    async fn select(&mut self, wanted: Option<&str>) -> Result<(), RtcError> {
        let selected = {
            let targets = self.targets.borrow();
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
            return Ok(());
        }
        self.video_feed = match &selected {
            Some((_, window)) => self.streams.subscribe(*window).await.ok(),
            None => None,
        };
        self.selected = selected;
        self.send_selected()
    }

    fn send_targets(&mut self) -> Result<(), RtcError> {
        let targets = self
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
    }

    fn send_selected(&mut self) -> Result<(), RtcError> {
        self.send(server_message::Message::Selected(Box::new(pb::Selected {
            target: self.selected.as_ref().map(|(id, _)| id.clone()),
            ..Default::default()
        })))
    }

    fn send_cursor(&mut self) -> Result<(), RtcError> {
        let cursor = match &*self.cursor.borrow_and_update() {
            Cursor::Hidden => pb::cursor::Cursor::Hidden(Box::default()),
            Cursor::Named(name) => pb::cursor::Cursor::Named((*name).to_owned()),
        };
        self.send(server_message::Message::Cursor(Box::new(pb::Cursor {
            cursor: Some(cursor),
            ..Default::default()
        })))
    }

    /// Nothing is sent before the client's hello, which tells the encoding it reads; what
    /// it needs to know by then is sent in answer to it.
    fn send(&mut self, message: server_message::Message) -> Result<(), RtcError> {
        if !self.greeted {
            return Ok(());
        }
        let Some(mut channel) = self.control.and_then(|id| self.rtc.channel(id)) else {
            return Ok(());
        };
        let envelope = pb::ServerMessage {
            message: Some(message),
            ..Default::default()
        };
        if self.json {
            match serde_json::to_vec(&envelope) {
                Ok(data) => channel.write(false, &data)?,
                Err(err) => {
                    warn!(%err, "failed to encode a message");
                    false
                }
            };
        } else {
            channel.write(true, &envelope.encode_to_vec())?;
        }
        Ok(())
    }

    fn receive(&mut self, datagram: Datagram) -> Result<(), RtcError> {
        let Ok(contents) = datagram.data.as_slice().try_into() else {
            return Ok(());
        };
        self.rtc.handle_input(RtcInput::Receive(
            Instant::now(),
            Receive {
                proto: Protocol::Udp,
                source: datagram.source,
                destination: datagram.destination,
                contents,
            },
        ))
    }

    fn request_keyframe(&self) {
        if let Some(feed) = &self.video_feed {
            feed.keyframe();
        }
    }

    fn write(&mut self, packet: &Packet) -> Result<(), RtcError> {
        if !self.connected {
            return Ok(());
        }
        let Some(writer) = self.video.and_then(|mid| self.rtc.writer(mid)) else {
            return Ok(());
        };
        let Some(pt) = writer
            .payload_params()
            .find(|params| params.spec().codec == Codec::H264)
            .map(|params| params.pt())
        else {
            return Ok(());
        };
        let rate = Frequency::NINETY_KHZ;
        let ticks = packet.time.as_nanos() * u128::from(rate.get()) / 1_000_000_000;
        writer.write(
            pt,
            Instant::now(),
            MediaTime::new(ticks as u64, rate),
            packet.data.clone(),
        )
    }
}

/// The next frame of the stream; never, without one.
async fn next_packet(
    feed: &mut Option<Subscription>,
) -> Result<Arc<Packet>, broadcast::error::RecvError> {
    match feed {
        Some(feed) => feed.packets.recv().await,
        None => std::future::pending().await,
    }
}

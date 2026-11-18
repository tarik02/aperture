//! A client's WebRTC connection: a video track that shows the target the client watches,
//! and, if the client opens any, data channels it sends its messages on.
//!
//! The client offers, with one video track to receive; the session answers as ICE-lite
//! with host candidates only (see [`net`](super::net)). The video is the target's one
//! stream (see [`stream`](super::stream)), which every client of it shares.

use std::{sync::Arc, time::Instant};

use aperture_compositor::WindowId;
use aperture_runner::PortRange;
use buffa::Message as _;
use str0m::{
    Event, IceConnectionState, Input as RtcInput, Output, Rtc, RtcError,
    change::SdpOffer,
    format::Codec,
    media::{Frequency, MediaKind, MediaTime, Mid},
    net::{Protocol, Receive},
};
use tokio::sync::{broadcast, mpsc};
use tracing::{info, warn};

use super::{
    net::{Datagram, Sockets},
    stream::{Packet, Streams, Subscription},
};
use crate::proto::aperture::live::v1::{self as pb, client_message};

/// Payload type of the only video codec offered: H.264 constrained baseline, the profile
/// every browser decodes.
const H264_PT: u8 = 108;
const H264_RTX_PT: u8 = 109;
const H264_PROFILE_LEVEL_ID: u32 = 0x42e01f;

#[derive(Debug, thiserror::Error)]
pub enum ConnectError {
    #[error("invalid offer: {0}")]
    Offer(String),
    #[error("no local address for WebRTC")]
    NoAddress,
    #[error(transparent)]
    Rtc(#[from] RtcError),
}

/// The window whose video the connection carries; none for no video.
pub type Watch = mpsc::Sender<Option<WindowId>>;

/// Answers a client's offer and runs its connection until it ends or `Watch` is dropped.
/// Messages the client sends on data channels go to `messages`.
pub async fn connect(
    streams: Arc<Streams>,
    ports: Option<PortRange>,
    offer: &str,
    messages: mpsc::Sender<client_message::Message>,
) -> Result<(String, Watch), ConnectError> {
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

    let (watch, watched) = mpsc::channel(4);
    let mut peer = Peer {
        rtc,
        sockets,
        streams,
        video: None,
        connected: false,
        feed: None,
        watched,
        messages,
    };
    tokio::spawn(async move {
        match peer.run().await {
            Ok(()) => info!("webrtc peer closed"),
            Err(err) => info!(%err, "webrtc peer failed"),
        }
    });
    Ok((answer.to_sdp_string(), watch))
}

struct Peer {
    rtc: Rtc,
    sockets: Sockets,
    streams: Arc<Streams>,
    /// The client's video track, once it is known.
    video: Option<Mid>,
    connected: bool,
    /// The watched window's stream.
    feed: Option<Subscription>,
    watched: mpsc::Receiver<Option<WindowId>>,
    messages: mpsc::Sender<client_message::Message>,
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
                packet = next_packet(&mut self.feed) => match packet {
                    Ok(packet) => self.write(&packet)?,
                    // Frames were missed, and those that follow build on them.
                    Err(broadcast::error::RecvError::Lagged(_)) => self.request_keyframe(),
                    // The window closed; the client is told what it watches next.
                    Err(broadcast::error::RecvError::Closed) => self.feed = None,
                },
                watched = self.watched.recv() => match watched {
                    Some(Some(window)) => self.feed = self.streams.subscribe(window).await.ok(),
                    Some(None) => self.feed = None,
                    // The client's session ended.
                    None => return Ok(()),
                },
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
                Output::Event(event) => self.handle_event(event),
            }
        }
    }

    fn handle_event(&mut self, event: Event) {
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
            Event::ChannelData(data) => {
                let message = if data.binary {
                    pb::ClientMessage::decode_from_slice(&data.data).map_err(|err| err.to_string())
                } else {
                    serde_json::from_slice::<pb::ClientMessage>(&data.data)
                        .map_err(|err| err.to_string())
                };
                match message.map(|envelope| envelope.message) {
                    // A session that takes no more is one that is ending.
                    Ok(Some(message)) => drop(self.messages.try_send(message)),
                    Ok(None) => {}
                    Err(reason) => warn!(%reason, "malformed client message"),
                }
            }
            _ => {}
        }
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
        if let Some(feed) = &self.feed {
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
pub(super) async fn next_packet(
    feed: &mut Option<Subscription>,
) -> Result<Arc<Packet>, broadcast::error::RecvError> {
    match feed {
        Some(feed) => feed.packets.recv().await,
        None => std::future::pending().await,
    }
}

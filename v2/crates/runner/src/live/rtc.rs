//! A client's WebRTC connection: a video track that shows the target the client watches,
//! and, if the client opens any, data channels it sends its messages on.
//!
//! The client offers, with one video track to receive; the session answers as ICE-lite
//! with host candidates only (see [`net`](super::net)). The video is the target's one
//! stream (see [`stream`](super::stream)), which every client of it shares.

use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use aperture_compositor::WindowId;
use aperture_runner::PortRange;
use buffa::Message as _;
use str0m::{
    Event, IceConnectionState, Input as RtcInput, Output, Rtc, RtcError,
    change::SdpOffer,
    format::{Codec, FormatParams},
    media::{Frequency, MediaKind, MediaTime, Mid, Pt},
    net::{Protocol, Receive},
};
use tokio::sync::{broadcast, mpsc};
use tracing::{info, warn};

use super::{
    adapt::Reported,
    encode::{Format, Quality},
    net::{Datagram, Sockets},
    stream::{Key, Packet, Streams, Subscription},
};
use crate::proto::aperture::live::v1::{self as pb, client_message};

/// The payload types of the codecs a connection may carry, each followed by the one of
/// its retransmissions. H.264 is constrained baseline, the profile every browser decodes.
const H264_PT: u8 = 108;
const H264_PROFILE_LEVEL_ID: u32 = 0x42e01f;
const H265_PT: u8 = 110;
const VP9_PT: u8 = 98;
const VP9_FULL_CHROMA_PT: u8 = 100;
const AV1_PT: u8 = 45;

/// The codec that carries a format over WebRTC, and its VP9 profile; none for a format
/// WebRTC does not carry.
fn codec_of(format: Format) -> Option<(Codec, Option<u32>)> {
    match format {
        Format::H264 => Some((Codec::H264, None)),
        Format::FullChroma => None,
        Format::H265 => Some((Codec::H265, None)),
        Format::Vp9 => Some((Codec::Vp9, Some(0))),
        Format::Vp9FullChroma => Some((Codec::Vp9, Some(1))),
        Format::Av1 => Some((Codec::Av1, None)),
    }
}

/// How often the connection tells what the client reported of the link.
const STATS_EVERY: Duration = Duration::from_secs(1);
/// How often the link is looked at.
const SETTLE_EVERY: Duration = Duration::from_millis(250);

/// What a client's connection tells its session.
pub enum FromPeer {
    /// A message the client sent on a data channel.
    Message(client_message::Message),
    /// The video from now on.
    Stream(Key),
}

#[derive(Debug, thiserror::Error)]
pub enum ConnectError {
    #[error("invalid offer: {0}")]
    Offer(String),
    #[error("no local address for WebRTC")]
    NoAddress,
    #[error(transparent)]
    Rtc(#[from] RtcError),
}

/// What a connection's video shows.
#[derive(Debug, Clone, PartialEq)]
pub struct Watched {
    /// None for no video.
    pub window: Option<WindowId>,
    /// The quality whatever the link carries; by the link with none.
    pub quality: Option<Quality>,
    /// Frames a second at most; the quality's own with none.
    pub fps: Option<u32>,
    /// The forms of video the client would have, the one it would rather have first;
    /// the first one the connection takes is sent, H.264 when none is.
    pub formats: Vec<Format>,
}

pub type Watch = mpsc::Sender<Watched>;

/// Answers a client's offer and runs its connection until it ends or `Watch` is dropped.
/// What the connection has to tell goes to `events`.
pub async fn connect(
    streams: Arc<Streams>,
    ports: Option<PortRange>,
    offer: &str,
    events: mpsc::Sender<FromPeer>,
) -> Result<(String, Watch), ConnectError> {
    let mut config = Rtc::builder()
        .set_ice_lite(true)
        .set_stats_interval(Some(STATS_EVERY))
        .clear_codecs();
    let codecs = config.codec_config();
    codecs.add_h264(
        H264_PT.into(),
        Some((H264_PT + 1).into()),
        true,
        H264_PROFILE_LEVEL_ID,
    );
    // Main profile, main tier, level 5.1.
    codecs.add_h265(H265_PT.into(), Some((H265_PT + 1).into()), 1, 0, 153);
    for (pt, profile) in [(VP9_PT, 0), (VP9_FULL_CHROMA_PT, 1)] {
        codecs.add_config(
            pt.into(),
            Some((pt + 1).into()),
            Codec::Vp9,
            Frequency::NINETY_KHZ,
            None,
            FormatParams {
                profile_id: Some(profile),
                ..Default::default()
            },
        );
    }
    codecs.add_config(
        AV1_PT.into(),
        Some((AV1_PT + 1).into()),
        Codec::Av1,
        Frequency::NINETY_KHZ,
        None,
        FormatParams::default(),
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
        window: None,
        fps: None,
        formats: Vec::new(),
        reselect: false,
        link: Reported::new(),
        feed: None,
        next: None,
        awaits_keyframe: false,
        watched,
        events,
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
    window: Option<WindowId>,
    fps: Option<u32>,
    formats: Vec<Format>,
    /// The connection came to take video: the format is picked again.
    reselect: bool,
    /// What the link carries, and so the quality of the video.
    link: Reported,
    /// The watched window's stream.
    feed: Option<Subscription>,
    /// The stream of another quality that replaces `feed` once it has a keyframe, so that
    /// the picture does not stop for the change.
    next: Option<Subscription>,
    /// The stream changed to one whose frames build on ones the client never got: none is
    /// sent before the next keyframe.
    awaits_keyframe: bool,
    watched: mpsc::Receiver<Watched>,
    events: mpsc::Sender<FromPeer>,
}

impl Peer {
    async fn run(&mut self) -> Result<(), RtcError> {
        let mut settle = tokio::time::interval(SETTLE_EVERY);
        loop {
            let deadline = self.drive().await?;
            if !self.rtc.is_alive() {
                return Ok(());
            }
            if std::mem::take(&mut self.reselect) {
                let format = self.format();
                if self
                    .feed
                    .as_ref()
                    .is_some_and(|feed| feed.key.format != format)
                {
                    self.next = None;
                    self.feed = self.subscribe().await;
                    self.report();
                }
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
                _ = settle.tick() => {
                    if let Some(quality) = self.link.settle() {
                        info!(?quality, "webrtc peer changes quality");
                        // A better one takes over at its first keyframe; a lower one at
                        // once, since what it replaces is what the link does not carry.
                        if self.feed.as_ref().is_some_and(|feed| quality < feed.key.quality) {
                            self.next = None;
                            self.feed = self.subscribe().await;
                            self.awaits_keyframe = true;
                            self.report();
                        } else {
                            self.next = self.subscribe().await;
                        }
                    }
                }
                packet = next_packet(&mut self.next) => match packet {
                    Ok(packet) if packet.keyframe => {
                        self.feed = self.next.take();
                        self.awaits_keyframe = false;
                        self.report();
                        self.write(&packet)?;
                    }
                    Ok(_) => {}
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        if let Some(next) = &self.next {
                            next.keyframe();
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => self.next = None,
                },
                watched = self.watched.recv() => match watched {
                    Some(watched) => {
                        self.window = watched.window;
                        self.link.pin(watched.quality);
                        self.fps = watched.fps;
                        self.formats = watched.formats;
                        self.next = None;
                        self.feed = self.subscribe().await;
                        self.report();
                    }
                    // The client's session ended.
                    None => return Ok(()),
                },
            }
        }
    }

    /// The payload type the connection carries a format with, if it does.
    fn payload_type(&mut self, format: Format) -> Option<Pt> {
        let (codec, profile) = codec_of(format)?;
        let writer = self.rtc.writer(self.video?)?;
        writer
            .payload_params()
            .find(|params| {
                let spec = params.spec();
                spec.codec == codec && (profile.is_none() || spec.format.profile_id == profile)
            })
            .map(|params| params.pt())
    }

    /// The first format the client would have that the connection carries.
    fn format(&mut self) -> Format {
        let formats = self.formats.clone();
        formats
            .into_iter()
            .find(|format| self.payload_type(*format).is_some())
            .unwrap_or(Format::H264)
    }

    /// The watched window's stream at the quality the link carries.
    async fn subscribe(&mut self) -> Option<Subscription> {
        let key = Key {
            window: self.window?,
            format: self.format(),
            quality: self.link.quality(),
            fps: self.fps,
        };
        self.streams.subscribe(key).await.ok()
    }

    fn report(&self) {
        // A session that takes no more is one that is ending.
        if let Some(feed) = &self.feed {
            // A session that takes no more is one that is ending.
            let _ = self.events.try_send(FromPeer::Stream(feed.key));
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
                Output::Event(Event::MediaEgressStats(stats)) => {
                    self.link.report(stats.loss, stats.rtt);
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
                self.reselect = true;
                self.request_keyframe();
            }
            Event::IceConnectionStateChange(IceConnectionState::Disconnected) => {
                self.rtc.disconnect();
            }
            Event::MediaAdded(media) if media.kind == MediaKind::Video => {
                self.video = Some(media.mid);
                self.reselect = true;
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
                    Ok(Some(message)) => drop(self.events.try_send(FromPeer::Message(message))),
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
        if self.awaits_keyframe && !packet.keyframe {
            return Ok(());
        }
        self.awaits_keyframe = false;
        let format = self
            .feed
            .as_ref()
            .map_or(Format::H264, |feed| feed.key.format);
        let Some(pt) = self.payload_type(format) else {
            return Ok(());
        };
        let Some(writer) = self.video.and_then(|mid| self.rtc.writer(mid)) else {
            return Ok(());
        };
        let rate = Frequency::NINETY_KHZ;
        let ticks = packet.time.as_nanos() * u128::from(rate.get()) / 1_000_000_000;
        // Frames are to be shown as they come: one a player holds to smooth the picture is
        // one seen late.
        let at_once = MediaTime::new(0, rate);
        writer.playout_delay(at_once, at_once).write(
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

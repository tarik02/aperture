//! How the target a client watches reaches it: over its WebRTC connection, as frames on
//! its session socket, or as tiles.

use aperture_runner::Area;
use tracing::warn;

use super::Client;
use crate::{
    live::{
        encode::{Format, Quality},
        rtc,
        stream::{Key, Packet, Subscription},
    },
    proto::aperture::live::v1::{self as pb, server_message},
};

impl Client {
    /// Answers the client's offer; the connection it makes replaces the one before it.
    pub(super) async fn connect_video(&mut self, offer: &str) -> Result<(), axum::Error> {
        let connected = rtc::connect(
            self.live.streams.clone(),
            self.live.rtc_ports,
            offer,
            self.from_peer.clone(),
            self.grant(Area::Sound)
                .read
                .then(|| self.live.sound.listen()),
        );
        match connected.await {
            Ok((sdp, video)) => {
                self.video = Some(video);
                self.show().await?;
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

    /// Points the client's pixels at the target it watches.
    pub(super) async fn show(&mut self) -> Result<(), axum::Error> {
        if let Some(video) = &self.video {
            let watched = rtc::Watched {
                window: self.selected.as_ref().map(|(_, window)| *window),
                quality: self.pinned,
                fps: self.fps,
                formats: self.formats.clone(),
                heard: self.heard(),
            };
            // A connection that ended takes nothing; the client offers another.
            let _ = video.send(watched).await;
        }
        self.next_frames = None;
        self.delivery.restart();
        self.frames = self.subscribe().await;
        self.request_keyframe();
        if let Some(frames) = &self.frames {
            self.send_status(frames.key).await?;
        }
        let tiles = self
            .selected
            .as_ref()
            .filter(|_| self.pixels == pb::Pixels::PIXELS_TILES)
            .and_then(|(_, window)| Some((self.tab()?, *window)));
        self.tiles_watch.send_if_modified(|watched| {
            let changed = *watched != tiles;
            *watched = tiles;
            changed
        });
        Ok(())
    }

    /// The watched target's frames at the quality the link carries; none for a client
    /// that does not take frames.
    pub(super) async fn subscribe(&mut self) -> Option<Subscription> {
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
        match self.live.streams.subscribe(key).await {
            Ok(frames) => Some(frames),
            Err(err) => {
                warn!(%err, "a client gets no frames of the target it watches");
                None
            }
        }
    }

    /// Changes the quality of the frames. A better one takes over at its first keyframe,
    /// which is when the client is told; a lower one at once, since what it replaces is what the link does not carry.
    pub(super) async fn take_quality(&mut self, quality: Quality) -> Result<(), axum::Error> {
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

    pub(super) fn request_keyframe(&mut self) {
        if let Some(frames) = &self.frames {
            self.awaits_keyframe = true;
            frames.keyframe();
        }
    }

    pub(super) async fn send_frame(&mut self, packet: &Packet) -> Result<(), axum::Error> {
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
        let Some(tab) = self.tab() else {
            return Ok(());
        };
        let time_us = packet.time.as_micros() as u64;
        let frame = pb::VideoFrame {
            tab,
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

    pub(super) async fn send_status(&mut self, key: Key) -> Result<(), axum::Error> {
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
}

pub(super) fn format_of(format: Format) -> pb::VideoFormat {
    match format {
        Format::H264 => pb::VideoFormat::VIDEO_FORMAT_H264,
        Format::FullChroma => pb::VideoFormat::VIDEO_FORMAT_FULL_CHROMA,
        Format::H265 => pb::VideoFormat::VIDEO_FORMAT_H265,
        Format::Vp9 => pb::VideoFormat::VIDEO_FORMAT_VP9,
        Format::Vp9FullChroma => pb::VideoFormat::VIDEO_FORMAT_VP9_FULL_CHROMA,
        Format::Av1 => pb::VideoFormat::VIDEO_FORMAT_AV1,
    }
}

pub(super) fn format_from(format: pb::VideoFormat) -> Option<Format> {
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

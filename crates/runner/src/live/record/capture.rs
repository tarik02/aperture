//! The raw video of a recording: the target's stream and its tab's sound, written into a
//! Matroska file as they come.

use std::{path::Path, sync::Arc, time::Duration};

use anyhow::{Context, bail};
use aperture_compositor::{Handle, Pixels};
use gstreamer::{self as gst, prelude::*};
use gstreamer_app as gst_app;
use tokio::{
    sync::{broadcast, mpsc, oneshot},
    time::timeout,
};

use super::Journal;
use crate::live::{
    edit::plan::Segment,
    encode,
    sound::{self, Sound},
    stream::{Packet, Subscription},
};

/// How long the last frame gets to come when a recording is stopped.
const LAST_FRAME_WITHIN: Duration = Duration::from_secs(1);
const FINISH_WITHIN: gst::ClockTime = gst::ClockTime::from_seconds(10);

/// What the raw video turned out to be.
pub(super) struct Raw {
    pub duration: Duration,
    /// When its frames that showed a change came, in its own time.
    pub changed_at_ms: Vec<i64>,
    /// The sizes its picture has, each from when it has it.
    pub segments: Vec<Segment>,
}

/// The sound of the tab a recording is of.
pub(super) struct Heard {
    pub packets: sound::Listener,
    /// What the packets are stamped by, and what the video's are.
    pub clock: Arc<Sound>,
    pub compositor: Handle,
}

/// A tab for a recording to be of, or to go on with.
pub(super) struct Moved {
    pub subscription: Subscription,
    /// What counts how much of the tab's picture changes, for as long as it is kept.
    pub pixels: Pixels,
    pub tab: i64,
}

/// An Opus packet that plays as silence.
const SILENCE: [u8; 3] = [0xf8, 0xff, 0xfe];

/// How far behind the present the file's sound is left open for a packet that is on its
/// way, and how often what stayed empty is filled with silence.
const SOUND_BEHIND: Duration = Duration::from_millis(200);
const SOUND_FILL_EVERY: Duration = Duration::from_millis(200);

/// Writes the stream from its next keyframe until told to stop, or until the target's
/// window closes. The journal is told when the video starts. A tab that comes on `moved`
/// is what is written from its next keyframe on, at whatever size its picture has.
pub(super) async fn record(
    on: Moved,
    mut heard: Heard,
    writer: Writer,
    mut stopped: oneshot::Receiver<()>,
    mut moved: mpsc::UnboundedReceiver<Moved>,
    journal: Arc<Journal>,
    motion_threshold: f64,
) -> anyhow::Result<Raw> {
    let Moved {
        mut subscription,
        mut pixels,
        mut tab,
    } = on;
    let mut first = None;
    let mut last = Duration::ZERO;
    let mut changed_at_ms = Vec::new();
    let mut segments: Vec<Segment> = Vec::new();
    // Until a keyframe comes, at the start and after frames were missed, nothing that
    // comes can be decoded.
    let mut decodable = false;
    let mut write = |packet: &Packet, decodable: &mut bool| -> anyhow::Result<()> {
        *decodable |= packet.keyframe;
        if !*decodable {
            return Ok(());
        }
        let began = *first.get_or_insert(packet.time);
        // Set by the first frame, and the same after.
        let _ = journal.start.set(began);
        // Never back in time: a tab the recording went on with may have drawn the picture
        // it has before the tab that was left drew its last, and a file takes no frame
        // that is earlier than the one before it.
        last = last.max(packet.time.saturating_sub(began));
        let (width, height) = packet.size;
        if segments.last().map(|last| (last.width, last.height)) != Some(packet.size) {
            segments.push(Segment {
                at_ms: last.as_millis() as i64,
                width,
                height,
            });
        }
        // Something happened where enough of the picture changed.
        let whole = f64::from(packet.size.0) * f64::from(packet.size.1);
        if packet.changed > 0 && packet.changed as f64 >= whole * motion_threshold {
            changed_at_ms.push(last.as_millis() as i64);
        }
        writer.write(packet, last)
    };
    let samples = u64::from(sound::RATE) * sound::PACKET.as_millis() as u64 / 1000;
    let in_samples = |time: Duration| time.as_micros() as u64 * u64::from(sound::RATE) / 1_000_000;
    // The sound's time at the video's start, once it started, and how far the file's
    // sound reaches, in samples of the video's time. The file's sound has no holes: the
    // file is written as far as both of its tracks reach.
    let mut sound_start = None;
    let mut sound_end = 0;
    let silence_until = |end: u64, sound_end: &mut u64| -> anyhow::Result<()> {
        while *sound_end + samples <= end {
            writer.play(&SILENCE, *sound_end)?;
            *sound_end += samples;
        }
        Ok(())
    };
    let mut fill = tokio::time::interval(SOUND_FILL_EVERY);
    loop {
        tokio::select! {
            packet = subscription.packets.recv() => match packet {
                Ok(packet) => {
                    write(&packet, &mut decodable)?;
                    if decodable && sound_start.is_none() {
                        // The frame is of a moment ago.
                        let ago = heard.compositor.elapsed().saturating_sub(packet.time);
                        sound_start = Some(heard.clock.now().saturating_sub(in_samples(ago)));
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    decodable = false;
                    subscription.keyframe();
                }
                Err(broadcast::error::RecvError::Closed) => break,
            },
            Some(to) = moved.recv() => {
                subscription = to.subscription;
                pixels = to.pixels;
                tab = to.tab;
                decodable = false;
                subscription.keyframe();
            }
            packet = heard.packets.next(Some(tab)) => {
                // What was missed is silence; what came before the video is left out.
                let at = packet.ok().zip(sound_start).and_then(|(packet, start)| {
                    Some((packet.at.checked_sub(start)?, packet))
                });
                if let Some((at, packet)) = at {
                    silence_until(at, &mut sound_end)?;
                    writer.play(&packet.data, sound_end)?;
                    sound_end += samples;
                }
            }
            _ = fill.tick() => {
                if let Some(start) = sound_start {
                    let open = heard.clock.now().saturating_sub(start + in_samples(SOUND_BEHIND));
                    silence_until(open, &mut sound_end)?;
                }
            }
            _ = &mut stopped => {
                // A window at rest sent its last frame long ago: one more, stamped now,
                // makes the recording last until now.
                subscription.keyframe();
                let latest = async {
                    loop {
                        match subscription.packets.recv().await {
                            Ok(packet) if packet.keyframe => return Some(packet),
                            Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                            Err(broadcast::error::RecvError::Closed) => return None,
                        }
                    }
                };
                if let Ok(Some(packet)) = timeout(LAST_FRAME_WITHIN, latest).await {
                    write(&packet, &mut decodable)?;
                }
                break;
            }
        }
    }
    if first.is_none() {
        bail!("the target showed nothing while it was recorded");
    }
    silence_until(in_samples(last), &mut sound_end)?;
    drop(pixels);
    tokio::task::spawn_blocking(move || writer.finish()).await??;
    Ok(Raw {
        duration: last,
        changed_at_ms,
        segments,
    })
}

/// A Matroska file being written.
pub(super) struct Writer {
    pipeline: gst::Pipeline,
    src: gst_app::AppSrc,
    sound: gst_app::AppSrc,
}

impl Writer {
    pub fn new(path: &Path) -> anyhow::Result<Self> {
        encode::init()?;
        let pipeline = gst::Pipeline::new();
        let src = gst_app::AppSrc::builder()
            .format(gst::Format::Time)
            .caps(
                &gst::Caps::builder("video/x-h264")
                    .field("stream-format", "byte-stream")
                    .field("alignment", "au")
                    .build(),
            )
            .build();
        let parse = gst::ElementFactory::make("h264parse").build()?;
        // With its parameters in the stream itself, not beside it: only such a video may
        // change its size once the file's header is written.
        let framed = gst::ElementFactory::make("capsfilter")
            .property(
                "caps",
                gst::Caps::builder("video/x-h264")
                    .field("stream-format", "avc3")
                    .build(),
            )
            .build()?;
        let mux = gst::ElementFactory::make("matroskamux").build()?;
        let sink = gst::ElementFactory::make("filesink")
            .property("location", path.to_str().context("the path is not UTF-8")?)
            .build()?;
        let sound = gst_app::AppSrc::builder()
            .format(gst::Format::Time)
            .caps(
                &gst::Caps::builder("audio/x-opus")
                    .field("rate", sound::RATE as i32)
                    .field("channels", 2)
                    .field("channel-mapping-family", 0)
                    .field("stream-count", 1)
                    .field("coupled-count", 1)
                    .build(),
            )
            .build();
        pipeline.add_many([
            src.upcast_ref(),
            &parse,
            &framed,
            &mux,
            &sink,
            sound.upcast_ref(),
        ])?;
        gst::Element::link_many([src.upcast_ref(), &parse, &framed, &mux, &sink])?;
        // By name: left to choose, the muxer takes it for another picture.
        let into = mux
            .request_pad_simple("audio_%u")
            .context("the muxer takes no sound")?;
        sound
            .static_pad("src")
            .context("the sound has no pad")?
            .link(&into)?;
        pipeline
            .set_state(gst::State::Playing)
            .context("failed to start writing the recording")?;
        Ok(Self {
            pipeline,
            src,
            sound,
        })
    }

    /// Writes an Opus packet that plays after `at` samples of the video.
    fn play(&self, data: &[u8], at: u64) -> anyhow::Result<()> {
        let rate = u64::from(sound::RATE);
        let mut buffer = gst::Buffer::from_slice(data.to_vec());
        {
            let buffer = buffer.get_mut().expect("the buffer was just made");
            buffer.set_pts(gst::ClockTime::from_nseconds(at * 1_000_000_000 / rate));
            buffer.set_duration(gst::ClockTime::from_nseconds(
                sound::PACKET.as_nanos() as u64
            ));
        }
        self.sound
            .push_buffer(buffer)
            .map_err(|err| anyhow::anyhow!("failed to write the sound: {err}"))?;
        Ok(())
    }

    fn write(&self, packet: &Packet, time: Duration) -> anyhow::Result<()> {
        let mut buffer = gst::Buffer::from_slice(packet.data.clone());
        {
            let buffer = buffer.get_mut().expect("the buffer was just made");
            buffer.set_pts(gst::ClockTime::from_nseconds(time.as_nanos() as u64));
            if !packet.keyframe {
                buffer.set_flags(gst::BufferFlags::DELTA_UNIT);
            }
        }
        self.src
            .push_buffer(buffer)
            .map_err(|err| anyhow::anyhow!("failed to write a frame: {err}"))?;
        Ok(())
    }

    /// Ends the file and waits until it is written out.
    fn finish(self) -> anyhow::Result<()> {
        for src in [&self.src, &self.sound] {
            src.end_of_stream()
                .map_err(|err| anyhow::anyhow!("failed to end the recording: {err}"))?;
        }
        let bus = self.pipeline.bus().context("the pipeline has no bus")?;
        let message = bus.timed_pop_filtered(
            FINISH_WITHIN,
            &[gst::MessageType::Eos, gst::MessageType::Error],
        );
        match message.as_ref().map(|message| message.view()) {
            Some(gst::MessageView::Eos(_)) => Ok(()),
            // The error names its kind; why is in what the element said beside it.
            Some(gst::MessageView::Error(err)) => match err.debug() {
                Some(why) => bail!("{} ({why})", err.error()),
                None => bail!("{}", err.error()),
            },
            _ => bail!("the recording was not written out in time"),
        }
    }
}

impl Drop for Writer {
    fn drop(&mut self) {
        // GStreamer leaks elements disposed outside NULL.
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

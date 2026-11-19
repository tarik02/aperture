//! The session's sound: what the browser plays, as Opus.
//!
//! The browser plays into a sound server of the session's own (PulseAudio), which has one
//! output that goes nowhere. What comes out of it is taken here and encoded once for
//! everyone who listens. It is the session's, not a tab's: the browser plays all of its
//! pages into the one output.

use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::Context;
use gstreamer::{self as gst, prelude::*};
use gstreamer_app as gst_app;
use tokio::sync::broadcast;
use tracing::{info, warn};

use super::encode;

/// The name of the server's output, which the browser plays into.
pub const OUTPUT: &str = "aperture";

/// Samples a second, and how long a packet is: what Opus and WebRTC take.
pub const RATE: u32 = 48_000;
pub const PACKET: Duration = Duration::from_millis(20);

/// Packets kept for a listener that falls behind; one that falls further misses some.
const BACKLOG: usize = 64;

/// One Opus packet.
pub struct Packet {
    pub data: Vec<u8>,
    /// How many samples came before it.
    pub at: u64,
}

pub struct Sound {
    /// The sound server's socket.
    server: PathBuf,
    packets: broadcast::Sender<Arc<Packet>>,
    /// The encoding runs: it starts with the first listener and goes on from there.
    running: Mutex<bool>,
}

impl Sound {
    pub fn new(server: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            server,
            packets: broadcast::Sender::new(BACKLOG),
            running: Mutex::new(false),
        })
    }

    /// The sound from now on.
    pub fn listen(self: &Arc<Self>) -> broadcast::Receiver<Arc<Packet>> {
        let listener = self.packets.subscribe();
        let mut running = self.running.lock().expect("not poisoned");
        if !*running {
            *running = true;
            let sound = self.clone();
            std::thread::spawn(move || {
                if let Err(err) = sound.encode() {
                    warn!("the session has no sound: {err:#}");
                }
                *sound.running.lock().expect("not poisoned") = false;
            });
        }
        listener
    }

    /// Takes what the server's output plays and sends it on as Opus, until that fails.
    fn encode(&self) -> anyhow::Result<()> {
        encode::init()?;
        let milliseconds = PACKET.as_millis();
        let description = format!(
            "pulsesrc server=unix:{server} device={OUTPUT}.monitor client-name=aperture \
                buffer-time=40000 latency-time=10000 \
            ! audio/x-raw,rate={RATE},channels=2 \
            ! audioconvert \
            ! opusenc frame-size={milliseconds} bitrate=96000 inband-fec=true \
            ! appsink name=sink sync=false max-buffers=8 drop=true",
            server = self.server.display(),
        );
        let pipeline = gst::parse::launch(&description)?
            .downcast::<gst::Pipeline>()
            .map_err(|_| anyhow::anyhow!("not a pipeline"))?;
        let sink = pipeline
            .by_name("sink")
            .and_then(|element| element.downcast::<gst_app::AppSink>().ok())
            .context("no appsink")?;
        pipeline
            .set_state(gst::State::Playing)
            .context("failed to take the sound server's output")?;
        info!("encoding the session's sound");
        let samples = u64::from(RATE) * milliseconds as u64 / 1000;
        let mut at = 0;
        let ended = loop {
            let Ok(sample) = sink.pull_sample() else {
                let bus = pipeline.bus().context("a pipeline without a bus")?;
                let failed =
                    std::iter::from_fn(|| bus.pop()).find_map(|message| match message.view() {
                        gst::MessageView::Error(err) => Some(err.error().to_string()),
                        _ => None,
                    });
                break failed.unwrap_or_else(|| "the sound ended".to_owned());
            };
            let Some(data) = sample
                .buffer()
                .and_then(|buffer| buffer.map_readable().ok())
            else {
                continue;
            };
            // Nobody listening right now is fine.
            let _ = self.packets.send(Arc::new(Packet {
                data: data.to_vec(),
                at,
            }));
            at += samples;
        };
        // GStreamer leaks elements disposed outside NULL.
        let _ = pipeline.set_state(gst::State::Null);
        anyhow::bail!(ended)
    }
}

/// The next packet of the sound; never, without any.
pub async fn next(
    sound: &mut Option<broadcast::Receiver<Arc<Packet>>>,
) -> Result<Arc<Packet>, broadcast::error::RecvError> {
    match sound {
        Some(sound) => sound.recv().await,
        None => std::future::pending().await,
    }
}

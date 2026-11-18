//! A window's video, encoded once for everyone who takes it alike: the clients that watch
//! the window in one format at one quality get the same stream, and so does a recording
//! of it.
//!
//! A taker that cannot keep up with a stream does not hold it back: it takes one of a
//! lower quality instead (see [`adapt`](super::adapt)), which is encoded beside it.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use aperture_compositor::{Frames, Handle, WindowId};
use tokio::{
    sync::{Notify, broadcast},
    time::Instant,
};
use tracing::{debug, warn};

use super::encode::{Format, Quality, VideoEncoder};

/// Access units kept for a taker that falls behind; one that falls further misses some and
/// asks for a keyframe.
const BACKLOG: usize = 32;
/// How often a stream at rest looks whether anyone still takes it.
const IDLE_CHECK: Duration = Duration::from_secs(2);
/// The least time between two keyframes that takers ask for. They are large, and a taker
/// that keeps losing frames must not make everyone else pay for one each time.
const KEYFRAME_APART: Duration = Duration::from_millis(300);
/// A window at rest is encoded this many times more, this far apart, at a quality that is a
/// bitrate: each time the encoder has the bitrate to spend on the same picture.
const REFINES: u32 = 4;
const REFINE_AFTER: Duration = Duration::from_millis(250);
/// Frames count as due this early: they come when the window draws, a little off the beat.
const FRAME_SLACK: Duration = Duration::from_millis(3);

/// One encoded frame.
pub struct Packet {
    /// An Annex B access unit.
    pub data: Vec<u8>,
    /// When the frame was drawn, or encoded again, on the compositor's clock.
    pub time: Duration,
    pub keyframe: bool,
    /// How many pixels of the picture changed since the frame before; none for a frame that
    /// is the last one encoded again.
    pub changed: u64,
    /// The picture's size in pixels.
    pub size: (u32, u32),
}

/// Which video of a window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Key {
    pub window: WindowId,
    pub format: Format,
    pub quality: Quality,
    /// Frames a second at most; as many as the quality has with none.
    pub fps: Option<u32>,
}

impl Key {
    /// The fewest and the most frames a second a taker may ask for.
    pub const FPS: std::ops::RangeInclusive<u32> = 1..=60;

    pub fn fps(&self) -> u32 {
        self.fps.unwrap_or(self.quality.fps())
    }
}

struct Shared {
    packets: broadcast::Sender<Arc<Packet>>,
    keyframe: Notify,
}

/// A stream, for one taker. The channel closes when the window does.
pub struct Subscription {
    pub key: Key,
    pub packets: broadcast::Receiver<Arc<Packet>>,
    shared: Arc<Shared>,
}

impl Subscription {
    /// Asks for a frame decoding can start at. It comes even while the window is at rest,
    /// stamped with the time it is encoded at, and no sooner than [`KEYFRAME_APART`] after
    /// the one before it.
    pub fn keyframe(&self) {
        self.shared.keyframe.notify_one();
    }
}

pub struct Streams {
    compositor: Handle,
    streams: Mutex<HashMap<Key, Arc<Shared>>>,
}

impl Streams {
    pub fn new(compositor: Handle) -> Arc<Self> {
        Arc::new(Self {
            compositor,
            streams: Mutex::default(),
        })
    }

    /// Takes a stream, which starts with a keyframe for the new taker. It is encoded for as
    /// long as anyone takes it.
    pub async fn subscribe(
        self: &Arc<Self>,
        key: Key,
    ) -> Result<Subscription, aperture_compositor::Error> {
        if let Some(subscription) = self.join(key) {
            return Ok(subscription);
        }
        let frames = self.compositor.frames(key.window).await?;
        let mut streams = self.streams.lock().expect("not poisoned");
        // Someone else may have started it meanwhile.
        if let Some(shared) = streams.get(&key) {
            return Ok(take(key, shared));
        }
        let shared = Arc::new(Shared {
            packets: broadcast::Sender::new(BACKLOG),
            keyframe: Notify::new(),
        });
        streams.insert(key, shared.clone());
        let subscription = Subscription {
            key,
            packets: shared.packets.subscribe(),
            shared: shared.clone(),
        };
        tokio::spawn(self.clone().encode(key, frames, shared));
        Ok(subscription)
    }

    fn join(&self, key: Key) -> Option<Subscription> {
        self.streams
            .lock()
            .expect("not poisoned")
            .get(&key)
            .map(|shared| take(key, shared))
    }

    /// Forgets the stream when nobody takes it. Takers join under the same lock, so none
    /// joins a stream that is about to end.
    fn retire(&self, key: Key, shared: &Arc<Shared>) -> bool {
        let mut streams = self.streams.lock().expect("not poisoned");
        if shared.packets.receiver_count() > 0 {
            return false;
        }
        streams.remove(&key);
        true
    }

    /// Encodes the window's frames, each as it replaces the last and no more of them than
    /// the quality has a second. Frames that come meanwhile are skipped, down to the
    /// latest.
    async fn encode(self: Arc<Self>, key: Key, mut frames: Frames, shared: Arc<Shared>) {
        let made = tokio::task::spawn_blocking(move || {
            VideoEncoder::new(key.format, key.quality, key.fps())
        });
        let mut encoder = match made.await {
            Ok(Ok(encoder)) => encoder,
            failed => {
                if let Ok(Err(err)) = failed {
                    warn!("no video: {err:#}");
                }
                self.streams.lock().expect("not poisoned").remove(&key);
                return;
            }
        };
        // Held while the encoder takes pixels rather than frames on the GPU.
        let mut pixels = None;
        if encoder.wants_pixels() {
            pixels = self.compositor.pixels(key.window).await.ok();
        }
        let apart = (Duration::from_secs(1) / key.fps()).saturating_sub(FRAME_SLACK);
        // When the next frame is due.
        let mut due = Instant::now();
        let mut keyframe = true;
        let mut last_keyframe: Option<Instant> = None;
        // When the keyframe that was asked for is due.
        let mut keyframe_due: Option<Instant> = None;
        // The frame is encoded again, at a rest of the window, rather than drawn anew.
        let mut again = false;
        // How many more times the window is encoded at this rest.
        let mut refines = 0;
        // What the last frame encoded had counted, see `Frame::changed`.
        let mut counted = 0;
        loop {
            tokio::select! {
                () = shared.keyframe.notified() => {
                    let earliest = last_keyframe.map_or_else(Instant::now, |last| last + KEYFRAME_APART);
                    keyframe_due.get_or_insert(earliest.max(Instant::now()));
                }
                () = async { tokio::time::sleep_until(keyframe_due.expect("checked by the guard")).await },
                    if keyframe_due.is_some() =>
                {
                    keyframe_due = None;
                    keyframe = true;
                    again = true;
                    frames.mark_changed();
                }
                () = tokio::time::sleep(REFINE_AFTER), if refines > 0 => {
                    refines -= 1;
                    again = true;
                    frames.mark_changed();
                }
                changed = frames.changed() => {
                    // The window closed.
                    if changed.is_err() {
                        break;
                    }
                    tokio::time::sleep_until(due).await;
                    let Some(frame) = frames.borrow_and_update().clone() else {
                        continue;
                    };
                    if self.retire(key, &shared) {
                        return;
                    }
                    due = Instant::now() + apart;
                    let force = std::mem::take(&mut keyframe);
                    // The count starts over when the window is watched anew.
                    let changed = frame.changed.checked_sub(counted).unwrap_or(frame.changed);
                    counted = frame.changed;
                    let fresh = !std::mem::take(&mut again) || changed > 0;
                    let time = if fresh { frame.time } else { self.compositor.elapsed() };
                    if fresh && key.quality.bitrate().is_some() {
                        refines = REFINES;
                    }
                    // As the encoder takes it: without a last odd row or column.
                    let size = (frame.width & !1, frame.height & !1);
                    let task = tokio::task::spawn_blocking(move || {
                        let encoded = encoder.encode(&frame, force);
                        (encoder, encoded)
                    });
                    let Ok((returned, encoded)) = task.await else {
                        break;
                    };
                    encoder = returned;
                    // The encoder may have turned to pixels, or to another encoder that
                    // takes them: the next frame comes with them.
                    if pixels.is_none() && encoder.wants_pixels() {
                        pixels = self.compositor.pixels(key.window).await.ok();
                    }
                    match encoded {
                        Ok(None) => keyframe = force,
                        Ok(Some((data, _))) if data.is_empty() => {}
                        Ok(Some((data, keyframe))) => {
                            if keyframe {
                                last_keyframe = Some(Instant::now());
                            }
                            // Nobody taking it right now is fine.
                            let packet = Packet { data, time, keyframe, changed, size };
                            let _ = shared.packets.send(Arc::new(packet));
                        }
                        Err(err) => {
                            debug!("failed to encode a frame: {err:#}");
                            keyframe = true;
                        }
                    }
                }
                () = tokio::time::sleep(IDLE_CHECK) => {
                    if self.retire(key, &shared) {
                        return;
                    }
                }
            }
        }
        self.streams.lock().expect("not poisoned").remove(&key);
    }
}

fn take(key: Key, shared: &Arc<Shared>) -> Subscription {
    let subscription = Subscription {
        key,
        packets: shared.packets.subscribe(),
        shared: shared.clone(),
    };
    subscription.keyframe();
    subscription
}

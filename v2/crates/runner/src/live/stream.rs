//! A window's video, encoded once for everyone who takes it: the clients that watch the
//! window and the recordings of it get the same stream.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use aperture_compositor::{Frames, Handle, WindowId};
use tokio::sync::{Notify, broadcast};
use tracing::{debug, warn};

use super::encode::VideoEncoder;

/// Access units kept for a taker that falls behind; one that falls further misses some and
/// asks for a keyframe.
const BACKLOG: usize = 32;
/// How often a stream at rest looks whether anyone still takes it.
const IDLE_CHECK: Duration = Duration::from_secs(2);

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

struct Shared {
    packets: broadcast::Sender<Arc<Packet>>,
    keyframe: Notify,
}

/// A window's stream, for one taker. The channel closes when the window does.
pub struct Subscription {
    pub packets: broadcast::Receiver<Arc<Packet>>,
    shared: Arc<Shared>,
}

impl Subscription {
    /// Asks for a frame decoding can start at. It comes even while the window is at rest,
    /// stamped with the time it is encoded at.
    pub fn keyframe(&self) {
        self.shared.keyframe.notify_one();
    }
}

pub struct Streams {
    compositor: Handle,
    streams: Mutex<HashMap<WindowId, Arc<Shared>>>,
}

impl Streams {
    pub fn new(compositor: Handle) -> Arc<Self> {
        Arc::new(Self {
            compositor,
            streams: Mutex::default(),
        })
    }

    /// Takes the window's stream, which starts with a keyframe for the new taker. The window
    /// is encoded for as long as anyone takes it.
    pub async fn subscribe(
        self: &Arc<Self>,
        window: WindowId,
    ) -> Result<Subscription, aperture_compositor::Error> {
        if let Some(subscription) = self.join(window) {
            return Ok(subscription);
        }
        let frames = self.compositor.frames(window).await?;
        let mut streams = self.streams.lock().expect("not poisoned");
        // Someone else may have started it meanwhile.
        if let Some(shared) = streams.get(&window) {
            return Ok(take(shared));
        }
        let shared = Arc::new(Shared {
            packets: broadcast::Sender::new(BACKLOG),
            keyframe: Notify::new(),
        });
        streams.insert(window, shared.clone());
        let subscription = Subscription {
            packets: shared.packets.subscribe(),
            shared: shared.clone(),
        };
        tokio::spawn(self.clone().encode(window, frames, shared));
        Ok(subscription)
    }

    fn join(&self, window: WindowId) -> Option<Subscription> {
        self.streams
            .lock()
            .expect("not poisoned")
            .get(&window)
            .map(take)
    }

    /// Forgets the stream when nobody takes it. Takers join under the same lock, so none
    /// joins a stream that is about to end.
    fn retire(&self, window: WindowId, shared: &Arc<Shared>) -> bool {
        let mut streams = self.streams.lock().expect("not poisoned");
        if shared.packets.receiver_count() > 0 {
            return false;
        }
        streams.remove(&window);
        true
    }

    /// Encodes the window's frames, each as it replaces the last. Frames that come while
    /// one is encoded are skipped, down to the latest.
    async fn encode(self: Arc<Self>, window: WindowId, mut frames: Frames, shared: Arc<Shared>) {
        let mut encoder = match tokio::task::spawn_blocking(VideoEncoder::new).await {
            Ok(Ok(encoder)) => encoder,
            failed => {
                if let Ok(Err(err)) = failed {
                    warn!("no video: {err:#}");
                }
                self.streams.lock().expect("not poisoned").remove(&window);
                return;
            }
        };
        let mut keyframe = true;
        // The frame is encoded again, at a rest of the window, rather than drawn anew.
        let mut again = false;
        // What the last frame encoded had counted, see `Frame::changed`.
        let mut counted = 0;
        loop {
            tokio::select! {
                () = shared.keyframe.notified() => {
                    keyframe = true;
                    again = true;
                    frames.mark_changed();
                }
                changed = frames.changed() => {
                    // The window closed.
                    if changed.is_err() {
                        break;
                    }
                    let Some(frame) = frames.borrow_and_update().clone() else {
                        continue;
                    };
                    if self.retire(window, &shared) {
                        return;
                    }
                    let force = std::mem::take(&mut keyframe);
                    let fresh = !std::mem::take(&mut again);
                    let time = if fresh { frame.time } else { self.compositor.elapsed() };
                    // The count starts over when the window is watched anew.
                    let changed = frame.changed.checked_sub(counted).unwrap_or(frame.changed);
                    counted = frame.changed;
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
                    match encoded {
                        Ok((data, _)) if data.is_empty() => {}
                        Ok((data, keyframe)) => {
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
                    if self.retire(window, &shared) {
                        return;
                    }
                }
            }
        }
        self.streams.lock().expect("not poisoned").remove(&window);
    }
}

fn take(shared: &Arc<Shared>) -> Subscription {
    let subscription = Subscription {
        packets: shared.packets.subscribe(),
        shared: shared.clone(),
    };
    subscription.keyframe();
    subscription
}

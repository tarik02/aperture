//! The session's sound: what each of the browser's tabs plays, as Opus.
//!
//! Tabs are told apart inside the browser, by the session's extension, which taps each one
//! (see `extension`): a tapped tab plays into its tap instead of an output, and the
//! extension sends what it plays here, as Opus already. A listener hears the tab it
//! watches. The browser has no sound server to play into, so a tab without a tap is not
//! heard at all.

use std::{
    collections::{BTreeSet, HashMap},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::{broadcast, watch};
use tracing::info;

/// Samples a second, and how long a packet is: what Opus and WebRTC take.
pub const RATE: u32 = 48_000;
pub const PACKET: Duration = Duration::from_millis(20);

/// Packets kept for a listener that falls behind; one that falls further misses some.
/// They are those of every tab that plays.
const BACKLOG: usize = 256;

/// A tap's packets follow one another; after a silence this long, the next one is as late
/// as it came.
const GAP: Duration = Duration::from_millis(100);

/// A tab that sent no packet for this long plays nothing. Its tap sends on for a while
/// after the last sound, so a pause between two words is not one.
const QUIET_AFTER: Duration = Duration::from_millis(400);

/// One Opus packet.
pub struct Packet {
    pub data: Vec<u8>,
    /// How many samples came before it, since the session's sound began.
    pub at: u64,
    /// The browser's tab it is the sound of.
    pub tab: i64,
}

pub struct Sound {
    packets: broadcast::Sender<Arc<Packet>>,
    began: Instant,
    /// The tapped tabs, by the browser's ids, each with where its next packet goes.
    taps: Mutex<HashMap<i64, u64>>,
    /// When each tab's last packet came.
    last: Mutex<HashMap<i64, Instant>>,
    /// The tabs that play something now.
    sounding: watch::Sender<BTreeSet<i64>>,
}

/// What the extension tells, through its native messaging host.
#[derive(Deserialize)]
#[serde(tag = "type")]
enum Told {
    #[serde(rename = "sound.tapped", rename_all = "camelCase")]
    Tapped { tab_id: i64 },
    #[serde(rename = "sound.untapped", rename_all = "camelCase")]
    Untapped { tab_id: i64 },
    #[serde(rename = "sound.refused", rename_all = "camelCase")]
    Refused { tab_id: i64, error: String },
    #[serde(rename = "sound.packet", rename_all = "camelCase")]
    Packet { tab_id: i64, data: String },
}

/// The session's sound for one listener: that of the tab it names, packet by packet.
pub struct Listener {
    packets: broadcast::Receiver<Arc<Packet>>,
}

impl Listener {
    /// The next packet of the browser's tab `tab`; never, with none.
    pub async fn next(
        &mut self,
        tab: Option<i64>,
    ) -> Result<Arc<Packet>, broadcast::error::RecvError> {
        loop {
            let packet = self.packets.recv().await?;
            if tab == Some(packet.tab) {
                return Ok(packet);
            }
        }
    }
}

impl Sound {
    pub fn new() -> Arc<Self> {
        let sound = Arc::new(Self {
            packets: broadcast::Sender::new(BACKLOG),
            began: Instant::now(),
            taps: Mutex::default(),
            last: Mutex::default(),
            sounding: watch::Sender::new(BTreeSet::new()),
        });
        let weak = Arc::downgrade(&sound);
        tokio::spawn(async move {
            let mut turn = tokio::time::interval(QUIET_AFTER / 2);
            loop {
                turn.tick().await;
                let Some(sound) = weak.upgrade() else {
                    return;
                };
                let playing: BTreeSet<i64> = {
                    let mut last = sound.last.lock().expect("not poisoned");
                    last.retain(|_, at| at.elapsed() < QUIET_AFTER);
                    last.keys().copied().collect()
                };
                sound.sounding.send_if_modified(|sounding| {
                    let changed = *sounding != playing;
                    *sounding = playing;
                    changed
                });
            }
        });
        sound
    }

    /// The browser's tabs that play something now.
    pub fn sounding(&self) -> watch::Receiver<BTreeSet<i64>> {
        self.sounding.subscribe()
    }

    /// The extension is gone, and its taps with it.
    pub fn untap(&self) {
        self.last.lock().expect("not poisoned").clear();
        self.taps.lock().expect("not poisoned").clear();
    }

    /// Takes in what the extension tells about the tabs' sound: a message whose type
    /// begins with `sound.`.
    pub fn told(&self, message: Value) -> anyhow::Result<()> {
        let samples = u64::from(RATE) * PACKET.as_millis() as u64 / 1000;
        let gap = u64::from(RATE) * GAP.as_millis() as u64 / 1000;
        match serde_json::from_value(message)? {
            Told::Tapped { tab_id } => {
                let mut taps = self.taps.lock().expect("not poisoned");
                if taps.insert(tab_id, 0).is_none() {
                    info!(tab = tab_id, "tab tapped");
                }
            }
            Told::Refused { tab_id, error } => {
                info!(tab = tab_id, "tab not tapped, and not heard: {error}");
            }
            Told::Untapped { tab_id } => {
                self.taps.lock().expect("not poisoned").remove(&tab_id);
            }
            Told::Packet { tab_id, data } => {
                let data = STANDARD.decode(data)?;
                let now = self.now();
                let news = self
                    .last
                    .lock()
                    .expect("not poisoned")
                    .insert(tab_id, Instant::now())
                    .is_none();
                if news {
                    self.sounding.send_modify(|sounding| {
                        sounding.insert(tab_id);
                    });
                }
                let at = {
                    let mut taps = self.taps.lock().expect("not poisoned");
                    let next = taps.entry(tab_id).or_insert(0);
                    // On the session's clock after a silence, and else right after the
                    // packet before, however unevenly they arrive.
                    let at = if next.abs_diff(now) > gap { now } else { *next };
                    *next = at + samples;
                    at
                };
                // Nobody listening right now is fine.
                let _ = self.packets.send(Arc::new(Packet {
                    data,
                    at,
                    tab: tab_id,
                }));
            }
        }
        Ok(())
    }

    /// Samples since the session's sound began, which is the time packets are stamped in.
    pub fn now(&self) -> u64 {
        (self.began.elapsed().as_micros() * u128::from(RATE) / 1_000_000) as u64
    }

    /// The sound from now on.
    pub fn listen(self: &Arc<Self>) -> Listener {
        Listener {
            packets: self.packets.subscribe(),
        }
    }
}

/// The next packet of the sound of the browser's tab `tab`; never, for one who does not
/// listen.
pub async fn next(
    sound: &mut Option<Listener>,
    tab: Option<i64>,
) -> Result<Arc<Packet>, broadcast::error::RecvError> {
    match sound {
        Some(sound) => sound.next(tab).await,
        None => std::future::pending().await,
    }
}

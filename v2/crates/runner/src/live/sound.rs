//! The session's sound: what each of the browser's tabs plays, as Opus.
//!
//! Tabs are told apart inside the browser, by an extension that taps each one (see
//! `extensions/sound`): a tapped tab plays into its tap instead of an output, and the
//! extension sends what it plays here, as Opus already. A listener hears the tab it
//! watches. The browser has no sound server to play into, so a tab without a tap is not
//! heard at all.

use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use anyhow::ensure;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{io::AsyncReadExt, net::UnixListener, sync::broadcast};
use tracing::{debug, info};

/// Samples a second, and how long a packet is: what Opus and WebRTC take.
pub const RATE: u32 = 48_000;
pub const PACKET: Duration = Duration::from_millis(20);

/// Packets kept for a listener that falls behind; one that falls further misses some.
/// They are those of every tab that plays.
const BACKLOG: usize = 256;

/// The extension that taps the tabs, and its native messaging host.
pub const EXTENSION_ID: &str = "gejmibmcdelpjangbicgbikpiiimcobe";
pub const NATIVE_HOST: &str = "me.tarik02.aperture.sound";
const EXTENSION: [(&str, &str); 4] = [
    (
        "manifest.json",
        include_str!("../../extensions/sound/manifest.json"),
    ),
    (
        "worker.js",
        include_str!("../../extensions/sound/worker.js"),
    ),
    (
        "taps.html",
        include_str!("../../extensions/sound/taps.html"),
    ),
    ("taps.js", include_str!("../../extensions/sound/taps.js")),
];

/// The most the extension says at once, in bytes.
const MESSAGE_LIMIT: usize = 64 * 1024;

/// A tap's packets follow one another; after a silence this long, the next one is as late
/// as it came.
const GAP: Duration = Duration::from_millis(100);

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
    /// The session's sound, with the extension's taps heard on the socket `taps`.
    pub fn new(taps: &Path) -> std::io::Result<Arc<Self>> {
        let _ = std::fs::remove_file(taps);
        let listener = UnixListener::bind(taps)?;
        let sound = Arc::new(Self {
            packets: broadcast::Sender::new(BACKLOG),
            began: Instant::now(),
            taps: Mutex::default(),
        });
        tokio::spawn({
            let sound = Arc::downgrade(&sound);
            async move {
                while let Ok((mut stream, _)) = listener.accept().await {
                    let Some(sound) = sound.upgrade() else {
                        return;
                    };
                    tokio::spawn(async move {
                        if let Err(err) = sound.hear(&mut stream).await {
                            debug!("the sound extension's connection ended: {err:#}");
                        }
                        // Its taps went with it.
                        sound.taps.lock().expect("not poisoned").clear();
                    });
                }
            }
        });
        Ok(sound)
    }

    /// Writes the extension to `dir`, for the browser to load.
    pub fn unpack_extension(dir: &Path) -> std::io::Result<()> {
        let _ = std::fs::remove_dir_all(dir);
        std::fs::create_dir_all(dir)?;
        for (name, content) in EXTENSION {
            std::fs::write(dir.join(name), content)?;
        }
        Ok(())
    }

    /// The manifest that tells Chromium where the extension's native messaging host is.
    pub fn native_host_manifest(host: &Path) -> Value {
        json!({
            "name": NATIVE_HOST,
            "description": "Aperture's bridge to the session's sound extension",
            "path": host,
            "type": "stdio",
            "allowed_origins": [format!("chrome-extension://{EXTENSION_ID}/")],
        })
    }

    /// Takes what the extension tells, framed as Chromium frames native messages: the
    /// length, in the machine's byte order, then JSON.
    async fn hear(&self, stream: &mut tokio::net::UnixStream) -> anyhow::Result<()> {
        let samples = u64::from(RATE) * PACKET.as_millis() as u64 / 1000;
        let gap = u64::from(RATE) * GAP.as_millis() as u64 / 1000;
        loop {
            let mut length = [0; 4];
            if stream.read_exact(&mut length).await.is_err() {
                return Ok(());
            }
            let length = u32::from_ne_bytes(length) as usize;
            ensure!(length <= MESSAGE_LIMIT, "a message of {length} bytes");
            let mut body = vec![0; length];
            stream.read_exact(&mut body).await?;
            match serde_json::from_slice(&body)? {
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
                    let at = {
                        let mut taps = self.taps.lock().expect("not poisoned");
                        let next = taps.entry(tab_id).or_insert(0);
                        // On the session's clock after a silence, and else right after
                        // the packet before, however unevenly they arrive.
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
        }
    }

    /// Samples since the session's sound began.
    fn now(&self) -> u64 {
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

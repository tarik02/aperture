//! What a session may use, how long it may sit idle before it is suspended, and how long
//! its recordings are kept.

use std::time::Duration;

use serde::{Deserialize, Serialize};

/// A session's limits. One left out is as the executor is set up; zero is no limit.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct Limits {
    /// Bytes of memory.
    #[serde(default)]
    pub memory: Option<u64>,
    /// Bytes of swap, on top of the memory, for a session whose memory is limited. One
    /// whose memory is not may swap as the machine lets it.
    #[serde(default)]
    pub swap: Option<u64>,
    /// Processors' worth of time.
    #[serde(default)]
    pub cpus: Option<f64>,
    /// Processes and threads.
    #[serde(default)]
    pub tasks: Option<u64>,
    /// How long nobody may use the session before it is suspended.
    #[serde(default)]
    pub idle_ms: Option<u64>,
    /// How long its recordings and screenshots are kept before they are removed.
    #[serde(default)]
    pub keep_recordings_ms: Option<u64>,
}

impl Limits {
    /// These limits where they say something, and `defaults` where they do not; with none
    /// where that comes to zero.
    pub fn over(self, defaults: Self) -> Self {
        Self {
            memory: self.memory.or(defaults.memory).filter(|&bytes| bytes > 0),
            swap: self.swap.or(defaults.swap).filter(|&bytes| bytes > 0),
            cpus: self.cpus.or(defaults.cpus).filter(|&cpus| cpus > 0.0),
            tasks: self.tasks.or(defaults.tasks).filter(|&tasks| tasks > 0),
            idle_ms: self.idle_ms.or(defaults.idle_ms).filter(|&ms| ms > 0),
            keep_recordings_ms: self
                .keep_recordings_ms
                .or(defaults.keep_recordings_ms)
                .filter(|&ms| ms > 0),
        }
    }

    /// Whether any of them takes a control group to hold.
    pub fn on_resources(&self) -> bool {
        self.memory.is_some() || self.swap.is_some() || self.cpus.is_some() || self.tasks.is_some()
    }

    pub fn check(&self) -> Result<(), String> {
        match self.cpus {
            Some(cpus) if !cpus.is_finite() || cpus < 0.0 => {
                Err(format!("{cpus} is no number of processors"))
            }
            _ => Ok(()),
        }
    }

    pub fn idle(&self) -> Option<Duration> {
        self.idle_ms.map(Duration::from_millis)
    }

    pub fn keep_recordings(&self) -> Option<Duration> {
        self.keep_recordings_ms.map(Duration::from_millis)
    }
}

/// A size in bytes, as `512M`, `4G`, `1.5G` or a number of bytes. A unit is a power of
/// 1024, as memory is counted.
pub fn size(text: &str) -> Result<u64, String> {
    parse_size::Config::new()
        .with_binary()
        .parse_size(text.trim())
        .map_err(|err| format!("{text:?} is not a size like 512M or 4G: {err}"))
}

/// A stretch of time, as `90s`, `15m`, `2h` or `1h 30m`.
pub fn stretch(text: &str) -> Result<Duration, String> {
    humantime::parse_duration(text.trim())
        .map_err(|err| format!("{text:?} is not a time like 90s, 15m or 2h: {err}"))
}

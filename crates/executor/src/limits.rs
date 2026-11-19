//! What a session may use, and how long it may sit idle before it is suspended.

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
}

/// A size in bytes, as `512M`, `4G`, `1.5G` or a number of bytes.
pub fn size(text: &str) -> Result<u64, String> {
    let text = text.trim();
    let (number, unit) = match text.char_indices().last() {
        Some((at, 'K' | 'k')) => (&text[..at], 1u64 << 10),
        Some((at, 'M' | 'm')) => (&text[..at], 1 << 20),
        Some((at, 'G' | 'g')) => (&text[..at], 1 << 30),
        Some((at, 'T' | 't')) => (&text[..at], 1 << 40),
        _ => (text, 1),
    };
    number
        .parse::<f64>()
        .ok()
        .filter(|number| number.is_finite() && *number >= 0.0)
        .map(|number| (number * unit as f64) as u64)
        .ok_or_else(|| format!("{text:?} is not a size like 512M or 4G"))
}

/// A stretch of time, as `90s`, `15m`, `2h` or a number of seconds.
pub fn stretch(text: &str) -> Result<Duration, String> {
    let text = text.trim();
    let (number, unit) = match text.char_indices().last() {
        Some((at, 's')) => (&text[..at], 1.0),
        Some((at, 'm')) => (&text[..at], 60.0),
        Some((at, 'h')) => (&text[..at], 3600.0),
        _ => (text, 1.0),
    };
    number
        .parse::<f64>()
        .ok()
        .filter(|number| number.is_finite() && *number >= 0.0)
        .map(|number| Duration::from_secs_f64(number * unit))
        .ok_or_else(|| format!("{text:?} is not a time like 90s, 15m or 2h"))
}

//! How the session's automation moves the pointer in a tab that is being recorded. It is
//! the session's, and so the same for every recording that runs and for whoever calls the
//! tools; a tab nothing records gets its input at once whatever the pace is.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tokio::sync::watch;
use tracing::warn;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Pace {
    /// The pointer jumps to each action.
    Instant,
    /// The pointer travels there, quickly but so that the eye can follow.
    #[default]
    Fast,
    /// Unhurried travel, for demos.
    Slow,
}

/// What the file of the session's pace holds.
#[derive(Default, Serialize, Deserialize)]
struct Kept {
    pace: Pace,
}

/// The session's pace, for those who set it and those who go by it.
#[derive(Clone)]
pub struct Paced {
    pace: watch::Sender<Pace>,
    /// Where it is kept from one run of the session to the next.
    kept: PathBuf,
}

impl Paced {
    /// The pace the session's last run kept in `kept`, or the default.
    pub fn restore(kept: PathBuf) -> Self {
        let before: Kept = match std::fs::read(&kept) {
            Ok(written) => serde_json::from_slice(&written).unwrap_or_else(|err| {
                warn!(%err, "the session's pace is not read");
                Kept::default()
            }),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Kept::default(),
            Err(err) => {
                warn!(%err, "the session's pace is not read");
                Kept::default()
            }
        };
        Self {
            pace: watch::Sender::new(before.pace),
            kept,
        }
    }

    pub fn get(&self) -> Pace {
        *self.pace.borrow()
    }

    /// Tells of the pace as it is and whenever it is set.
    pub fn watch(&self) -> watch::Receiver<Pace> {
        self.pace.subscribe()
    }

    pub fn set(&self, pace: Pace) {
        if !self
            .pace
            .send_if_modified(|now| std::mem::replace(now, pace) != pace)
        {
            return;
        }
        let aside = self.kept.with_extension("json.new");
        let written = serde_json::to_vec(&Kept { pace })
            .map_err(std::io::Error::other)
            .and_then(|kept| std::fs::write(&aside, kept))
            .and_then(|()| std::fs::rename(&aside, &self.kept));
        if let Err(err) = written {
            warn!(%err, "the session's pace is not kept for its next run");
        }
    }
}

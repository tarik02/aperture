//! Which quality of a window's video a client takes, by what its link carries.
//!
//! Nothing says what a link carries before it is asked to: an estimate of one that little
//! is sent over says little. So the quality steps up while the link keeps up, and back
//! down when it does not ([`Steps`]), and a step up that had to be taken back is tried
//! again ever more rarely. What tells that a link does not keep up differs:
//!
//! - WebRTC estimates what the link carries from how its packets arrive; a link that is
//!   sent more than the estimate does not keep up ([`Estimated`]).
//! - On the session socket nothing gets lost: what the link does not carry queues up in
//!   front of it, as latency. The client says which frames it has shown, and showing them
//!   late is not keeping up ([`Delivery`]).

use std::{collections::VecDeque, time::Duration};

use tokio::time::Instant;

use super::encode::Quality;

/// How long a link must fail to keep up for the quality to step down: soon, as that is
/// what a person at the client feels.
const BEHIND_FOR: Duration = Duration::from_secs(1);
/// How long a link must keep up for the quality to step up: the first time, and after
/// that. A step up that had to be taken back doubles it, up to the longest.
const KEEPS_UP_FOR_FIRST: Duration = Duration::from_secs(2);
const KEEPS_UP_FOR: Duration = Duration::from_secs(5);
const KEEPS_UP_FOR_LONGEST: Duration = Duration::from_secs(120);
/// A step up taken back within this long was one too many.
const TRIAL: Duration = Duration::from_secs(15);

/// The quality a client starts at: the link is not known, and from the middle either way
/// is one step.
pub const START: Quality = Quality::Medium;

/// The quality a client takes, stepped by whether its link keeps up.
struct Steps {
    quality: Quality,
    behind_since: Option<Instant>,
    keeps_up_since: Option<Instant>,
    keeps_up_for: Duration,
    /// When the quality last stepped up.
    raised: Option<Instant>,
}

impl Steps {
    fn new() -> Self {
        Self {
            quality: START,
            behind_since: None,
            keeps_up_since: None,
            keeps_up_for: KEEPS_UP_FOR_FIRST,
            raised: None,
        }
    }

    /// The link does not keep up right now. Tells the quality to take when that changes.
    fn behind(&mut self, now: Instant) -> Option<Quality> {
        self.keeps_up_since = None;
        let since = *self.behind_since.get_or_insert(now);
        if now - since < BEHIND_FOR {
            return None;
        }
        self.behind_since = None;
        let lower = self.quality.lower()?;
        let trial = self
            .raised
            .take()
            .is_some_and(|raised| now - raised < TRIAL);
        self.keeps_up_for = if trial {
            (self.keeps_up_for.max(KEEPS_UP_FOR) * 2).min(KEEPS_UP_FOR_LONGEST)
        } else {
            KEEPS_UP_FOR
        };
        self.quality = lower;
        Some(lower)
    }

    /// The link keeps up right now.
    fn keeps_up(&mut self, now: Instant) -> Option<Quality> {
        self.behind_since = None;
        let since = *self.keeps_up_since.get_or_insert(now);
        if now - since < self.keeps_up_for {
            return None;
        }
        self.keeps_up_since = None;
        let higher = self.quality.higher()?;
        self.raised = Some(now);
        self.quality = higher;
        Some(higher)
    }

    /// Neither can be told right now.
    fn unclear(&mut self) {
        self.behind_since = None;
        self.keeps_up_since = None;
    }
}

/// A link is sent more than it carries when the estimate is this much of what was sent.
const OVER_AT: f64 = 0.9;

/// A client's WebRTC connection.
pub struct Estimated {
    steps: Steps,
    /// What went out in the last second: when, and how many bytes.
    sent: VecDeque<(Instant, usize)>,
    /// In bit/s.
    estimate: Option<u64>,
}

impl Estimated {
    pub fn new() -> Self {
        Self {
            steps: Steps::new(),
            sent: VecDeque::new(),
            estimate: None,
        }
    }

    pub fn quality(&self) -> Quality {
        self.steps.quality
    }

    pub fn sent(&mut self, bytes: usize) {
        self.sent.push_back((Instant::now(), bytes));
    }

    /// The connection estimates the link to carry this many bit/s.
    pub fn estimate(&mut self, estimate: u64) {
        self.estimate = Some(estimate);
    }

    /// Looks at the link, which is to happen a few times a second. Tells the quality to
    /// take from now on when that changes.
    pub fn settle(&mut self) -> Option<Quality> {
        let now = Instant::now();
        while self
            .sent
            .pop_front_if(|(at, _)| now - *at > Duration::from_secs(1))
            .is_some()
        {}
        let spent: usize = self.sent.iter().map(|(_, bytes)| bytes * 8).sum();
        // A link that nothing is sent over keeps up with it.
        let over = self
            .estimate
            .is_some_and(|estimate| (estimate as f64) < spent as f64 * OVER_AT);
        if over {
            self.steps.behind(now)
        } else {
            self.steps.keeps_up(now)
        }
    }
}

/// A frame shown this long after it was sent is late, and one within this is in time.
const LATE: Duration = Duration::from_millis(300);
const IN_TIME: Duration = Duration::from_millis(120);
/// With this much sent and not shown, or a frame waiting this long, the link is clogged:
/// more frames would only wait behind those.
const CLOGGED_BYTES: usize = 1024 * 1024;
const CLOGGED_FOR: Duration = Duration::from_millis(1500);

/// What became of the frames sent to one client on its session socket.
pub struct Delivery {
    steps: Steps,
    /// Frames sent and not yet shown: their time, when they were sent, and their size.
    waiting: VecDeque<(u64, Instant, usize)>,
    waiting_bytes: usize,
}

impl Delivery {
    pub fn new() -> Self {
        Self {
            steps: Steps::new(),
            waiting: VecDeque::new(),
            waiting_bytes: 0,
        }
    }

    pub fn quality(&self) -> Quality {
        self.steps.quality
    }

    /// A frame stamped `time` went to the client.
    pub fn sent(&mut self, time: u64, bytes: usize) {
        self.waiting.push_back((time, Instant::now(), bytes));
        self.waiting_bytes += bytes;
    }

    /// The client showed the frame stamped `time`, or let it go, and every frame before
    /// it. Tells the quality to take from now on when that changes.
    pub fn shown(&mut self, time: u64) -> Option<Quality> {
        let now = Instant::now();
        let mut took = None;
        while let Some((_, sent, bytes)) = self.waiting.pop_front_if(|frame| frame.0 <= time) {
            self.waiting_bytes -= bytes;
            took = Some(now - sent);
        }
        let took = took?;
        if took >= LATE {
            self.steps.behind(now)
        } else if took <= IN_TIME {
            self.steps.keeps_up(now)
        } else {
            self.steps.unclear();
            None
        }
    }

    /// Whether frames are to be held back, see [`CLOGGED_BYTES`]; with the quality to take
    /// from now on when that changes.
    pub fn clogged(&mut self) -> (bool, Option<Quality>) {
        let now = Instant::now();
        let oldest = self.waiting.front().map(|(_, sent, _)| now - *sent);
        let clogged =
            self.waiting_bytes > CLOGGED_BYTES || oldest.is_some_and(|age| age > CLOGGED_FOR);
        (clogged, clogged.then(|| self.steps.behind(now)).flatten())
    }

    /// The client watches something else: what it has yet to show of the old no longer
    /// says anything.
    pub fn restart(&mut self) {
        self.waiting.clear();
        self.waiting_bytes = 0;
        self.steps.unclear();
    }
}

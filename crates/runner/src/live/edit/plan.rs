//! What the edit of a recording does to its raw video, decided from the recording's journal
//! and from when the picture changed: which stretches are kept and at what speed, and where
//! captions, click ripples and zooms go. It is pure: it reads no video and runs nothing,
//! and gives ffmpeg's filter chain and a subtitle script for it.
//!
//! Times are milliseconds of the raw video unless a name says edited: the edited video has
//! the raw video's frames at the times its pieces give them, and the effects are placed on
//! that clock.

use std::fmt::Write as _;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

/// The shortest stretch `idle` shortens, after the padding.
const IDLE_MIN_MS: i64 = 1000;
/// Padding kept at normal speed around everything that happens.
const IDLE_KEEP_MS: i64 = 300;
const IDLE_SPEED: f64 = 8.0;
/// Changes of the picture closer than this are one stretch of activity.
const ACTIVE_GAP_MS: i64 = 200;

const FOCUS_EASE_MS: i64 = 400;
/// Zooms closer than this share one, so the view does not bounce between them.
const FOCUS_MERGE_GAP_MS: i64 = 500;
const RIPPLE_MS: i64 = 600;
/// The part of a zoomed view, centred, in which the pointer moves without moving the view:
/// a view that chased every move of the pointer would never hold still.
const POINTER_DEAD_ZONE: f64 = 0.5;

/// What a recording says, as it starts, about the edit made when it stops.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Options {
    /// `bursts` keeps only the stretches around what the automation did.
    pub capture: Capture,
    /// Shortens the stretches in which nothing happens. Not with `bursts`.
    pub idle: Option<Idle>,
    /// Marks clicks with a ripple.
    pub ripple: bool,
    pub burst: Burst,
    /// How automation moves the pointer while the recording runs.
    pub pace: Pace,
    /// The share of the picture that must change for something to have happened, for
    /// `idle` and `bursts` to tell: from 0 to 1.
    pub motion_threshold: f64,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            capture: Capture::default(),
            idle: None,
            ripple: false,
            burst: Burst::default(),
            pace: Pace::default(),
            // A typed character counts, a mark a few pixels large does not.
            motion_threshold: 0.0002,
        }
    }
}

/// How fast automation acts on a target that is being recorded.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Capture {
    #[default]
    Continuous,
    Bursts,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Idle {
    Cut,
    Speed,
}

/// The size of a burst around a tool call: `lead_ms` before it, `tail_ms` after it, and more
/// of the tail until the picture has stood still for `settle_ms`, but never past
/// `max_tail_ms`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(default)]
pub struct Burst {
    pub lead_ms: i64,
    pub tail_ms: i64,
    pub settle_ms: i64,
    pub max_tail_ms: i64,
}

impl Default for Burst {
    fn default() -> Self {
        Self {
            lead_ms: 500,
            tail_ms: 800,
            settle_ms: 400,
            max_tail_ms: 3000,
        }
    }
}

impl Options {
    pub fn check(&self) -> Result<(), String> {
        if self.capture == Capture::Bursts && self.idle.is_some() {
            return Err("idle applies to continuous capture, not to bursts".into());
        }
        if !(0.0..=1.0).contains(&self.motion_threshold) {
            return Err("motion_threshold must be 0 to 1".into());
        }
        let burst = self.burst;
        let sizes = [
            burst.lead_ms,
            burst.tail_ms,
            burst.settle_ms,
            burst.max_tail_ms,
        ];
        if sizes.iter().any(|size| !(0..=60_000).contains(size)) {
            return Err("burst sizes must be 0 to 60000 ms".into());
        }
        Ok(())
    }
}

/// One line of the journal.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Event {
    pub kind: String,
    pub at_ms: i64,
    pub end_ms: i64,
    #[serde(flatten)]
    pub fields: Map<String, Value>,
}

impl Event {
    fn span(&self) -> Span {
        Span {
            start: self.at_ms,
            end: self.end_ms,
        }
    }

    fn number(&self, key: &str) -> f64 {
        self.fields.get(key).and_then(Value::as_f64).unwrap_or(0.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Span {
    pub start: i64,
    pub end: i64,
}

/// A stretch of the raw video that the edited video keeps, played at `speed`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Piece {
    pub start: i64,
    pub end: i64,
    pub speed: f64,
}

/// The video being edited.
#[derive(Debug, Clone, Copy)]
pub struct Video {
    pub duration_ms: i64,
    pub width: u32,
    pub height: u32,
}

pub struct Plan {
    pub pieces: Vec<Piece>,
    /// ffmpeg's filter chain, from the raw video to the edited one.
    pub filter: String,
    /// The same for the sound.
    pub sound: String,
    /// The script the chain reads as `ripples.ass`, when clicks are marked.
    pub ripples: Option<String>,
    /// The script the chain reads as `captions.ass`, when there are captions.
    pub captions: Option<String>,
}

/// Nothing of the recording would be kept: no tool call or effect fell in it.
#[derive(Debug, thiserror::Error)]
#[error("nothing of the recording was kept: no tool call or effect fell in it")]
pub struct NothingKept;

/// The stretches in which the picture changed, from the times of the frames that showed a
/// change. A frame on its own counts too: a slow update can matter without any input to
/// go with it.
pub fn active_spans(changed_at_ms: &[i64]) -> Vec<Span> {
    let mut spans: Vec<Span> = Vec::new();
    for &at in changed_at_ms {
        match spans.last_mut() {
            Some(last) if at - last.end <= ACTIVE_GAP_MS => last.end = at,
            _ => spans.push(Span { start: at, end: at }),
        }
    }
    spans
}

pub fn plan(
    options: &Options,
    events: &[Event],
    active: &[Span],
    video: Video,
    fps: u32,
) -> Result<Plan, NothingKept> {
    let total = video.duration_ms;
    let whole = Piece {
        start: 0,
        end: total,
        speed: 1.0,
    };
    let pieces = match (options.capture, options.idle) {
        (Capture::Bursts, _) => burst_pieces(options.burst, events, active, total),
        (Capture::Continuous, Some(idle)) => idle_pieces(idle, events, active, total),
        (Capture::Continuous, None) => vec![whole],
    };
    if pieces.is_empty() {
        return Err(NothingKept);
    }

    let (width, height) = (f64::from(video.width), f64::from(video.height));
    let mut chain = vec!["setpts=PTS-STARTPTS".to_owned()];
    if pieces != [whole] {
        chain.extend(remap_filters(&pieces));
    }
    // The raw video has a frame where the picture changed; the edited one has them evenly.
    chain.push(format!("fps={fps}"));
    chain.push("format=yuv420p".to_owned());

    let (cues, ripples, zooms) = effects(&pieces, events, options.ripple, video);
    // Ripples are part of the page's picture and zoom with it; captions are over the frame
    // and do not.
    let ripples = (!ripples.is_empty()).then(|| {
        chain.push("ass=ripples.ass".to_owned());
        subtitles(&[], &ripples, video)
    });
    chain.extend(focus_filters(zooms, width, height, fps));
    let captions = (!cues.is_empty()).then(|| {
        chain.push("ass=captions.ass".to_owned());
        subtitles(&cues, &[], video)
    });
    let mut sound = Vec::new();
    if pieces != [whole] {
        sound.extend(remap_sound_filters(&pieces));
    }
    // Silence where the sound has none, and from the start.
    sound.push("aresample=async=1:first_pts=0".to_owned());
    Ok(Plan {
        pieces,
        filter: chain.join(","),
        sound: sound.join(","),
        ripples,
        captions,
    })
}

/// What happened, where in the raw video and where in the edited one, for whoever shows
/// the recording.
pub fn timeline(plan: &Plan, events: &[Event], dropped: usize, video: Video) -> Value {
    let events: Vec<Value> = events
        .iter()
        .map(|event| {
            let mut value = serde_json::to_value(event).expect("an event is JSON");
            value["edited_at_ms"] = map_time(&plan.pieces, event.at_ms).into();
            value["edited_end_ms"] = map_time(&plan.pieces, event.end_ms).into();
            value
        })
        .collect();
    let map: Vec<Value> = plan
        .pieces
        .iter()
        .map(|piece| {
            json!({
                "raw_start_ms": piece.start,
                "raw_end_ms": piece.end,
                "speed": piece.speed,
                "edited_start_ms": map_time(&plan.pieces, piece.start),
            })
        })
        .collect();
    json!({
        "version": 1,
        "duration_ms": video.duration_ms,
        "edited_duration_ms": map_time(&plan.pieces, video.duration_ms),
        "width": video.width,
        "height": video.height,
        "map": map,
        "events": events,
        "events_dropped": dropped,
    })
}

/// Where a raw video time falls in the edited video; a time in a cut stretch falls where it
/// was cut.
fn map_time(pieces: &[Piece], time: i64) -> i64 {
    let mut edited = 0.0;
    for piece in pieces {
        if time <= piece.start {
            break;
        }
        edited += (time.min(piece.end) - piece.start) as f64 / piece.speed;
    }
    edited.round() as i64
}

/// The kept piece a raw video time falls in, if any.
fn piece_at(pieces: &[Piece], time: i64) -> Option<Piece> {
    pieces
        .iter()
        .copied()
        .find(|piece| time >= piece.start && time < piece.end)
}

/// Pads spans, keeps them inside the video and joins those that touch.
fn merge_spans(spans: &[Span], pad: i64, total: i64) -> Vec<Span> {
    let mut padded: Vec<Span> = spans
        .iter()
        .map(|span| Span {
            start: (span.start - pad).max(0),
            end: (span.end + pad).min(total),
        })
        .filter(|span| span.end >= span.start)
        .collect();
    padded.sort_by_key(|span| span.start);
    let mut merged: Vec<Span> = Vec::new();
    for span in padded {
        match merged.last_mut() {
            Some(last) if span.start <= last.end => last.end = last.end.max(span.end),
            _ => merged.push(span),
        }
    }
    merged
}

/// Keeps the stretch around every tool call, focus and attention: from the lead before it
/// to the end of its tail, which lasts until the picture has settled but not longer than
/// the longest tail. A call's tail starts after its last pointer input rather than when the
/// call returns: a call goes on waiting for the page to settle, and that wait is shown only
/// while the picture changes. A call without pointer input that changed nothing, such as a
/// script that only reads the page, is not kept, unless nothing else would be.
fn burst_pieces(burst: Burst, events: &[Event], active: &[Span], total: i64) -> Vec<Piece> {
    let active = merge_spans(active, 0, total);
    let mut keep = Vec::new();
    let mut quiet = Vec::new();
    for event in events {
        let at = event.span();
        if event.kind == "caption" {
            // A caption keeps the picture under it for as long as it asked to be read: a
            // burst is often shorter than that, and a caption ends with its piece.
            let duration = event.number("duration_ms") as i64;
            if duration > 0 {
                keep.push(Span {
                    start: at.start,
                    end: at.start + duration,
                });
            }
            continue;
        }
        if !matches!(event.kind.as_str(), "call" | "focus" | "attention") {
            continue;
        }
        let mut acted = at.end;
        let mut is_quiet = false;
        if event.kind == "call" {
            match last_input_end(events, at) {
                Some(last) => acted = last,
                None => {
                    is_quiet = !active.iter().any(|active| {
                        active.end >= at.start && active.start <= at.end + burst.settle_ms
                    });
                }
            }
        }
        // Until when the picture changes, with pauses shorter than the settle time.
        let mut still = acted;
        for active in &active {
            if active.end > still && active.start - still < burst.settle_ms {
                still = still.max(active.end);
            }
        }
        let end = (acted + burst.tail_ms)
            .max(still + burst.settle_ms)
            .min(acted + burst.max_tail_ms);
        let span = Span {
            start: at.start - burst.lead_ms,
            end,
        };
        if is_quiet {
            quiet.push(span);
        } else {
            keep.push(span);
        }
    }
    if keep.is_empty() {
        keep = quiet;
    }
    merge_spans(&keep, 0, total)
        .into_iter()
        .filter(|span| span.end > span.start)
        .map(|span| Piece {
            start: span.start,
            end: span.end,
            speed: 1.0,
        })
        .collect()
}

/// When the last pointer input that happened during a call ended.
fn last_input_end(events: &[Event], call: Span) -> Option<i64> {
    events
        .iter()
        .filter(|event| matches!(event.kind.as_str(), "move" | "press" | "wheel"))
        .filter(|event| event.at_ms >= call.start && event.at_ms <= call.end)
        .map(|event| event.end_ms)
        .max()
}

/// Cuts, or speeds up, the stretches in which nothing happens: no change in the picture and
/// no journal entry, apart from a little padding.
fn idle_pieces(mode: Idle, events: &[Event], active: &[Span], total: i64) -> Vec<Piece> {
    let mut busy = active.to_vec();
    busy.extend(events.iter().map(Event::span));
    let busy = merge_spans(&busy, IDLE_KEEP_MS, total);

    let mut pieces = Vec::new();
    let mut cursor = 0;
    let mut idle = |span: Span| {
        if span.end - span.start < IDLE_MIN_MS {
            return;
        }
        if span.start > cursor {
            pieces.push(Piece {
                start: cursor,
                end: span.start,
                speed: 1.0,
            });
        }
        if mode == Idle::Speed {
            pieces.push(Piece {
                start: span.start,
                end: span.end,
                speed: IDLE_SPEED,
            });
        }
        cursor = span.end;
    };
    let mut last = 0;
    for span in &busy {
        idle(Span {
            start: last,
            end: span.start,
        });
        last = span.end;
    }
    idle(Span {
        start: last,
        end: total,
    });
    if cursor < total {
        pieces.push(Piece {
            start: cursor,
            end: total,
            speed: 1.0,
        });
    }
    pieces
}

/// Filters that keep the frames inside the pieces and give each the time it has in the
/// edited video: the lengths of the pieces before it, over their speeds, plus its place in
/// its own.
fn remap_filters(pieces: &[Piece]) -> [String; 2] {
    let seconds = |ms: i64| format!("{:.3}", ms as f64 / 1000.0);
    let mut keep = Vec::new();
    let mut times = Vec::new();
    for piece in pieces {
        let (from, to) = (seconds(piece.start), seconds(piece.end));
        keep.push(format!("gte(t,{from})*lt(t,{to})"));
        let mut term = format!("(clip(T,{from},{to})-{from})");
        if piece.speed != 1.0 {
            let _ = write!(term, "/{}", piece.speed);
        }
        times.push(term);
    }
    [
        format!("select='{}'", keep.join("+")),
        format!("setpts='({})/TB'", times.join("+")),
    ]
}

/// The same for the sound, of the pieces played as they were: sound that is sped up is
/// noise, so such a piece is silent.
fn remap_sound_filters(pieces: &[Piece]) -> [String; 2] {
    let seconds = |ms: i64| format!("{:.3}", ms as f64 / 1000.0);
    let mut keep = vec!["0".to_owned()];
    let mut times = Vec::new();
    for piece in pieces {
        let (from, to) = (seconds(piece.start), seconds(piece.end));
        if piece.speed == 1.0 {
            keep.push(format!("gte(t,{from})*lt(t,{to})"));
        }
        let mut term = format!("(clip(T,{from},{to})-{from})");
        if piece.speed != 1.0 {
            let _ = write!(term, "/{}", piece.speed);
        }
        times.push(term);
    }
    [
        format!("aselect='{}'", keep.join("+")),
        format!("asetpts='({})/TB'", times.join("+")),
    ]
}

struct Cue {
    start: i64,
    end: i64,
    text: String,
}

/// A click: the edited time it happens at and where, in frame pixels.
struct Ripple {
    start: i64,
    x: f64,
    y: f64,
}

/// A zoom the recording asked for: a window of edited time, a factor and the path of the
/// view's centre in frame pixels, which has a point at its start and one wherever what it
/// follows moved.
struct Focus {
    start: i64,
    end: i64,
    zoom: f64,
    path: Vec<FocusPoint>,
}

#[derive(Clone, Copy)]
struct FocusPoint {
    time: i64,
    x: f64,
    y: f64,
}

/// Places the journal's captions, clicks and focuses on the edited video: at edited times,
/// and only those that fall in a kept piece. A caption set in a cut stretch, such as just
/// before the first call, is shown from the start of the next kept piece instead, since it
/// was never seen. A caption ends with the piece it is shown in, so it does not run on
/// across a cut.
fn effects(
    pieces: &[Piece],
    events: &[Event],
    ripple: bool,
    video: Video,
) -> (Vec<Cue>, Vec<Ripple>, Vec<Focus>) {
    let (mut cues, mut ripples, mut zooms) = (Vec::new(), Vec::new(), Vec::new());
    for event in events {
        let at = event.span();
        let mut start = map_time(pieces, at.start);
        match event.kind.as_str() {
            "caption" => {
                let piece = match piece_at(pieces, at.start) {
                    Some(piece) => piece,
                    None => {
                        let Some(next) = pieces.iter().find(|piece| piece.start > at.start) else {
                            continue;
                        };
                        start = map_time(pieces, next.start);
                        *next
                    }
                };
                let end =
                    (start + event.number("duration_ms") as i64).min(map_time(pieces, piece.end));
                let text = event.fields.get("text").and_then(Value::as_str);
                cues.push(Cue {
                    start,
                    end,
                    text: text
                        .unwrap_or_default()
                        .split_whitespace()
                        .collect::<Vec<_>>()
                        .join(" "),
                });
            }
            "press" if ripple && piece_at(pieces, at.start).is_some() => {
                ripples.push(Ripple {
                    start,
                    x: event.number("x"),
                    y: event.number("y"),
                });
            }
            "focus" if piece_at(pieces, (at.start + at.end) / 2).is_some() => {
                zooms.extend(focus_at(pieces, event, video));
            }
            _ => {}
        }
    }

    // Cues stay inside the video, and each ends where the next begins.
    let total = map_time(pieces, video.duration_ms);
    cues.sort_by_key(|cue| cue.start);
    for index in 0..cues.len() {
        let next = cues.get(index + 1).map_or(total, |next| next.start);
        cues[index].end = cues[index].end.min(total).min(next);
    }
    cues.retain(|cue| cue.end > cue.start && !cue.text.is_empty());
    (cues, ripples, zooms)
}

/// Places a focus entry on the edited video. Its rectangle, and every one what it follows
/// moved to while the focus lasted, is cut to the frame, since only the visible part can
/// be shown; the zoom is lowered so that part fits the frame, and the view follows its
/// centre. A focus whose element was still out of view, about to be scrolled to, begins
/// once it is in view.
fn focus_at(pieces: &[Piece], event: &Event, video: Video) -> Option<Focus> {
    let (width, height) = (f64::from(video.width), f64::from(video.height));
    // The visible part of a rectangle, as its centre and size; a rectangle without a size
    // is the pointer.
    let visible = |rect: &Value| -> Option<(f64, f64, f64, f64)> {
        let number = |key: &str| rect.get(key).and_then(Value::as_f64).unwrap_or(0.0);
        let (x, y, w, h) = (number("x"), number("y"), number("width"), number("height"));
        if w == 0.0 && h == 0.0 {
            let inside = x >= 0.0 && y >= 0.0 && x <= width && y <= height;
            return inside.then_some((x, y, 0.0, 0.0));
        }
        let (left, top) = (x.max(0.0), y.max(0.0));
        let (right, bottom) = ((x + w).min(width), (y + h).min(height));
        (right > left && bottom > top).then(|| {
            (
                (left + right) / 2.0,
                (top + bottom) / 2.0,
                right - left,
                bottom - top,
            )
        })
    };

    let at = event.span();
    let mut samples = vec![(
        at.start,
        event.fields.get("rect").cloned().unwrap_or_default(),
    )];
    let track = event.fields.get("track").and_then(Value::as_array);
    for point in track.into_iter().flatten() {
        let offset = point["at_ms"].as_f64().unwrap_or(0.0) as i64;
        samples.push((at.start + offset, point["rect"].clone()));
    }

    let mut focus = Focus {
        start: 0,
        end: map_time(pieces, at.end),
        zoom: 1.0,
        path: Vec::new(),
    };
    for (time, rect) in samples {
        let Some((x, y, w, h)) = visible(&rect) else {
            continue;
        };
        let time = map_time(pieces, time);
        if focus.path.is_empty() {
            focus.start = time;
            focus.zoom = event.number("zoom");
            if w > 0.0 && h > 0.0 {
                focus.zoom = focus.zoom.min(width / w).min(height / h);
            }
            focus.zoom = focus.zoom.max(1.0);
        }
        focus.path.push(FocusPoint { time, x, y });
    }
    if focus.path.is_empty() || focus.end <= focus.start {
        return None;
    }
    if event.fields.get("follow").and_then(Value::as_str) == Some("pointer") {
        focus.path = dead_zone(&focus.path, width / focus.zoom, height / focus.zoom);
    }
    Some(focus)
}

/// Turns the pointer's path into the view's: the view moves only as far as keeps the
/// pointer inside the dead zone of a view of the given size.
fn dead_zone(path: &[FocusPoint], view_width: f64, view_height: f64) -> Vec<FocusPoint> {
    let (half_x, half_y) = (
        view_width * POINTER_DEAD_ZONE / 2.0,
        view_height * POINTER_DEAD_ZONE / 2.0,
    );
    let mut at = path[0];
    let mut view = vec![at];
    for point in &path[1..] {
        let x = (point.x - half_x).max(at.x.min(point.x + half_x));
        let y = (point.y - half_y).max(at.y.min(point.y + half_y));
        if x == at.x && y == at.y {
            continue;
        }
        at = FocusPoint {
            time: point.time,
            x,
            y,
        };
        view.push(at);
    }
    view
}

#[derive(Clone, Copy)]
struct FocusKey {
    time: i64,
    zoom: f64,
    x: f64,
    y: f64,
    /// Reached at a steady pace, not eased: a key of a followed path, so the view does not
    /// stop at every sample.
    steady: bool,
}

/// Zooms with ffmpeg's perspective filter, which stretches a source rectangle to the whole
/// frame. A zoom eases in and out inside its window; windows close to each other stay
/// zoomed in between and only pan, so adjacent focuses do not bounce.
fn focus_filters(mut zooms: Vec<Focus>, width: f64, height: f64, fps: u32) -> Vec<String> {
    zooms.sort_by_key(|zoom| zoom.start);
    let mut filters = Vec::new();
    let mut from = 0;
    while from < zooms.len() {
        let mut to = from + 1;
        while to < zooms.len() && zooms[to].start - zooms[to - 1].end <= FOCUS_MERGE_GAP_MS {
            to += 1;
        }
        let group = &zooms[from..to];
        from = to;

        let whole = |time| FocusKey {
            time,
            zoom: 1.0,
            x: width / 2.0,
            y: height / 2.0,
            steady: false,
        };
        let ease = FOCUS_EASE_MS.min((group[0].end - group[0].start) / 3);
        let mut keys = vec![whole(group[0].start)];
        for (index, focus) in group.iter().enumerate() {
            // The view's centre keeps the zoomed view inside the frame.
            let key = |time: i64, point: FocusPoint, steady: bool| {
                let (half_x, half_y) = (width / (2.0 * focus.zoom), height / (2.0 * focus.zoom));
                FocusKey {
                    time,
                    zoom: focus.zoom,
                    x: point.x.clamp(half_x, width - half_x),
                    y: point.y.clamp(half_y, height - half_y),
                    steady,
                }
            };
            let last = index == group.len() - 1;
            let hold = if last { focus.end - ease } else { focus.end };
            // The view eases in to where its subject is once the ease ends, then follows it.
            let arrived = focus.start + ease;
            let mut at = focus.path[0];
            let mut rest = &focus.path[1..];
            while let Some(next) = rest.first().filter(|next| next.time <= arrived) {
                at = *next;
                rest = &rest[1..];
            }
            keys.push(key(arrived, at, false));
            for point in rest {
                if point.time >= hold {
                    break;
                }
                keys.push(key(point.time, *point, true));
                at = *point;
            }
            let reached = keys.last().map_or(hold, |key| key.time);
            keys.push(key(hold.max(reached), at, false));
        }
        keys.push(whole(group[group.len() - 1].end));
        filters.push(focus_filter(&keys, width, height, fps));
    }
    filters
}

/// Plays keys, each a view the picture eases to from the one before, or moves to at a
/// steady pace when the key is steady. The filter counts input frames from one, so key
/// times become frame numbers, whole frames apart.
fn focus_filter(keys: &[FocusKey], width: f64, height: f64, fps: u32) -> String {
    let mut frames: Vec<i64> = Vec::with_capacity(keys.len());
    for key in keys {
        let frame = (key.time as f64 * f64::from(fps) / 1000.0).round() as i64;
        frames.push(frames.last().map_or(frame, |last| frame.max(last + 1)));
    }
    let edge = |value: &dyn Fn(&FocusKey) -> f64| {
        let mut expression = format!("{:.2}", value(&keys[0]));
        for index in 0..keys.len() - 1 {
            let delta = value(&keys[index + 1]) - value(&keys[index]);
            if delta.abs() < 0.005 {
                continue;
            }
            let (start, length) = (frames[index] + 1, frames[index + 1] - frames[index]);
            let _ = if keys[index + 1].steady {
                write!(expression, "{delta:+.2}*clip((in-{start})/{length},0,1)")
            } else {
                write!(
                    expression,
                    "{delta:+.2}*(1-cos(PI*clip((in-{start})/{length},0,1)))/2"
                )
            };
        }
        expression
    };
    let left = edge(&|key| key.x - width / (2.0 * key.zoom));
    let right = edge(&|key| key.x + width / (2.0 * key.zoom));
    let top = edge(&|key| key.y - height / (2.0 * key.zoom));
    let bottom = edge(&|key| key.y + height / (2.0 * key.zoom));
    let fps = f64::from(fps);
    let half = 0.5 / fps;
    format!(
        "perspective=x0='{left}':y0='{top}':x1='{right}':y1='{top}':x2='{left}':y2='{bottom}'\
         :x3='{right}':y3='{bottom}':interpolation=cubic:eval=frame\
         :enable='between(t,{:.4},{:.4})'",
        frames[0] as f64 / fps - half,
        frames[frames.len() - 1] as f64 / fps + half,
    )
}

/// The cues and ripples as an ASS script for ffmpeg's subtitle filter. A cue is white text
/// on a dark box near the bottom edge. A ripple is a ring, drawn as a vector shape, that
/// spreads from the click and fades; its dark shadow shows it on light pages.
fn subtitles(cues: &[Cue], ripples: &[Ripple], video: Video) -> String {
    const REFERENCE_WIDTH: f64 = 1280.0;
    const RIPPLE_RADIUS: f64 = 48.0;
    let (width, height) = (f64::from(video.width), f64::from(video.height));
    let font = ((height * 0.045).round() as i64).max(12);
    let margin = (width * 0.06).round() as i64;
    let bottom = (height * 0.06).round() as i64;
    let boxed = ((height * 0.008).round() as i64).max(2);
    let stamp = |ms: i64| {
        format!(
            "{}:{:02}:{:02}.{:02}",
            ms / 3_600_000,
            ms / 60_000 % 60,
            ms / 1000 % 60,
            ms % 1000 / 10
        )
    };

    let mut out = format!(
        "[Script Info]\nScriptType: v4.00+\nPlayResX: {}\nPlayResY: {}\nWrapStyle: 0\n\
         ScaledBorderAndShadow: yes\n\n",
        video.width, video.height
    );
    out.push_str(
        "[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, \
         OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, \
         Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n",
    );
    // Border style 3 draws the outline colour as a box behind the text.
    let _ = writeln!(
        out,
        "Style: Default,Noto Sans,{font},&H00FFFFFF,&H00FFFFFF,&H30000000,&H30000000,0,0,0,0,100,\
         100,0,0,3,{boxed},0,2,{margin},{margin},{bottom},1"
    );
    out.push_str(
        "Style: Ripple,Noto Sans,20,&HFF000000,&HFF000000,&H00FFFFFF,&H00000000,0,0,0,0,100,100,\
         0,0,1,1,0,5,0,0,0,1\n\n",
    );
    out.push_str(
        "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, \
         Text\n",
    );
    for cue in cues {
        // A backslash would start an override tag, so it becomes the fullwidth one.
        let text = cue
            .text
            .replace('\\', "＼")
            .replace('{', "\\{")
            .replace('}', "\\}");
        let _ = writeln!(
            out,
            "Dialogue: 0,{},{},Default,,0,0,0,,{text}",
            stamp(cue.start),
            stamp(cue.end)
        );
    }
    // A circle of radius 100 drawn with four curves, in the positive quarter so that it is
    // centred on the click.
    const CIRCLE: &str = "m 0 100 b 0 45 45 0 100 0 b 155 0 200 45 200 100 b 200 155 155 200 100 \
                          200 b 45 200 0 155 0 100";
    let scale = width / REFERENCE_WIDTH * RIPPLE_RADIUS;
    for ripple in ripples {
        let _ = writeln!(
            out,
            "Dialogue: 1,{},{},Ripple,,0,0,0,,{{\\an5\\pos({:.0},{:.0})\\bord{:.1}\\shad{:.1}\
             \\4c&H000000&\\fscx{:.0}\\fscy{:.0}\\t(0,{RIPPLE_MS},0.4,\\fscx{scale:.0}\
             \\fscy{scale:.0})\\t({},{RIPPLE_MS},\\3a&HFF&\\4a&HFF&)\\p1}}{CIRCLE}",
            stamp(ripple.start),
            stamp(ripple.start + RIPPLE_MS),
            ripple.x,
            ripple.y,
            5.0 * width / REFERENCE_WIDTH,
            3.0 * width / REFERENCE_WIDTH,
            scale * 0.3,
            scale * 0.3,
            RIPPLE_MS / 2,
        );
    }
    out
}

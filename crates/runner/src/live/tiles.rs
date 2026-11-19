//! A target's picture as tiles: the parts that changed, each as a PNG image. It is what a
//! client gets that can neither take video over WebRTC nor decode it itself.

use std::sync::Arc;

use aperture_compositor::{Frame, Frames, Handle, Pixels, WindowId};
use tokio::sync::{mpsc, watch};
use tracing::warn;

use crate::proto::aperture::live::v1 as pb;

/// The tab to make tiles of, and its window.
pub type Watched = Option<(u32, WindowId)>;

/// The picture is compared in cells this many pixels a side; a tile covers whole cells.
const CELL: usize = 64;

/// Above this many changed parts of a picture, they are sent as the one tile around them.
const MAX_TILES: usize = 16;

/// Starts making tiles of whatever `watched` names. A tile waits for the client to take the
/// one before it; changes that come meanwhile are in the next ones.
pub fn start(compositor: Handle) -> (watch::Sender<Watched>, mpsc::Receiver<pb::Tile>) {
    let (watch, watched) = watch::channel(None);
    let (tiles, taken) = mpsc::channel(1);
    tokio::spawn(make(compositor, watched, tiles));
    (watch, taken)
}

async fn make(
    compositor: Handle,
    mut watched: watch::Receiver<Watched>,
    tiles: mpsc::Sender<pb::Tile>,
) {
    let mut tab = 0;
    // With what holds them as pixels in memory, which tiles are made of.
    let mut frames: Option<(Frames, Pixels)> = None;
    // What the client has, to tell what changed.
    let mut sent: Option<Arc<Frame>> = None;
    loop {
        tokio::select! {
            changed = watched.changed() => {
                if changed.is_err() {
                    return;
                }
                let now = *watched.borrow_and_update();
                sent = None;
                frames = match now {
                    Some((watched, window)) => {
                        tab = watched;
                        match (compositor.frames(window).await, compositor.pixels(window).await) {
                            (Ok(mut frames), Ok(pixels)) => {
                                frames.mark_changed();
                                Some((frames, pixels))
                            }
                            _ => None,
                        }
                    }
                    None => None,
                };
            }
            changed = async { frames.as_mut().expect("checked by the guard").0.changed().await },
                if frames.is_some() =>
            {
                // The window closed.
                if changed.is_err() {
                    frames = None;
                    continue;
                }
                let frame = frames
                    .as_mut()
                    .and_then(|(frames, _)| frames.borrow_and_update().clone());
                let Some(frame) = frame else {
                    continue;
                };
                // A frame drawn for another watcher before the pixels were asked for has
                // none in memory; the next one does.
                if frame.rgba.len() != frame.width as usize * frame.height as usize * 4 {
                    continue;
                }
                let before = sent.replace(frame.clone());
                let made =
                    tokio::task::spawn_blocking(move || update(tab, &frame, before.as_deref()));
                match made.await {
                    Ok(Ok(update)) => {
                        for tile in update {
                            if tiles.send(tile).await.is_err() {
                                return;
                            }
                        }
                    }
                    // The part of the picture stays as it was until a tile covers it again.
                    Ok(Err(err)) => warn!(%err, "failed to make a tile"),
                    Err(err) => {
                        warn!(%err, "the tiles end: what made them did");
                        return;
                    }
                }
            }
        }
    }
}

/// A part of a picture: left, top, right and bottom, in pixels.
type Part = (usize, usize, usize, usize);

/// The tiles that bring a client that has `before` up to `frame`: the parts the two differ
/// in, or the whole picture where there is nothing to go from.
fn update(
    tab: u32,
    frame: &Frame,
    before: Option<&Frame>,
) -> Result<Vec<pb::Tile>, png::EncodingError> {
    let (width, height) = (frame.width as usize, frame.height as usize);
    let parts = match before
        .filter(|before| (before.width, before.height) == (frame.width, frame.height))
    {
        Some(before) => changed(frame, before),
        None => vec![(0, 0, width, height)],
    };
    parts
        .into_iter()
        .map(|part| tile(tab, frame, part))
        .collect()
}

/// The parts of the picture that differ between two frames of one size, as rectangles of
/// whole cells: a row of cells gives its runs of changed cells, and a run right below one
/// of the same span joins it.
fn changed(frame: &Frame, before: &Frame) -> Vec<Part> {
    let (width, height) = (frame.width as usize, frame.height as usize);
    let stride = width * 4;
    let mut parts: Vec<Part> = Vec::new();
    // Where the parts that reach the row of cells above start in `parts`.
    let mut above = 0;
    for top in (0..height).step_by(CELL) {
        let bottom = (top + CELL).min(height);
        let band = top * stride..bottom * stride;
        let open = parts.len();
        if frame.rgba[band.clone()] != before.rgba[band.clone()] {
            let differs = |left: usize| {
                let right = (left + CELL).min(width);
                let rows = frame.rgba[band.clone()].chunks_exact(stride);
                rows.zip(before.rgba[band.clone()].chunks_exact(stride))
                    .any(|(new, old)| new[left * 4..right * 4] != old[left * 4..right * 4])
            };
            let mut run: Option<usize> = None;
            for left in (0..width).step_by(CELL).chain([width]) {
                if left < width && differs(left) {
                    run.get_or_insert(left);
                } else if let Some(from) = run.take() {
                    let joined = parts[above..open]
                        .iter_mut()
                        .find(|part| (part.0, part.2, part.3) == (from, left, top));
                    match joined {
                        Some(part) => part.3 = bottom,
                        None => parts.push((from, top, left, bottom)),
                    }
                }
            }
        }
        // Those that were joined, and the new ones, reach this row; they are put last.
        let mut reaching: Vec<Part> = Vec::new();
        parts.retain(|part| {
            part.3 != bottom || {
                reaching.push(*part);
                false
            }
        });
        above = parts.len();
        parts.extend(reaching);
    }
    if parts.len() > MAX_TILES {
        let around = parts.iter().fold((width, height, 0, 0), |around, part| {
            (
                around.0.min(part.0),
                around.1.min(part.1),
                around.2.max(part.2),
                around.3.max(part.3),
            )
        });
        return vec![around];
    }
    parts
}

fn tile(
    tab: u32,
    frame: &Frame,
    (left, top, right, bottom): Part,
) -> Result<pb::Tile, png::EncodingError> {
    let stride = frame.width as usize * 4;

    // Pages are opaque, so the alpha is left out.
    let mut rgb = Vec::with_capacity((right - left) * (bottom - top) * 3);
    for row in frame.rgba.chunks_exact(stride).take(bottom).skip(top) {
        for pixel in row[left * 4..right * 4].chunks_exact(4) {
            rgb.extend_from_slice(&pixel[..3]);
        }
    }
    let mut png = Vec::new();
    let mut encoder = png::Encoder::new(&mut png, (right - left) as u32, (bottom - top) as u32);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_compression(png::Compression::Fast);
    encoder.write_header()?.write_image_data(&rgb)?;
    Ok(pb::Tile {
        tab,
        x: left as u32,
        y: top as u32,
        width: frame.width,
        height: frame.height,
        png,
        ..Default::default()
    })
}

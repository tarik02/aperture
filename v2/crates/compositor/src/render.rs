use smithay::{
    backend::{
        allocator::Fourcc,
        renderer::{
            Bind, ExportMem, Offscreen,
            damage::OutputDamageTracker,
            element::{
                AsRenderElements, Kind,
                memory::MemoryRenderBufferRenderElement,
                render_elements,
                surface::{WaylandSurfaceRenderElement, render_elements_from_surface_tree},
            },
            pixman::PixmanRenderer,
        },
    },
    desktop::{PopupManager, Window, utils::bbox_from_surface_tree},
    reexports::pixman::Image,
    utils::{Logical, Physical, Point, Rectangle, Scale, Size, Transform},
};

use crate::{Error, cursor::PointerImage};

render_elements! {
    FrameElement<=PixmanRenderer>;
    Surface=WaylandSurfaceRenderElement<PixmanRenderer>,
    Pointer=MemoryRenderBufferRenderElement<PixmanRenderer>,
}

/// Windows are drawn at one physical pixel per logical one.
const SCALE: f64 = 1.0;

/// The frame of a window in its surface coordinates: the window geometry (client-side
/// shadows excluded) grown right and down to fit open popups.
pub fn frame_rect(window: &Window) -> Rectangle<i32, Logical> {
    let geometry = window.geometry();
    let mut rect = geometry;
    if let Some(toplevel) = window.toplevel() {
        for (popup, offset) in PopupManager::popups_for_surface(toplevel.wl_surface()) {
            let location = geometry.loc + offset - popup.geometry().loc;
            rect = rect.merge(bbox_from_surface_tree(popup.wl_surface(), location));
        }
    }
    let bottom_right = rect.loc + rect.size;
    Rectangle::from_extremities(geometry.loc, bottom_right)
}

/// A persistent offscreen image of one window, redrawn incrementally and read back into
/// memory after every change.
pub struct WindowFrame {
    image: Image<'static, 'static>,
    tracker: OutputDamageTracker,
    size: Size<i32, Physical>,
    /// The frame as tightly packed premultiplied RGBA.
    pixels: Vec<u8>,
}

impl WindowFrame {
    fn new(renderer: &mut PixmanRenderer, size: Size<i32, Physical>) -> Result<Self, Error> {
        let buffer_size = size.to_logical(1).to_buffer(1, Transform::Normal);
        let image = renderer
            .create_buffer(Fourcc::Abgr8888, buffer_size)
            .map_err(render_error)?;
        Ok(Self {
            image,
            tracker: OutputDamageTracker::new(size, SCALE, Transform::Normal),
            size,
            pixels: Vec::new(),
        })
    }

    pub fn size(&self) -> (u32, u32) {
        (self.size.w.unsigned_abs(), self.size.h.unsigned_abs())
    }

    pub fn pixels(&self) -> &[u8] {
        &self.pixels
    }

    /// Renders `window` into `frame`, reallocating it when the frame size changed, with the
    /// pointer on top where one is given, by its position in the window's surface
    /// coordinates. Returns what changed, nothing when the window looks as it did. A window
    /// without content leaves no frame.
    pub fn render(
        frame: &mut Option<Self>,
        renderer: &mut PixmanRenderer,
        window: &Window,
        pointer: Option<(Point<f64, Logical>, &PointerImage)>,
    ) -> Result<Option<Change>, Error> {
        let rect = frame_rect(window);
        let size: Size<i32, Physical> = rect.size.to_physical_precise_round(SCALE);
        if size.w <= 0 || size.h <= 0 {
            *frame = None;
            return Ok(None);
        }
        let resized = frame.as_ref().is_none_or(|frame| frame.size != size);
        let frame = if resized {
            frame.insert(Self::new(renderer, size)?)
        } else {
            frame.as_mut().expect("checked above")
        };

        let location: Point<i32, Physical> =
            Point::<i32, Logical>::from((-rect.loc.x, -rect.loc.y))
                .to_physical_precise_round(SCALE);
        // Front to back: the pointer is over everything.
        let mut elements: Vec<FrameElement> = Vec::new();
        if let Some((position, image)) = pointer {
            let position = position - rect.loc.to_f64();
            match image {
                PointerImage::Themed(buffer, hotspot) => {
                    let at = (position - hotspot.to_f64()).to_physical(SCALE);
                    let element = MemoryRenderBufferRenderElement::from_buffer(
                        renderer,
                        at,
                        buffer,
                        None,
                        None,
                        None,
                        Kind::Cursor,
                    )
                    .map_err(render_error)?;
                    elements.push(FrameElement::Pointer(element));
                }
                PointerImage::Surface(surface, hotspot) => {
                    let at: Point<i32, Physical> = (position - hotspot.to_f64())
                        .to_physical(SCALE)
                        .to_i32_round();
                    elements.extend(
                        render_elements_from_surface_tree(
                            renderer,
                            surface,
                            at,
                            Scale::from(SCALE),
                            1.0,
                            Kind::Cursor,
                        )
                        .into_iter()
                        .map(FrameElement::Surface),
                    );
                }
            }
        }
        elements.extend(
            window
                .render_elements(renderer, location, Scale::from(SCALE), 1.0)
                .into_iter()
                .map(FrameElement::Surface),
        );

        // The image is reused, so it always holds the previous frame (age 1).
        let age = if resized { 0 } else { 1 };
        let mut target = renderer.bind(&mut frame.image).map_err(render_error)?;
        let result = frame
            .tracker
            .render_output(renderer, &mut target, age, &elements, [0.0, 0.0, 0.0, 0.0])
            .map_err(|err| Error::Render(format!("{err:?}")))?;
        let region = if frame.pixels.is_empty() {
            Some(Rectangle::from_size(size))
        } else {
            result
                .damage
                .into_iter()
                .flatten()
                .copied()
                .reduce(|a, b| a.merge(b))
        };
        let Some(region) =
            region.and_then(|region| region.intersection(Rectangle::from_size(size)))
        else {
            return Ok(None);
        };
        if region.is_empty() {
            return Ok(None);
        }

        let buffer_region = Rectangle::new(
            (region.loc.x, region.loc.y).into(),
            (region.size.w, region.size.h).into(),
        );
        let mapping = renderer
            .copy_framebuffer(&target, buffer_region, Fourcc::Abgr8888)
            .map_err(render_error)?;
        let data = renderer.map_texture(&mapping).map_err(render_error)?;
        let first = frame.pixels.is_empty();
        if first {
            frame.pixels = vec![0; size.w as usize * size.h as usize * 4];
        }
        // Clients say more is damaged than changed, often the whole window for a blinking
        // caret, so what changed is counted from the pixels themselves.
        let mut change = Change {
            pixels: 0,
            left: usize::MAX,
            top: usize::MAX,
            right: 0,
            bottom: 0,
        };
        let stride = size.w as usize * 4;
        let row = region.size.w as usize * 4;
        for (y, source) in data
            .chunks_exact(row)
            .take(region.size.h as usize)
            .enumerate()
        {
            let y = region.loc.y as usize + y;
            let start = y * stride + region.loc.x as usize * 4;
            let kept = &mut frame.pixels[start..start + row];
            // Where in the row pixels differ, from the first to after the last.
            let (from, to) = if first {
                (0, region.size.w as usize)
            } else if kept != source {
                let differs: Vec<bool> = kept
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .zip(source.as_chunks::<4>().0)
                    .map(|(old, new)| old != new)
                    .collect();
                change.pixels += differs.iter().filter(|differs| **differs).count() as u64;
                let from = differs.iter().position(|differs| *differs).unwrap_or(0);
                let to = differs
                    .iter()
                    .rposition(|differs| *differs)
                    .map_or(0, |at| at + 1);
                (from, to)
            } else {
                continue;
            };
            if first {
                change.pixels += region.size.w as u64;
            }
            let x = region.loc.x as usize;
            change.left = change.left.min(x + from);
            change.right = change.right.max(x + to);
            change.top = change.top.min(y);
            change.bottom = change.bottom.max(y + 1);
            kept.copy_from_slice(source);
        }
        Ok((change.pixels > 0).then_some(change))
    }
}

/// What changed in a window's picture from one frame to the next: how many pixels, and the
/// rectangle they are in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Change {
    pub pixels: u64,
    pub left: usize,
    pub top: usize,
    pub right: usize,
    pub bottom: usize,
}

impl Change {
    pub fn area(&self) -> u64 {
        ((self.right - self.left) * (self.bottom - self.top)) as u64
    }
}

fn render_error(err: impl std::fmt::Display) -> Error {
    Error::Render(err.to_string())
}

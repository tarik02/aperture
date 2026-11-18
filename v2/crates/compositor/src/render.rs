use std::{
    fs::File,
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::Context;
use smithay::{
    backend::{
        allocator::{
            Allocator, Fourcc, Modifier,
            dmabuf::{AsDmabuf, Dmabuf},
            format::FormatSet,
            gbm::{GbmAllocator, GbmBufferFlags, GbmDevice},
        },
        drm::DrmNode,
        egl::{EGLContext, EGLDevice, EGLDisplay},
        renderer::{
            Bind, ExportMem, ImportAll, ImportDma, ImportMem, Offscreen, Texture,
            damage::OutputDamageTracker,
            element::{
                AsRenderElements, Kind,
                memory::MemoryRenderBufferRenderElement,
                render_elements,
                surface::{WaylandSurfaceRenderElement, render_elements_from_surface_tree},
            },
            gles::{GlesRenderer, GlesTexture},
            pixman::PixmanRenderer,
        },
    },
    desktop::{PopupManager, Window, utils::bbox_from_surface_tree},
    reexports::pixman::Image,
    utils::{Logical, Physical, Point, Rectangle, Scale, Size, Transform},
};
use tracing::{info, warn};

use crate::{Error, GpuBuffer, cursor::PointerImage};

render_elements! {
    FrameElement<R> where R: ImportAll + ImportMem;
    Surface=WaylandSurfaceRenderElement<R>,
    Pointer=MemoryRenderBufferRenderElement<R>,
}

/// What draws the windows: the GPU, through GLES on a render node, or the CPU, through
/// pixman, where no GPU works.
pub enum Renderer {
    // Boxed: the GLES renderer is two orders of magnitude larger than pixman's.
    Gles(Box<Gles>),
    Pixman(PixmanRenderer),
}

pub struct Gles {
    renderer: GlesRenderer,
    /// Makes the buffers frames are drawn into for others to take on the GPU, in the
    /// layouts those others take; none when there is no such layout.
    shared: Option<(GbmAllocator<File>, Vec<Modifier>)>,
}

/// The GPU that draws, for clients to share their buffers with.
pub struct Gpu {
    pub node: DrmNode,
    /// The device file of the render node.
    pub path: PathBuf,
    /// The buffer formats the renderer takes.
    pub formats: FormatSet,
}

impl Renderer {
    /// On the first GPU with a render node when `gpu` is wanted and one works. Frames stay
    /// on it, for others to take, when it draws into one of the `layouts`.
    pub fn new(gpu: bool, layouts: &[u64]) -> anyhow::Result<(Self, Option<Gpu>)> {
        if gpu {
            match gles() {
                Ok((renderer, gpu)) => {
                    let shared = match allocator(&gpu.path, &renderer, layouts) {
                        Ok(shared) => shared,
                        Err(err) => {
                            warn!("frames cannot stay on the GPU: {err:#}");
                            None
                        }
                    };
                    info!(
                        node = %gpu.path.display(),
                        frames_stay = shared.is_some(),
                        "drawing on the GPU"
                    );
                    let gles = Gles { renderer, shared };
                    return Ok((Self::Gles(Box::new(gles)), Some(gpu)));
                }
                Err(err) => warn!("no usable GPU, drawing on the CPU: {err:#}"),
            }
        }
        let renderer = PixmanRenderer::new().context("failed to create the pixman renderer")?;
        Ok((Self::Pixman(renderer), None))
    }

    /// Takes a client's buffer, which tells whether the GPU can use it.
    pub fn import_dmabuf(&mut self, dmabuf: &Dmabuf) -> bool {
        match self {
            Self::Gles(gles) => gles.renderer.import_dmabuf(dmabuf, None).is_ok(),
            Self::Pixman(_) => false,
        }
    }
}

/// What makes buffers on the GPU's render node that the renderer draws into and that have
/// one of the `layouts`, if there is such a layout.
fn allocator(
    node: &Path,
    renderer: &GlesRenderer,
    layouts: &[u64],
) -> anyhow::Result<Option<(GbmAllocator<File>, Vec<Modifier>)>> {
    let modifiers: Vec<Modifier> = renderer
        .egl_context()
        .dmabuf_render_formats()
        .iter()
        .filter(|format| format.code == Fourcc::Abgr8888)
        .map(|format| format.modifier)
        .filter(|modifier| layouts.contains(&u64::from(*modifier)))
        .collect();
    if modifiers.is_empty() {
        return Ok(None);
    }
    let file = File::options()
        .read(true)
        .write(true)
        .open(node)
        .context("failed to open the render node")?;
    let device = GbmDevice::new(file).context("failed to open the render node for buffers")?;
    let allocator = GbmAllocator::new(device, GbmBufferFlags::RENDERING);
    Ok(Some((allocator, modifiers)))
}

fn gles() -> anyhow::Result<(GlesRenderer, Gpu)> {
    let (device, node, path) = EGLDevice::enumerate()
        .context("failed to list EGL devices")?
        .find_map(|device| {
            let node = device.try_get_render_node().ok().flatten()?;
            let path = node.dev_path()?;
            Some((device, node, path))
        })
        .context("no EGL device with a render node")?;
    // Safety: the display outlives every context and renderer made from it.
    let display = unsafe { EGLDisplay::new(device) }.context("failed to open the EGL display")?;
    let context = EGLContext::new(&display).context("failed to create an EGL context")?;
    // Safety: the context is current only on the compositor's thread, through this renderer.
    let renderer =
        unsafe { GlesRenderer::new(context) }.context("failed to create the GLES renderer")?;
    let formats = renderer.dmabuf_formats();
    Ok((
        renderer,
        Gpu {
            node,
            path,
            formats,
        },
    ))
}

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

enum Buffer {
    Gles(GlesTexture),
    Shared(Pool),
    Pixman(Image<'static, 'static>),
}

/// The most buffers a window is drawn into in turn; what the damage tracker remembers
/// frames back for.
const POOL: usize = 4;

/// The buffers a window is drawn into in turn, each handed on with its frame: a frame
/// someone still holds is not drawn over.
#[derive(Default)]
struct Pool {
    slots: Vec<Slot>,
    /// How many frames were drawn.
    drawn: u64,
}

struct Slot {
    dmabuf: Dmabuf,
    /// Held by everyone the buffer was handed to.
    lease: Arc<()>,
    /// The count of frames with the one drawn into this buffer, if it holds one.
    holds: Option<u64>,
}

impl Pool {
    /// The buffer to draw the next frame into, and its age: how many frames back the one
    /// it holds is, none with 0. A free one whose frame is the most recent; a new one
    /// when all are held, in place of the oldest when there are [`POOL`] already.
    fn next(
        &mut self,
        gles: &mut Gles,
        size: Size<i32, Physical>,
    ) -> Result<(usize, usize), Error> {
        let free = self
            .slots
            .iter()
            .enumerate()
            .filter(|(_, slot)| Arc::strong_count(&slot.lease) == 1)
            .max_by_key(|(_, slot)| slot.holds)
            .map(|(at, _)| at);
        let at = match free {
            Some(at) => at,
            None => {
                let (allocator, modifiers) = gles.shared.as_mut().expect("the pool is of one");
                let dmabuf = allocator
                    .create_buffer(
                        size.w.unsigned_abs(),
                        size.h.unsigned_abs(),
                        Fourcc::Abgr8888,
                        modifiers,
                    )
                    .map_err(render_error)?
                    .export()
                    .map_err(render_error)?;
                let slot = Slot {
                    dmabuf,
                    lease: Arc::new(()),
                    holds: None,
                };
                if self.slots.len() < POOL {
                    self.slots.push(slot);
                    self.slots.len() - 1
                } else {
                    let (oldest, _) = self
                        .slots
                        .iter()
                        .enumerate()
                        .min_by_key(|(_, slot)| slot.holds)
                        .expect("the pool is full");
                    self.slots[oldest] = slot;
                    oldest
                }
            }
        };
        let age = self.slots[at]
            .holds
            .map_or(0, |held| (self.drawn - held + 1) as usize);
        Ok((at, if age > POOL { 0 } else { age }))
    }
}

/// A persistent offscreen image of one window, redrawn incrementally. It is read back
/// into memory after every change when that is asked for, and where it is not drawn
/// into buffers that are handed on.
pub struct WindowFrame {
    buffer: Buffer,
    tracker: OutputDamageTracker,
    size: Size<i32, Physical>,
    /// Pixels per logical one.
    scale: f64,
    /// The frame as tightly packed premultiplied RGBA; empty when it is not read back.
    pixels: Vec<u8>,
    /// The buffer the frame is in.
    shared: Option<GpuBuffer>,
}

/// The pointer to draw over a window: where it is, in the window's surface coordinates,
/// and what it looks like.
pub type Pointer<'a> = (Point<f64, Logical>, &'a PointerImage);

impl WindowFrame {
    fn new(
        renderer: &mut Renderer,
        size: Size<i32, Physical>,
        scale: f64,
        share: bool,
    ) -> Result<Self, Error> {
        let buffer_size = size.to_logical(1).to_buffer(1, Transform::Normal);
        let buffer = match renderer {
            Renderer::Gles(gles) if share && gles.shared.is_some() => {
                Buffer::Shared(Pool::default())
            }
            Renderer::Gles(gles) => Buffer::Gles(
                Offscreen::<GlesTexture>::create_buffer(
                    &mut gles.renderer,
                    Fourcc::Abgr8888,
                    buffer_size,
                )
                .map_err(render_error)?,
            ),
            Renderer::Pixman(renderer) => Buffer::Pixman(
                renderer
                    .create_buffer(Fourcc::Abgr8888, buffer_size)
                    .map_err(render_error)?,
            ),
        };
        Ok(Self {
            buffer,
            tracker: OutputDamageTracker::new(size, scale, Transform::Normal),
            size,
            scale,
            pixels: Vec::new(),
            shared: None,
        })
    }

    pub fn size(&self) -> (u32, u32) {
        (self.size.w.unsigned_abs(), self.size.h.unsigned_abs())
    }

    /// Empty when the frame was not read back.
    pub fn pixels(&self) -> &[u8] {
        &self.pixels
    }

    /// The frame on the GPU, where it stays there.
    pub fn shared(&self) -> Option<GpuBuffer> {
        self.shared.clone()
    }

    /// Renders `window` into `frame` at `scale` pixels to a logical one, reallocating it
    /// when the frame's size or scale changed, with the
    /// pointer on top where one is given. Returns what changed, nothing when the window
    /// looks as it did. A window without content leaves no frame.
    ///
    /// With `share` the frame stays on the GPU for others to take, where the renderer can
    /// do that, and is read back into memory only with `read_back`; it always is
    /// otherwise. A frame that is not read back counts as changed wherever the window
    /// says it is.
    pub fn render(
        frame: &mut Option<Self>,
        renderer: &mut Renderer,
        window: &Window,
        scale: f64,
        pointer: Option<Pointer<'_>>,
        share: bool,
        read_back: bool,
    ) -> Result<Option<Change>, Error> {
        let rect = frame_rect(window);
        let size: Size<i32, Physical> = rect.size.to_physical_precise_round(scale);
        if size.w <= 0 || size.h <= 0 {
            *frame = None;
            return Ok(None);
        }
        let resized = frame
            .as_ref()
            .is_none_or(|frame| frame.size != size || frame.scale != scale);
        let frame = if resized {
            frame.insert(Self::new(renderer, size, scale, share)?)
        } else {
            frame.as_mut().expect("checked above")
        };
        // The buffer is reused, so it always holds the previous frame (age 1).
        let age = if resized { 0 } else { 1 };
        let WindowFrame {
            buffer,
            tracker,
            pixels,
            shared,
            ..
        } = frame;
        let drawn = match (renderer, buffer) {
            (Renderer::Gles(gles), Buffer::Gles(texture)) => draw(
                &mut gles.renderer,
                texture,
                tracker,
                age,
                window,
                rect,
                scale,
                pointer,
                Some(pixels),
            )?,
            (Renderer::Gles(gles), Buffer::Shared(pool)) => {
                if !read_back {
                    pixels.clear();
                }
                let (at, age) = pool.next(gles, size)?;
                let mut dmabuf = pool.slots[at].dmabuf.clone();
                let drawn = draw(
                    &mut gles.renderer,
                    &mut dmabuf,
                    tracker,
                    age,
                    window,
                    rect,
                    scale,
                    pointer,
                    read_back.then_some(pixels),
                );
                match drawn {
                    Ok(Drawn::Nothing) => {}
                    Ok(_) => {
                        pool.drawn += 1;
                        let slot = &mut pool.slots[at];
                        slot.holds = Some(pool.drawn);
                        *shared = Some(GpuBuffer {
                            dmabuf,
                            lease: slot.lease.clone(),
                        });
                    }
                    // The tracker forgot what it drew, and the buffer may hold part of a
                    // frame.
                    Err(_) => pool.slots.iter_mut().for_each(|slot| slot.holds = None),
                }
                drawn?
            }
            (Renderer::Pixman(renderer), Buffer::Pixman(image)) => draw(
                renderer,
                image,
                tracker,
                age,
                window,
                rect,
                scale,
                pointer,
                Some(pixels),
            )?,
            _ => unreachable!("frames are made by the renderer that draws them"),
        };
        Ok(match drawn {
            Drawn::Changed(change) => Some(change),
            Drawn::Nothing | Drawn::Same => None,
        })
    }
}

enum Drawn {
    /// The window says nothing of it changed, and nothing was drawn.
    Nothing,
    /// The frame was drawn and looks as the one before.
    Same,
    Changed(Change),
}

/// Draws the window into `buffer` and reads what changed back into `pixels`, where there
/// are any to read into.
#[allow(clippy::too_many_arguments)]
fn draw<R, T>(
    renderer: &mut R,
    buffer: &mut T,
    tracker: &mut OutputDamageTracker,
    age: usize,
    window: &Window,
    rect: Rectangle<i32, Logical>,
    scale: f64,
    pointer: Option<Pointer<'_>>,
    pixels: Option<&mut Vec<u8>>,
) -> Result<Drawn, Error>
where
    R: smithay::backend::renderer::Renderer + ImportAll + ImportMem + Bind<T> + ExportMem,
    R::TextureId: Texture + Clone + Send + 'static,
    R::Error: std::error::Error + 'static,
{
    let size: Size<i32, Physical> = rect.size.to_physical_precise_round(scale);
    let location: Point<i32, Physical> =
        Point::<i32, Logical>::from((-rect.loc.x, -rect.loc.y)).to_physical_precise_round(scale);
    // Front to back: the pointer is over everything.
    let mut elements: Vec<FrameElement<R>> = Vec::new();
    if let Some((position, image)) = pointer {
        let position = position - rect.loc.to_f64();
        match image {
            PointerImage::Themed(buffer, hotspot) => {
                let at = (position - hotspot.to_f64()).to_physical(scale);
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
                    .to_physical(scale)
                    .to_i32_round();
                elements.extend(
                    render_elements_from_surface_tree(
                        renderer,
                        surface,
                        at,
                        Scale::from(scale),
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
            .render_elements(renderer, location, Scale::from(scale), 1.0)
            .into_iter()
            .map(FrameElement::Surface),
    );

    let mut target = renderer.bind(buffer).map_err(render_error)?;
    let result = tracker
        .render_output(renderer, &mut target, age, &elements, [0.0, 0.0, 0.0, 0.0])
        .map_err(|err| Error::Render(format!("{err:?}")))?;
    let Some(damage) = result.damage else {
        return Ok(Drawn::Nothing);
    };
    let whole = Rectangle::from_size(size);
    let damage = damage
        .iter()
        .filter_map(|damage| damage.intersection(whole))
        .filter(|damage| !damage.is_empty());
    let Some(region) = damage.clone().reduce(|a, b| a.merge(b)) else {
        return Ok(Drawn::Same);
    };
    let Some(pixels) = pixels else {
        // Whoever takes the buffer reads it once it is drawn.
        result.sync.wait().map_err(render_error)?;
        return Ok(Drawn::Changed(Change {
            pixels: damage
                .map(|damage| damage.size.w as u64 * damage.size.h as u64)
                .sum(),
            left: region.loc.x as usize,
            top: region.loc.y as usize,
            right: (region.loc.x + region.size.w) as usize,
            bottom: (region.loc.y + region.size.h) as usize,
        }));
    };
    let first = pixels.is_empty();
    let region = if first { whole } else { region };

    let buffer_region = Rectangle::new(
        (region.loc.x, region.loc.y).into(),
        (region.size.w, region.size.h).into(),
    );
    let mapping = renderer
        .copy_framebuffer(&target, buffer_region, Fourcc::Abgr8888)
        .map_err(render_error)?;
    let data = renderer.map_texture(&mapping).map_err(render_error)?;
    if first {
        *pixels = vec![0; size.w as usize * size.h as usize * 4];
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
        let kept = &mut pixels[start..start + row];
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
    Ok(if change.pixels > 0 {
        Drawn::Changed(change)
    } else {
        Drawn::Same
    })
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

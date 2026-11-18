//! The pointer's image, for drawing it into frames: a named cursor from the cursor theme, or
//! the surface a client draws its own cursor on.

use std::{collections::HashMap, fs, path::PathBuf};

use smithay::{
    backend::{allocator::Fourcc, renderer::element::memory::MemoryRenderBuffer},
    input::pointer::{CursorImageStatus, CursorImageSurfaceData},
    reexports::wayland_server::protocol::wl_surface::WlSurface,
    utils::{Logical, Point, Transform},
    wayland::compositor::with_states,
};
use tracing::debug;

/// The size cursors are drawn at, in pixels.
const SIZE: u32 = 24;

/// What to draw for the pointer, and where in it the pointer's position is.
pub enum PointerImage {
    Themed(MemoryRenderBuffer, Point<i32, Logical>),
    Surface(WlSurface, Point<i32, Logical>),
}

/// A cursor of the theme: its image, and where in it the pointer's position is.
type Themed = (MemoryRenderBuffer, Point<i32, Logical>);

/// Cursors of the theme, loaded as they are first asked for.
pub struct Theme {
    dir: Option<PathBuf>,
    loaded: HashMap<&'static str, Option<Themed>>,
}

impl Theme {
    pub fn new(dir: Option<PathBuf>) -> Self {
        Self {
            dir,
            loaded: HashMap::new(),
        }
    }

    pub fn image(&mut self, status: &CursorImageStatus) -> Option<PointerImage> {
        match status {
            CursorImageStatus::Hidden => None,
            CursorImageStatus::Named(icon) => self
                .named(icon.name())
                .or_else(|| self.named("default"))
                .map(|(buffer, hotspot)| PointerImage::Themed(buffer, hotspot)),
            CursorImageStatus::Surface(surface) => {
                let hotspot = with_states(surface, |states| {
                    states
                        .data_map
                        .get::<CursorImageSurfaceData>()
                        .and_then(|data| data.lock().ok().map(|attributes| attributes.hotspot))
                })
                .unwrap_or_default();
                Some(PointerImage::Surface(surface.clone(), hotspot))
            }
        }
    }

    fn named(&mut self, name: &'static str) -> Option<Themed> {
        let dir = self.dir.as_ref()?;
        self.loaded
            .entry(name)
            .or_insert_with(|| {
                let path = dir.join("cursors").join(name);
                let images = fs::read(&path)
                    .ok()
                    .and_then(|bytes| xcursor::parser::parse_xcursor(&bytes));
                let Some(images) = images else {
                    debug!(cursor = name, "the cursor theme has no such cursor");
                    return None;
                };
                // Themes hold each cursor at several sizes.
                let image = images
                    .iter()
                    .min_by_key(|image| image.size.abs_diff(SIZE))?;
                let buffer = MemoryRenderBuffer::from_slice(
                    &image.pixels_rgba,
                    Fourcc::Abgr8888,
                    (image.width as i32, image.height as i32),
                    1,
                    Transform::Normal,
                    None,
                );
                Some((buffer, (image.xhot as i32, image.yhot as i32).into()))
            })
            .clone()
    }
}

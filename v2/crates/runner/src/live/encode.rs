//! Window frames as video, through GStreamer: on the GPU where one encodes, in software
//! otherwise.
//!
//! The best quality is a constant one, not a bitrate: frames only come when a window
//! changes, and what the link carries is then not the limit. The qualities below it are
//! bitrates, for links that carry no more; a window at rest is encoded a few times over
//! there, so that it comes to look as it does.
//!
//! A frame the GPU drew goes to an encoder on the same GPU as it is, without passing
//! through memory; a software encoder takes its pixels.

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
};

use anyhow::{Context, bail, ensure};
use aperture_compositor::{Frame, GpuBuffer};
use gstreamer::{self as gst, prelude::*};
use gstreamer_allocators::{self as gst_allocators, DmaBufAllocatorExtManual};
use gstreamer_app as gst_app;
use gstreamer_video as gst_video;
use std::os::fd::{AsRawFd, OwnedFd};
use tracing::{debug, info, warn};

/// The form a window's video takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Format {
    /// H.264 constrained baseline, 4:2:0. Everything decodes it, WebRTC included; colored
    /// text loses detail.
    H264,
    /// H.264 High 4:4:4: color as sharp as light. Software decodes it, WebRTC does not.
    FullChroma,
    /// H.265 Main, 4:2:0: about half the bits of H.264 for the same picture, where the
    /// client's hardware decodes it.
    H265,
    /// VP9 profile 0, 4:2:0.
    Vp9,
    /// VP9 profile 1, 4:4:4: color as sharp as light, also over WebRTC.
    Vp9FullChroma,
    /// AV1 main, 4:2:0. Encoded in software.
    Av1,
}

impl Format {
    /// What follows the encoder: the stream's form, as takers get it.
    fn output(self) -> &'static str {
        match self {
            Self::H264 => {
                "video/x-h264,profile=constrained-baseline,stream-format=byte-stream,alignment=au \
                ! h264parse config-interval=-1"
            }
            Self::FullChroma => {
                "video/x-h264,profile=high-4:4:4,stream-format=byte-stream,alignment=au \
                ! h264parse config-interval=-1"
            }
            Self::H265 => {
                "video/x-h265,profile=main,stream-format=byte-stream,alignment=au \
                ! h265parse config-interval=-1"
            }
            Self::Vp9 => "video/x-vp9,profile=(string)0",
            Self::Vp9FullChroma => "video/x-vp9,profile=(string)1",
            Self::Av1 => "av1parse ! video/x-av1,stream-format=obu-stream,alignment=tu",
        }
    }
}

/// How much a window's video may cost a link, best last.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Quality {
    Low,
    Medium,
    Full,
}

impl Quality {
    /// What the video of a picture of 1280x720 pixels spends at most, in kbit/s; nothing
    /// bounds the best.
    pub fn bitrate(self) -> Option<u32> {
        match self {
            Self::Low => Some(700),
            Self::Medium => Some(2500),
            Self::Full => None,
        }
    }

    /// Frames a second at most, unless a taker asks for another rate: fewer frames leave
    /// each more of a bitrate.
    pub fn fps(self) -> u32 {
        match self {
            Self::Low => 15,
            Self::Medium => 30,
            Self::Full => 60,
        }
    }

    pub fn lower(self) -> Option<Self> {
        match self {
            Self::Low => None,
            Self::Medium => Some(Self::Low),
            Self::Full => Some(Self::Medium),
        }
    }

    pub fn higher(self) -> Option<Self> {
        match self {
            Self::Low => Some(Self::Medium),
            Self::Medium => Some(Self::Full),
            Self::Full => None,
        }
    }
}

struct Candidate {
    /// The encoder's element.
    name: &'static str,
    format: Format,
    /// Elements from raw RGB to the format at a constant quality, without B-frames or
    /// lookahead: every frame comes out before the next goes in.
    constant: &'static str,
    /// The same at a bitrate, which stands for `{kbit}` or `{bit}`.
    at_bitrate: &'static str,
}

impl Candidate {
    /// Whether the encoder is on the GPU that draws the frames, which VA-API's are: it
    /// takes them from there.
    fn on_gpu(&self) -> bool {
        self.name.starts_with("va")
    }
}

/// What frames on the GPU are to VA-API: RGBA whose alpha is not looked at, as frames
/// are opaque.
const GPU_FORMAT: &str = "XB24";

/// Set once an encoder refused a frame on the GPU: all of them take pixels from then on.
static GPU_REFUSED: AtomicBool = AtomicBool::new(false);

/// The layouts (DRM format modifiers) in which this machine's encoders take frames on the
/// GPU; none when they take none there.
pub fn frame_layouts() -> Vec<u64> {
    if init().is_err() {
        return Vec::new();
    }
    let Some(converter) = gst::ElementFactory::find("vapostproc") else {
        return Vec::new();
    };
    let mut layouts = Vec::new();
    for template in converter.static_pad_templates() {
        if template.direction() != gst::PadDirection::Sink {
            continue;
        }
        let caps = template.caps();
        for (structure, features) in caps.iter_with_features() {
            if !features.contains("memory:DMABuf") {
                continue;
            }
            let formats: Vec<String> = match structure.get::<gst::List>("drm-format") {
                Ok(list) => list.iter().filter_map(|one| one.get().ok()).collect(),
                Err(_) => structure.get("drm-format").into_iter().collect(),
            };
            for format in formats {
                // A format alone is in the linear layout.
                let (name, layout) = format.split_once(':').unwrap_or((&format, "0x0"));
                let layout = u64::from_str_radix(layout.trim_start_matches("0x"), 16);
                if let (GPU_FORMAT, Ok(layout)) = (name, layout) {
                    layouts.push(layout);
                }
            }
        }
    }
    layouts
}

/// In preference order within a format: NVENC on NVIDIA, VA-API on Intel and AMD, then
/// software. No VA-API driver encodes H.264 in 4:4:4; Intel's does VP9.
const ENCODERS: &[Candidate] = &[
    Candidate {
        name: "nvh264enc",
        format: Format::H264,
        constant: "videoconvert ! nvh264enc preset=p1 tune=ultra-low-latency rc-mode=constqp \
            qp-const-i=21 qp-const-p=23 gop-size=-1 bframes=0 zerolatency=true rc-lookahead=0",
        at_bitrate: "videoconvert ! nvh264enc preset=p1 tune=ultra-low-latency rc-mode=cbr \
            bitrate={kbit} gop-size=-1 bframes=0 zerolatency=true rc-lookahead=0",
    },
    Candidate {
        name: "vah264lpenc",
        format: Format::H264,
        constant: "vapostproc ! vah264lpenc rate-control=cqp qpi=22 qpp=24 b-frames=0 \
            target-usage=7",
        at_bitrate: "vapostproc ! vah264lpenc rate-control=cbr bitrate={kbit} b-frames=0 \
            target-usage=7",
    },
    Candidate {
        name: "vah264enc",
        format: Format::H264,
        constant: "vapostproc ! vah264enc rate-control=cqp qpi=22 qpp=24 b-frames=0 \
            target-usage=7",
        at_bitrate: "vapostproc ! vah264enc rate-control=cbr bitrate={kbit} b-frames=0 \
            target-usage=7",
    },
    Candidate {
        name: "x264enc",
        format: Format::H264,
        constant: "videoconvert ! x264enc tune=zerolatency speed-preset=ultrafast pass=qual \
            quantizer=23 bframes=0 key-int-max=600",
        // A bitrate is spent better by a slower preset, and has fewer frames to spend on.
        at_bitrate: "videoconvert ! x264enc tune=zerolatency speed-preset=veryfast pass=cbr \
            bitrate={kbit} vbv-buf-capacity=400 bframes=0 key-int-max=600",
    },
    Candidate {
        name: "openh264enc",
        format: Format::H264,
        constant: "videoconvert ! openh264enc usage-type=screen complexity=low \
            rate-control=quality",
        at_bitrate: "videoconvert ! openh264enc usage-type=screen complexity=low \
            rate-control=bitrate bitrate={bit}",
    },
    Candidate {
        name: "nvh264enc",
        format: Format::FullChroma,
        constant: "videoconvert ! video/x-raw,format=Y444,colorimetry=bt709 ! nvh264enc \
            preset=p1 tune=ultra-low-latency rc-mode=constqp qp-const-i=21 qp-const-p=23 \
            gop-size=-1 bframes=0 zerolatency=true rc-lookahead=0",
        at_bitrate: "videoconvert ! video/x-raw,format=Y444,colorimetry=bt709 ! nvh264enc \
            preset=p1 tune=ultra-low-latency rc-mode=cbr bitrate={kbit} gop-size=-1 bframes=0 \
            zerolatency=true rc-lookahead=0",
    },
    Candidate {
        name: "x264enc",
        format: Format::FullChroma,
        constant: "videoconvert ! video/x-raw,format=Y444,colorimetry=bt709 ! x264enc \
            tune=zerolatency speed-preset=ultrafast pass=qual quantizer=23 bframes=0 \
            key-int-max=600",
        at_bitrate: "videoconvert ! video/x-raw,format=Y444,colorimetry=bt709 ! x264enc \
            tune=zerolatency speed-preset=veryfast pass=cbr bitrate={kbit} \
            vbv-buf-capacity=400 bframes=0 key-int-max=600",
    },
    Candidate {
        name: "vah265lpenc",
        format: Format::H265,
        constant: "vapostproc ! video/x-raw(memory:VAMemory),format=NV12 ! vah265lpenc rate-control=cqp qpi=24 qpp=26 b-frames=0 \
            target-usage=7",
        at_bitrate: "vapostproc ! video/x-raw(memory:VAMemory),format=NV12 ! vah265lpenc rate-control=cbr bitrate={kbit} b-frames=0 \
            target-usage=7",
    },
    Candidate {
        name: "vah265enc",
        format: Format::H265,
        constant: "vapostproc ! video/x-raw(memory:VAMemory),format=NV12 ! vah265enc rate-control=cqp qpi=24 qpp=26 b-frames=0 \
            target-usage=7",
        at_bitrate: "vapostproc ! video/x-raw(memory:VAMemory),format=NV12 ! vah265enc rate-control=cbr bitrate={kbit} b-frames=0 \
            target-usage=7",
    },
    Candidate {
        name: "x265enc",
        format: Format::H265,
        constant: "videoconvert ! x265enc tune=zerolatency speed-preset=ultrafast qp=24 \
            key-int-max=600",
        at_bitrate: "videoconvert ! x265enc tune=zerolatency speed-preset=superfast \
            bitrate={kbit} key-int-max=600",
    },
    // One reference and no group of frames: every frame comes out before the next goes in.
    Candidate {
        name: "vavp9lpenc",
        format: Format::Vp9,
        constant: "vapostproc ! video/x-raw(memory:VAMemory),format=NV12 ! vavp9lpenc rate-control=cqp qp=90 ref-frames=1 \
            hierarchical-level=1 gf-group-size=1 key-int-max=1024 target-usage=7",
        at_bitrate: "vapostproc ! video/x-raw(memory:VAMemory),format=NV12 ! vavp9lpenc rate-control=cbr bitrate={kbit} ref-frames=1 \
            hierarchical-level=1 gf-group-size=1 key-int-max=1024 target-usage=7",
    },
    Candidate {
        name: "vp9enc",
        format: Format::Vp9,
        constant: "videoconvert ! vp9enc deadline=1 cpu-used=8 lag-in-frames=0 row-mt=true \
            threads=4 end-usage=cq cq-level=24 min-quantizer=20 max-quantizer=32 \
            target-bitrate=40000000 keyframe-max-dist=600",
        at_bitrate: "videoconvert ! vp9enc deadline=1 cpu-used=8 lag-in-frames=0 row-mt=true \
            threads=4 end-usage=cbr target-bitrate={bit} buffer-size=400 \
            buffer-initial-size=300 buffer-optimal-size=300 keyframe-max-dist=600",
    },
    Candidate {
        name: "vavp9lpenc",
        format: Format::Vp9FullChroma,
        constant: "vapostproc ! video/x-raw(memory:VAMemory),format=VUYA ! vavp9lpenc \
            rate-control=cqp qp=90 ref-frames=1 hierarchical-level=1 gf-group-size=1 \
            key-int-max=1024 target-usage=7",
        at_bitrate: "vapostproc ! video/x-raw(memory:VAMemory),format=VUYA ! vavp9lpenc \
            rate-control=cbr bitrate={kbit} ref-frames=1 hierarchical-level=1 \
            gf-group-size=1 key-int-max=1024 target-usage=7",
    },
    Candidate {
        name: "vp9enc",
        format: Format::Vp9FullChroma,
        constant: "videoconvert ! video/x-raw,format=Y444 ! vp9enc deadline=1 cpu-used=8 \
            lag-in-frames=0 row-mt=true threads=4 end-usage=cq cq-level=24 min-quantizer=20 \
            max-quantizer=32 target-bitrate=40000000 keyframe-max-dist=600",
        at_bitrate: "videoconvert ! video/x-raw,format=Y444 ! vp9enc deadline=1 cpu-used=8 \
            lag-in-frames=0 row-mt=true threads=4 end-usage=cbr target-bitrate={bit} \
            buffer-size=400 buffer-initial-size=300 buffer-optimal-size=300 \
            keyframe-max-dist=600",
    },
    // SVT-AV1 holds frames back here whatever it is told; libaom does not.
    Candidate {
        name: "av1enc",
        format: Format::Av1,
        constant: "videoconvert ! av1enc usage-profile=realtime cpu-used=10 lag-in-frames=0 \
            end-usage=q min-quantizer=30 max-quantizer=30 keyframe-max-dist=600 threads=4",
        at_bitrate: "videoconvert ! av1enc usage-profile=realtime cpu-used=10 lag-in-frames=0 \
            end-usage=cbr target-bitrate={kbit} keyframe-max-dist=600 threads=4",
    },
];

impl Candidate {
    /// A quality's bitrate is for a picture of [`BITRATE_FOR`] pixels. A larger one gets
    /// more, less than in proportion: pictures do not get busier as fast as they get larger.
    fn elements(&self, quality: Quality, size: (u32, u32)) -> String {
        let pixels = f64::from(size.0) * f64::from(size.1);
        let larger = (pixels / BITRATE_FOR).clamp(0.5, 8.0).powf(0.75);
        match quality.bitrate() {
            None => self.constant.to_owned(),
            Some(kbit) => self
                .at_bitrate
                .replace("{kbit}", &((f64::from(kbit) * larger) as u32).to_string())
                .replace(
                    "{bit}",
                    &((f64::from(kbit) * larger) as u32 * 1000).to_string(),
                ),
        }
    }
}

/// 1280x720.
const BITRATE_FOR: f64 = 921_600.0;

const PROBE_SIZE: (u32, u32) = (640, 480);

/// How long an encoder gets for a frame before it counts as failed.
const ENCODE_WITHIN: gst::ClockTime = gst::ClockTime::from_seconds(5);

/// Starts GStreamer and finds its plugins, once.
pub fn init() -> anyhow::Result<()> {
    static STARTED: OnceLock<Result<(), String>> = OnceLock::new();
    STARTED
        .get_or_init(|| {
            gst::init().map_err(|err| err.to_string())?;
            // Plugins come from a variable of the runner's own rather than
            // GST_PLUGIN_SYSTEM_PATH_1_0, which other programs read too.
            if let Some(paths) = std::env::var_os("APERTURE_GST_PLUGIN_PATH") {
                let registry = gst::Registry::get();
                for path in std::env::split_paths(&paths) {
                    registry.scan_path(&path);
                }
            }
            Ok(())
        })
        .clone()
        .map_err(anyhow::Error::msg)
}

/// The encoders that work on this machine for a format, best first; a quality at a bitrate
/// is another setup of an encoder than the constant one, which a driver may not have.
/// Found once, by encoding a frame with each: an element being installed says nothing
/// about its device or driver.
fn working(format: Format, quality: Quality) -> Arc<[&'static Candidate]> {
    type Found = Arc<OnceLock<Arc<[&'static Candidate]>>>;
    static WORKING: OnceLock<Mutex<HashMap<(Format, bool), Found>>> = OnceLock::new();
    let at_bitrate = quality.bitrate().is_some();
    // Looked up apart from finding out, which takes a moment: one format's encoders are
    // not waited for by those who ask for another's.
    let found = WORKING
        .get_or_init(Mutex::default)
        .lock()
        .expect("not poisoned")
        .entry((format, at_bitrate))
        .or_default()
        .clone();
    found
        .get_or_init(|| {
            if let Err(err) = init() {
                warn!("gstreamer is unavailable: {err:#}");
                return Arc::new([]);
            }
            let working: Arc<[&Candidate]> = ENCODERS
                .iter()
                .filter(|candidate| candidate.format == format)
                .filter(|candidate| gst::ElementFactory::find(candidate.name).is_some())
                .filter(|candidate| match probe(candidate, quality) {
                    Ok(()) => true,
                    Err(err) => {
                        debug!(encoder = candidate.name, "encoder does not work: {err:#}");
                        false
                    }
                })
                .collect();
            let names: Vec<&str> = working.iter().map(|candidate| candidate.name).collect();
            info!(?format, at_bitrate, encoders = ?names, "video encoders");
            working
        })
        .clone()
}

/// Whether this machine encodes the format at all.
pub fn encodes(format: Format) -> bool {
    !working(format, Quality::Full).is_empty()
}

fn probe(candidate: &Candidate, quality: Quality) -> anyhow::Result<()> {
    let (width, height) = PROBE_SIZE;
    let pipeline = Pipeline::new(candidate, quality, quality.fps(), PROBE_SIZE, Input::Pixels)?;
    let blank = vec![0; width as usize * height as usize * 4];
    pipeline.encode(gst::Buffer::from_slice(blank), true)?;
    Ok(())
}

/// How frames come to an encoder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Input {
    /// As pixels in memory.
    Pixels,
    /// As buffers on the GPU, in this layout.
    Gpu { layout: u64 },
}

struct Pipeline {
    pipeline: gst::Pipeline,
    src: gst_app::AppSrc,
    sink: gst_app::AppSink,
    size: (u32, u32),
    input: Input,
}

impl Pipeline {
    fn new(
        candidate: &Candidate,
        quality: Quality,
        fps: u32,
        size: (u32, u32),
        input: Input,
    ) -> anyhow::Result<Self> {
        let elements = candidate.elements(quality, size);
        let output = candidate.format.output();
        let description = format!(
            "appsrc name=src is-live=true format=time \
            ! {elements} \
            ! {output} \
            ! appsink name=sink sync=false"
        );
        let pipeline = gst::parse::launch(&description)?
            .downcast::<gst::Pipeline>()
            .map_err(|_| anyhow::anyhow!("not a pipeline"))?;
        let src = pipeline
            .by_name("src")
            .and_then(|element| element.downcast::<gst_app::AppSrc>().ok())
            .context("no appsrc")?;
        let sink = pipeline
            .by_name("sink")
            .and_then(|element| element.downcast::<gst_app::AppSink>().ok())
            .context("no appsink")?;
        let created = Self {
            pipeline,
            src,
            sink,
            size,
            input,
        };
        // The most frames there are, which a bitrate is spread over; they only come when
        // a window changes.
        let rate = gst::Fraction::new(fps as i32, 1);
        let caps = match input {
            // Frames are opaque, so their alpha is not looked at.
            Input::Pixels => {
                gst_video::VideoInfo::builder(gst_video::VideoFormat::Rgbx, size.0, size.1)
                    .fps(rate)
                    .build()?
                    .to_caps()?
            }
            Input::Gpu { layout } => {
                let format = match layout {
                    0 => GPU_FORMAT.to_owned(),
                    layout => format!("{GPU_FORMAT}:{layout:#018x}"),
                };
                gst::Caps::builder("video/x-raw")
                    .features(["memory:DMABuf"])
                    .field("format", "DMA_DRM")
                    .field("drm-format", format)
                    .field("width", size.0 as i32)
                    .field("height", size.1 as i32)
                    .field("framerate", rate)
                    .build()
            }
        };
        created.src.set_caps(Some(&caps));
        created
            .pipeline
            .set_state(gst::State::Playing)
            .context("failed to start the encoder")?;
        Ok(created)
    }

    /// Encodes one frame and waits for it to come out, as the format has frames; also
    /// whether it came out as a keyframe.
    fn encode(&self, buffer: gst::Buffer, keyframe: bool) -> anyhow::Result<(Vec<u8>, bool)> {
        if keyframe {
            let event = gst_video::DownstreamForceKeyUnitEvent::builder()
                .all_headers(true)
                .build();
            self.src.send_event(event);
        }
        self.src
            .push_buffer(buffer)
            .map_err(|err| anyhow::anyhow!("the encoder refused a frame: {err}"))?;
        let Some(sample) = self.sink.try_pull_sample(ENCODE_WITHIN) else {
            match self.error() {
                Some(error) => bail!("{error}"),
                None => bail!("the encoder gave no frame"),
            }
        };
        let buffer = sample.buffer().context("a sample without a buffer")?;
        let map = buffer.map_readable()?;
        let keyframe = !buffer.flags().contains(gst::BufferFlags::DELTA_UNIT);
        Ok((map.as_slice().to_vec(), keyframe))
    }

    /// What the pipeline reported as having gone wrong, if anything.
    fn error(&self) -> Option<String> {
        let bus = self.pipeline.bus()?;
        std::iter::from_fn(|| bus.pop()).find_map(|message| match message.view() {
            gst::MessageView::Error(err) => Some(err.error().to_string()),
            _ => None,
        })
    }
}

impl Drop for Pipeline {
    fn drop(&mut self) {
        // GStreamer leaks elements disposed outside NULL.
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

/// A frame's pixels as a buffer's memory, without a copy.
struct Pixels {
    frame: Arc<Frame>,
    len: usize,
}

impl AsRef<[u8]> for Pixels {
    fn as_ref(&self) -> &[u8] {
        &self.frame.rgba[..self.len]
    }
}

/// A frame on the GPU as a buffer of its planes, each plane's memory its own.
fn gpu_frame(frame: &GpuBuffer, size: (u32, u32)) -> anyhow::Result<gst::Buffer> {
    let allocator = gst_allocators::DmaBufAllocator::new();
    let mut buffer = gst::Buffer::new();
    let planes = buffer.get_mut().expect("the buffer was just made");
    let mut offsets = Vec::new();
    let mut strides = Vec::new();
    for plane in frame.planes() {
        let fd = plane.fd.try_clone_to_owned()?;
        let length = length_of(&fd)?;
        // A plane is found by where it is in the buffer as a whole.
        offsets.push(planes.size() + plane.offset as usize);
        strides.push(plane.stride as i32);
        // Safety: the descriptor is a dmabuf of that length, and the memory's from here on.
        planes.append_memory(unsafe { allocator.alloc_dmabuf(fd, length) }?);
    }
    gst_video::VideoMeta::add_full(
        planes,
        gst_video::VideoFrameFlags::empty(),
        gst_video::VideoFormat::DmaDrm,
        size.0,
        size.1,
        &offsets,
        &strides,
    )?;
    Ok(buffer)
}

/// How long a dmabuf is.
fn length_of(fd: &OwnedFd) -> anyhow::Result<usize> {
    // Safety: seeking a descriptor that is ours.
    let end = unsafe { libc::lseek(fd.as_raw_fd(), 0, libc::SEEK_END) };
    ensure!(end > 0, "a buffer without a length");
    Ok(end as usize)
}

pub struct VideoEncoder {
    quality: Quality,
    fps: u32,
    /// The encoders that work, and how many of the best of them failed since.
    candidates: Arc<[&'static Candidate]>,
    failed: usize,
    pipeline: Option<Pipeline>,
}

impl VideoEncoder {
    /// Finds this machine's encoders on first use, which takes a moment.
    pub fn new(format: Format, quality: Quality, fps: u32) -> anyhow::Result<Self> {
        let candidates = working(format, quality);
        ensure!(!candidates.is_empty(), "no working encoder for {format:?}");
        Ok(Self {
            quality,
            fps,
            candidates,
            failed: 0,
            pipeline: None,
        })
    }

    /// Whether the encoder takes frames as pixels in memory rather than where the GPU drew
    /// them, see [`aperture_compositor::Pixels`].
    pub fn wants_pixels(&self) -> bool {
        let on_gpu = self
            .candidates
            .get(self.failed)
            .is_some_and(|candidate| candidate.on_gpu());
        !on_gpu || GPU_REFUSED.load(Ordering::Relaxed)
    }

    /// Encodes the frame as an Annex B access unit, and says whether it is a keyframe: it is
    /// when asked, and when the frame's size differs from the last one's. A hardware
    /// encoder can fail while running, with every session of the GPU taken or at a size it
    /// refuses: the frame then goes to the next encoder, which serves from then on.
    ///
    /// Nothing comes of a frame without pixels when the encoder [wants
    /// them](Self::wants_pixels).
    pub fn encode(
        &mut self,
        frame: &Arc<Frame>,
        keyframe: bool,
    ) -> anyhow::Result<Option<(Vec<u8>, bool)>> {
        // 4:2:0 has one chroma sample per two pixels each way, so a last odd row or column
        // is left out.
        let width = frame.width & !1;
        let height = frame.height & !1;
        ensure!(width > 0 && height > 0, "an empty frame");
        loop {
            let candidate = *self
                .candidates
                .get(self.failed)
                .context("no working encoder left")?;
            let on_gpu = frame
                .buffer
                .as_ref()
                .filter(|_| candidate.on_gpu() && !GPU_REFUSED.load(Ordering::Relaxed));
            if on_gpu.is_none() && frame.rgba.is_empty() {
                return Ok(None);
            }
            let input = match on_gpu {
                Some(buffer) => Input::Gpu {
                    layout: buffer.layout(),
                },
                None => Input::Pixels,
            };
            let pipeline = match self.pipeline.take() {
                Some(pipeline) if pipeline.size == (width, height) && pipeline.input == input => {
                    Ok(pipeline)
                }
                _ => {
                    info!(encoder = candidate.name, ?input, width, height, "encoding");
                    Pipeline::new(candidate, self.quality, self.fps, (width, height), input)
                }
            };
            let encoded = pipeline.and_then(|pipeline| {
                let mut buffer = if let Some(buffer) = on_gpu {
                    gpu_frame(buffer, (width, height))?
                } else if width == frame.width {
                    gst::Buffer::from_slice(Pixels {
                        frame: frame.clone(),
                        len: width as usize * height as usize * 4,
                    })
                } else {
                    let stride = frame.width as usize * 4;
                    let mut cropped = Vec::with_capacity(width as usize * height as usize * 4);
                    for row in frame.rgba.chunks_exact(stride).take(height as usize) {
                        cropped.extend_from_slice(&row[..width as usize * 4]);
                    }
                    gst::Buffer::from_slice(cropped)
                };
                buffer
                    .get_mut()
                    .expect("the buffer was just made")
                    .set_pts(gst::ClockTime::from_nseconds(frame.time.as_nanos() as u64));
                let data = pipeline.encode(buffer, keyframe)?;
                Ok((pipeline, data))
            });
            match encoded {
                Ok((pipeline, data)) => {
                    self.pipeline = Some(pipeline);
                    return Ok(Some(data));
                }
                Err(err) if on_gpu.is_some() => {
                    warn!(
                        encoder = candidate.name,
                        "encoder takes no frames on the GPU, giving it pixels: {err:#}"
                    );
                    GPU_REFUSED.store(true, Ordering::Relaxed);
                }
                Err(err) if self.failed + 1 < self.candidates.len() => {
                    warn!(
                        encoder = candidate.name,
                        "encoder failed, using the next: {err:#}"
                    );
                    self.failed += 1;
                }
                Err(err) => return Err(err),
            }
        }
    }
}

//! Window frames as H.264, through GStreamer: on the GPU where one encodes, in software
//! otherwise.
//!
//! Encoders run at a constant quality rather than a bitrate: frames only come when a window
//! changes, and a rate-controlled encoder would leave a window at rest at whatever quality
//! its last frame got.

use std::sync::{Arc, OnceLock};

use anyhow::{Context, bail, ensure};
use aperture_compositor::Frame;
use gstreamer::{self as gst, prelude::*};
use gstreamer_app as gst_app;
use gstreamer_video as gst_video;
use tracing::{debug, info, warn};

struct Candidate {
    /// The encoder's element.
    name: &'static str,
    /// Elements from raw RGB to H.264, without B-frames or lookahead: every frame comes out
    /// before the next goes in.
    elements: &'static str,
}

/// In preference order: NVENC on NVIDIA, VA-API on Intel and AMD, then software. Browsers
/// decode constrained baseline everywhere, which rules out B-frames.
const ENCODERS: &[Candidate] = &[
    Candidate {
        name: "nvh264enc",
        elements: "videoconvert ! nvh264enc preset=p1 tune=ultra-low-latency rc-mode=constqp \
            qp-const-i=21 qp-const-p=23 gop-size=-1 bframes=0 zerolatency=true rc-lookahead=0",
    },
    Candidate {
        name: "vah264lpenc",
        elements: "vapostproc ! vah264lpenc rate-control=cqp qpi=22 qpp=24 b-frames=0 \
            target-usage=7",
    },
    Candidate {
        name: "vah264enc",
        elements: "vapostproc ! vah264enc rate-control=cqp qpi=22 qpp=24 b-frames=0 \
            target-usage=7",
    },
    Candidate {
        name: "x264enc",
        elements: "videoconvert ! x264enc tune=zerolatency speed-preset=ultrafast pass=qual \
            quantizer=23 bframes=0 key-int-max=600",
    },
    Candidate {
        name: "openh264enc",
        elements: "videoconvert ! openh264enc usage-type=screen complexity=low \
            rate-control=quality",
    },
];

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

/// The encoders that work on this machine, best first. Found once, by encoding a frame with
/// each: an element being installed says nothing about its device or driver.
fn working() -> &'static [&'static Candidate] {
    static WORKING: OnceLock<Vec<&'static Candidate>> = OnceLock::new();
    WORKING.get_or_init(|| {
        if let Err(err) = init() {
            warn!("gstreamer is unavailable: {err:#}");
            return Vec::new();
        }
        let working: Vec<&Candidate> = ENCODERS
            .iter()
            .filter(|candidate| gst::ElementFactory::find(candidate.name).is_some())
            .filter(|candidate| match probe(candidate) {
                Ok(()) => true,
                Err(err) => {
                    debug!(encoder = candidate.name, "encoder does not work: {err:#}");
                    false
                }
            })
            .collect();
        let names: Vec<&str> = working.iter().map(|candidate| candidate.name).collect();
        info!(encoders = ?names, "video encoders");
        working
    })
}

fn probe(candidate: &Candidate) -> anyhow::Result<()> {
    let (width, height) = PROBE_SIZE;
    let pipeline = Pipeline::new(candidate, PROBE_SIZE)?;
    let blank = vec![0; width as usize * height as usize * 4];
    pipeline.encode(gst::Buffer::from_slice(blank), true)?;
    Ok(())
}

struct Pipeline {
    pipeline: gst::Pipeline,
    src: gst_app::AppSrc,
    sink: gst_app::AppSink,
    size: (u32, u32),
}

impl Pipeline {
    fn new(candidate: &Candidate, size: (u32, u32)) -> anyhow::Result<Self> {
        let elements = candidate.elements;
        let description = format!(
            "appsrc name=src is-live=true format=time \
            ! {elements} \
            ! video/x-h264,profile=constrained-baseline,stream-format=byte-stream,alignment=au \
            ! h264parse config-interval=-1 \
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
        };
        // Frames are opaque, so their alpha is not looked at.
        let info = gst_video::VideoInfo::builder(gst_video::VideoFormat::Rgbx, size.0, size.1)
            // Nominal; frames only come when a window changes.
            .fps(gst::Fraction::new(60, 1))
            .build()?;
        created.src.set_caps(Some(&info.to_caps()?));
        created
            .pipeline
            .set_state(gst::State::Playing)
            .context("failed to start the encoder")?;
        Ok(created)
    }

    /// Encodes one frame and waits for it to come out, as an Annex B access unit; also
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

pub struct VideoEncoder {
    /// The encoders left to use, best first.
    candidates: &'static [&'static Candidate],
    pipeline: Option<Pipeline>,
}

impl VideoEncoder {
    /// Finds this machine's encoders on first use, which takes a moment.
    pub fn new() -> anyhow::Result<Self> {
        let candidates = working();
        ensure!(!candidates.is_empty(), "no working H.264 encoder");
        Ok(Self {
            candidates,
            pipeline: None,
        })
    }

    /// Encodes the frame as an Annex B access unit, and says whether it is a keyframe: it is
    /// when asked, and when the frame's size differs from the last one's. A hardware encoder can fail while running,
    /// with every session of the GPU taken or at a size it refuses: the frame then goes to
    /// the next encoder, which serves from then on.
    pub fn encode(
        &mut self,
        frame: &Arc<Frame>,
        keyframe: bool,
    ) -> anyhow::Result<(Vec<u8>, bool)> {
        // 4:2:0 has one chroma sample per two pixels each way, so a last odd row or column
        // is left out.
        let width = frame.width & !1;
        let height = frame.height & !1;
        ensure!(width > 0 && height > 0, "an empty frame");
        loop {
            let candidate = self.candidates.first().context("no working encoder left")?;
            let pipeline = match self.pipeline.take() {
                Some(pipeline) if pipeline.size == (width, height) => Ok(pipeline),
                _ => Pipeline::new(candidate, (width, height)),
            };
            let encoded = pipeline.and_then(|pipeline| {
                let mut buffer = if width == frame.width {
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
                    return Ok(data);
                }
                Err(err) if self.candidates.len() > 1 => {
                    warn!(
                        encoder = candidate.name,
                        "encoder failed, using the next: {err:#}"
                    );
                    self.candidates = &self.candidates[1..];
                }
                Err(err) => return Err(err),
            }
        }
    }
}

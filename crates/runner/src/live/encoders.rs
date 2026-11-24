//! The video encoders there are, and which of them work on this machine.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
};

use gstreamer as gst;
use tracing::{debug, info, warn};

use super::encode::{Format, Input, Pipeline, Quality, init};

pub(super) struct Candidate {
    /// The encoder's element.
    pub(super) name: &'static str,
    pub(super) format: Format,
    /// Elements from raw RGB to the format at a constant quality, without B-frames or
    /// lookahead: every frame comes out before the next goes in.
    constant: &'static str,
    /// The same at a bitrate, which stands for `{kbit}` or `{bit}`.
    at_bitrate: &'static str,
}

impl Candidate {
    /// Whether the encoder is on the GPU that draws the frames, which VA-API's are: it
    /// takes them from there.
    pub(super) fn on_gpu(&self) -> bool {
        self.name.starts_with("va")
    }
}

/// What frames on the GPU are to VA-API: RGBA whose alpha is not looked at, as frames
/// are opaque.
pub(super) const GPU_FORMAT: &str = "XB24";

/// The layouts (DRM format modifiers) in which this machine's encoders take frames on the
/// GPU; none when they take none there.
pub fn frame_layouts() -> Vec<u64> {
    if let Err(err) = init() {
        warn!("gstreamer is unavailable: {err:#}");
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
    pub(super) fn elements(&self, quality: Quality, size: (u32, u32)) -> String {
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

/// The encoders that work on this machine for a format, best first; a quality at a bitrate
/// is another setup of an encoder than the constant one, which a driver may not have.
/// Found once, by encoding a frame with each: an element being installed says nothing
/// about its device or driver.
pub(super) fn working(format: Format, quality: Quality) -> Arc<[&'static Candidate]> {
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

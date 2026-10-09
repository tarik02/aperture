package browser

import (
	"errors"
	"fmt"
	"os"
	"strings"

	webdesktopconfig "github.com/tarik02/webdesktop/config"
	"github.com/tarik02/webdesktop/media"
)

const mediaProfileNVENC = "h264-nvenc"

type mediaCandidate struct {
	name    string
	codec   string
	profile media.EncoderProfile
}

func mediaCandidates(values RuntimeEnvValues) []mediaCandidate {
	profiles := webdesktopconfig.DefaultVideoProfiles()
	va := profiles[webdesktopconfig.VideoProfileH264VAAPI]
	// The upstream profile includes Intel tuning and properties absent in some
	// GStreamer releases. Keep required controls here and probe optional hints.
	va.Pipeline = `vapostproc !
video/x-raw(memory:VAMemory),format=NV12,width={{ .Width }},height={{ .Height }},framerate={{ .Framerate }}/1 !
vah264enc name={{ element "encoder" }} bitrate={{ .BitrateKbps }} key-int-max={{ .KeyframeInterval }}
  b-frames=0 cabac=false dct8x8=false rate-control=cbr !
h264parse config-interval=-1 !
video/x-h264,stream-format=byte-stream,alignment=au,profile=constrained-baseline`
	va.Bitrate = []media.EncoderProperty{{
		Element: "encoder", Property: "bitrate", Type: media.PropertyTypeUint, Value: `{{ .BitrateKbps }}`,
	}}
	nvenc := va
	nvenc.Label = "H.264 (NVENC)"
	nvenc.Pipeline = `videoconvert ! videoscale method=nearest-neighbour !
video/x-raw,format=NV12,width={{ .Width }},height={{ .Height }},framerate={{ .Framerate }}/1 !
nvh264enc name={{ element "encoder" }} bitrate={{ .BitrateKbps }} gop-size={{ .KeyframeInterval }}
  bframes=0 zerolatency=true rc-mode=cbr !
h264parse config-interval=-1 !
video/x-h264,stream-format=byte-stream,alignment=au,profile=constrained-baseline`

	candidates := make([]mediaCandidate, 0, 5)
	hardwareAllowed := values.GPUMode != gpuModeSoftware || values.mediaRequestedGPUMode == gpuModeAuto
	if hardwareAllowed {
		if values.RenderNode != "" {
			candidates = append(candidates, mediaCandidate{webdesktopconfig.VideoProfileH264VAAPI, mediaCodecH264, va})
		}
		candidates = append(candidates, mediaCandidate{mediaProfileNVENC, mediaCodecNVENC, nvenc})
	}
	candidates = append(candidates, mediaCandidate{webdesktopconfig.VideoProfileVP8, mediaCodecVP8, profiles[webdesktopconfig.VideoProfileVP8]})
	if values.GPUMode != gpuModeSoftware && values.RenderNode != "" {
		high := profiles[webdesktopconfig.VideoProfileH264VAAPIHigh]
		high.Pipeline = strings.NewReplacer("cabac=false", "cabac=true", "dct8x8=false", "dct8x8=true", "profile=constrained-baseline", "profile=high").Replace(va.Pipeline)
		high.Bitrate = va.Bitrate
		candidates = append(candidates, mediaCandidate{webdesktopconfig.VideoProfileH264VAAPIHigh, mediaCodecH264, high})
	}
	return append(candidates, mediaCandidate{webdesktopconfig.VideoProfileH264Software, mediaCodecX264, profiles[webdesktopconfig.VideoProfileH264Software]})
}

func selectMediaCandidate(requested string, candidates []mediaCandidate, probe func(mediaCandidate) (media.EncoderProfile, error)) (mediaCandidate, media.EncoderProfile, error) {
	switch requested {
	case mediaCodecAuto, mediaCodecVP8, mediaCodecH264, mediaCodecNVENC, mediaCodecX264:
	default:
		return mediaCandidate{}, media.EncoderProfile{}, fmt.Errorf("unsupported media producer codec %q; use auto, vp8, h264-va, h264-nvenc, or h264-software", requested)
	}
	var rejections []error
	for _, candidate := range candidates {
		if requested == mediaCodecAuto {
			if candidate.name == webdesktopconfig.VideoProfileH264VAAPIHigh || candidate.codec == mediaCodecX264 {
				continue
			}
		} else if candidate.codec != requested || candidate.name == webdesktopconfig.VideoProfileH264VAAPIHigh {
			continue
		}
		profile, err := probe(candidate)
		if err != nil {
			rejection := fmt.Errorf("%s: %w", candidate.name, err)
			rejections = append(rejections, rejection)
			fmt.Fprintf(os.Stderr, "browser-session-wrapper: media candidate=%s rejected: %v\n", candidate.name, err)
			continue
		}
		fmt.Fprintf(os.Stderr, "browser-session-wrapper: media candidate=%s selected: encoded keyframe probe passed\n", candidate.name)
		return candidate, profile, nil
	}
	if len(rejections) == 0 {
		return mediaCandidate{}, media.EncoderProfile{}, fmt.Errorf("media codec %q has no eligible backend for gpu mode; hardware codecs require hardware or auto, and VA-API requires an accessible render node", requested)
	}
	return mediaCandidate{}, media.EncoderProfile{}, fmt.Errorf("media codec %q has no working encoder: %w", requested, errors.Join(rejections...))
}

func mediaCandidateConfig(values RuntimeEnvValues, candidate mediaCandidate) media.Config {
	profile := candidate.profile
	width, height := mediaDimensions(profile, values.CompositorWidth, values.CompositorHeight, values.MediaProducerFPS)
	profile.DefaultOption = mediaQualityOption
	profile.Options = map[string]media.QualityOption{
		mediaQualityOption: {
			Label: "Aperture", Width: width, Height: height,
			Framerate: values.MediaProducerFPS, BitrateKbps: values.MediaProducerBitrateKbps,
		},
	}
	return media.Config{
		Profiles: map[string]media.EncoderProfile{candidate.name: profile},
		Quality:  profile.Options[mediaQualityOption].Quality(candidate.name, mediaQualityOption),
		Tuning:   media.Tuning{Threads: 4, KeyframeInterval: values.MediaProducerKeyframe, VP8CPUUsed: 8},
	}
}

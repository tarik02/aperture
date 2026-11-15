package browser

import (
	"errors"
	"fmt"
	"os"

	webdesktopconfig "github.com/tarik02/webdesktop/config"
	"github.com/tarik02/webdesktop/media"
)

const mediaProfileNVENC = "h264-nvenc"

type mediaEncoder struct {
	name    string
	codec   string
	profile media.EncoderProfile
}

func mediaEncoders(values RuntimeEnvValues) []mediaEncoder {
	profiles := webdesktopconfig.DefaultVideoProfiles()
	encoders := make([]mediaEncoder, 0, 5)
	hardwareAllowed := values.GPUMode != gpuModeSoftware || values.mediaRequestedGPUMode == gpuModeAuto
	if hardwareAllowed {
		if values.RenderNode != "" {
			encoders = append(encoders, mediaEncoder{
				name:    webdesktopconfig.VideoProfileH264VAAPI,
				codec:   mediaCodecH264,
				profile: vaapiProfile(false),
			})
		}
		encoders = append(encoders, mediaEncoder{
			name:    mediaProfileNVENC,
			codec:   mediaCodecNVENC,
			profile: nvencProfile(),
		})
	}
	encoders = append(encoders, mediaEncoder{
		name:    webdesktopconfig.VideoProfileVP8,
		codec:   mediaCodecVP8,
		profile: profiles[webdesktopconfig.VideoProfileVP8],
	})
	if values.GPUMode != gpuModeSoftware && values.RenderNode != "" {
		encoders = append(encoders, mediaEncoder{
			name:    webdesktopconfig.VideoProfileH264VAAPIHigh,
			codec:   mediaCodecH264,
			profile: vaapiProfile(true),
		})
	}
	return append(encoders, mediaEncoder{
		name:    webdesktopconfig.VideoProfileH264Software,
		codec:   mediaCodecX264,
		profile: profiles[webdesktopconfig.VideoProfileH264Software],
	})
}

func vaapiProfile(high bool) media.EncoderProfile {
	// Intel-specific upstream tuning is not portable to AMD drivers.
	name := webdesktopconfig.VideoProfileH264VAAPI
	h264Profile := "constrained-baseline"
	if high {
		name = webdesktopconfig.VideoProfileH264VAAPIHigh
		h264Profile = "high"
	}
	profile := webdesktopconfig.DefaultVideoProfiles()[name]
	profile.Pipeline = fmt.Sprintf(`vapostproc !
video/x-raw(memory:VAMemory),format=NV12,width={{ .Width }},height={{ .Height }},framerate={{ .Framerate }}/1 !
vah264enc name={{ element "encoder" }} bitrate={{ .BitrateKbps }} key-int-max={{ .KeyframeInterval }}
  b-frames=0 cabac=%t dct8x8=%t rate-control=cbr !
h264parse config-interval=-1 !
video/x-h264,stream-format=byte-stream,alignment=au,profile=%s`, high, high, h264Profile)
	profile.Bitrate = []media.EncoderProperty{{
		Element: "encoder", Property: "bitrate", Type: media.PropertyTypeUint, Value: `{{ .BitrateKbps }}`,
	}}
	return profile
}

func nvencProfile() media.EncoderProfile {
	profile := webdesktopconfig.DefaultVideoProfiles()[webdesktopconfig.VideoProfileH264VAAPI]
	profile.Label = "H.264 (NVENC)"
	profile.Pipeline = `videoconvert ! videoscale method=nearest-neighbour !
video/x-raw,format=NV12,width={{ .Width }},height={{ .Height }},framerate={{ .Framerate }}/1 !
nvh264enc name={{ element "encoder" }} bitrate={{ .BitrateKbps }} gop-size={{ .KeyframeInterval }}
  bframes=0 zerolatency=true rc-mode=cbr !
h264parse config-interval=-1 !
video/x-h264,stream-format=byte-stream,alignment=au,profile=constrained-baseline`
	profile.Bitrate = []media.EncoderProperty{{
		Element: "encoder", Property: "bitrate", Type: media.PropertyTypeUint, Value: `{{ .BitrateKbps }}`,
	}}
	return profile
}

func selectRuntimeMediaEncoder(values RuntimeEnvValues) (mediaEncoder, error) {
	encoders := mediaEncoders(values)
	probe := func(encoder mediaEncoder) (media.EncoderProfile, error) {
		return probeMediaEncoder(values, encoder)
	}
	selected, err := selectMediaEncoder(values.MediaProducerCodec, encoders, probe)
	if err == nil || values.mediaRequestedCodec != mediaCodecAuto || values.MediaProducerCodec == mediaCodecAuto {
		return selected, err
	}
	// Retry auto only if the backend resolved at startup is no longer working.
	return selectMediaEncoder(mediaCodecAuto, encoders, probe)
}

func selectMediaEncoder(requested string, encoders []mediaEncoder, probe func(mediaEncoder) (media.EncoderProfile, error)) (mediaEncoder, error) {
	switch requested {
	case mediaCodecAuto, mediaCodecVP8, mediaCodecH264, mediaCodecNVENC, mediaCodecX264:
	default:
		return mediaEncoder{}, fmt.Errorf("unsupported media producer codec %q; use auto, vp8, h264-va, h264-nvenc, or h264-software", requested)
	}
	var rejections []error
	for _, encoder := range encoders {
		if encoder.name == webdesktopconfig.VideoProfileH264VAAPIHigh {
			continue
		}
		if requested == mediaCodecAuto {
			if encoder.codec == mediaCodecX264 {
				continue
			}
		} else if encoder.codec != requested {
			continue
		}
		profile, err := probe(encoder)
		if err != nil {
			rejections = append(rejections, fmt.Errorf("%s: %w", encoder.name, err))
			fmt.Fprintf(os.Stderr, "browser-session-wrapper: media candidate=%s rejected: %v\n", encoder.name, err)
			continue
		}
		fmt.Fprintf(os.Stderr, "browser-session-wrapper: media candidate=%s selected: encoded keyframe probe passed\n", encoder.name)
		encoder.profile = profile
		return encoder, nil
	}
	if len(rejections) == 0 {
		return mediaEncoder{}, fmt.Errorf("media codec %q has no eligible backend for gpu mode; hardware codecs require hardware or auto, and VA-API requires an accessible render node", requested)
	}
	return mediaEncoder{}, fmt.Errorf("media codec %q has no working encoder: %w", requested, errors.Join(rejections...))
}

func mediaEncoderConfig(values RuntimeEnvValues, encoder mediaEncoder) media.Config {
	profile := encoder.profile
	width, height := mediaDimensions(profile, values.CompositorWidth, values.CompositorHeight, values.MediaProducerFPS)
	profile.DefaultOption = mediaQualityOption
	profile.Options = map[string]media.QualityOption{
		mediaQualityOption: {
			Label:       "Aperture",
			Width:       width,
			Height:      height,
			Framerate:   values.MediaProducerFPS,
			BitrateKbps: values.MediaProducerBitrateKbps,
		},
	}
	return media.Config{
		Profiles: map[string]media.EncoderProfile{encoder.name: profile},
		Quality:  profile.Options[mediaQualityOption].Quality(encoder.name, mediaQualityOption),
		Tuning:   media.Tuning{Threads: 4, KeyframeInterval: values.MediaProducerKeyframe, VP8CPUUsed: 8},
	}
}

func probePresentationProfiles(values RuntimeEnvValues, selected mediaEncoder) (media.Config, []mediaProfile) {
	config := mediaEncoderConfig(values, selected)
	var available []mediaProfile
	for _, encoder := range mediaEncoders(values) {
		profile := selected.profile
		if encoder.name != selected.name {
			var err error
			profile, err = probeMediaEncoder(values, encoder)
			if err != nil {
				fmt.Fprintf(os.Stderr, "browser-session-wrapper: media profile=%s unavailable: %v\n", encoder.name, err)
				continue
			}
		}
		config.Profiles[encoder.name] = profile
		available = append(available, mediaProfile{
			ID:          encoder.name,
			Label:       profile.Label,
			Codec:       profile.Codec.ID,
			MimeType:    profile.Codec.MimeType,
			SDPFmtpLine: profile.Codec.SDPFmtpLine,
		})
	}
	return config, available
}

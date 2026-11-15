package config

import (
	"strings"
	"testing"
)

func TestValidateMediaProducerCodecs(t *testing.T) {
	for _, codec := range []string{WebRTCMediaProducerCodecAuto, WebRTCMediaProducerCodecVP8, WebRTCMediaProducerCodecH264, WebRTCMediaProducerCodecNVENC, WebRTCMediaProducerCodecX264, "invalid"} {
		t.Run(codec, func(t *testing.T) {
			cfg := validTestConfig(t)
			defaults := Defaults()
			cfg.WebRTCCompositorBackend = defaults.WebRTCCompositorBackend
			cfg.WebRTCCompositorRenderer = defaults.WebRTCCompositorRenderer
			cfg.WebRTCCompositorShell = "aperture"
			cfg.WebRTCCompositorWidth = defaults.WebRTCCompositorWidth
			cfg.WebRTCCompositorHeight = defaults.WebRTCCompositorHeight
			cfg.WebRTCMediaProducerTarget = defaults.WebRTCMediaProducerTarget
			cfg.WebRTCMediaProducerFPS = defaults.WebRTCMediaProducerFPS
			cfg.WebRTCMediaProducerBitrateKbps = defaults.WebRTCMediaProducerBitrateKbps
			cfg.WebRTCMediaProducerKeyframe = defaults.WebRTCMediaProducerKeyframe
			cfg.WebRTCMediaProducerUDPPortMin = defaults.WebRTCMediaProducerUDPPortMin
			cfg.WebRTCMediaProducerUDPPortMax = defaults.WebRTCMediaProducerUDPPortMax
			cfg.WebRTCCompositorEnabled = true
			cfg.WebRTCCompositorExecutable = "/usr/bin/weston"
			cfg.WebRTCMediaProducerEnabled = true
			cfg.WebRTCMediaProducerGSTExecutable = "/usr/bin/gst-launch-1.0"
			cfg.WebRTCMediaProducerCodec = codec
			cfg.GPUMode = GPUModeAuto
			err := Validate(cfg)
			if codec == "invalid" {
				if err == nil || !strings.Contains(err.Error(), "webrtc_media_producer_codec must be") {
					t.Fatalf("unknown codec was not rejected: %v", err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			cfg.GPUMode = GPUModeSoftware
			err = Validate(cfg)
			if codec == WebRTCMediaProducerCodecH264 || codec == WebRTCMediaProducerCodecNVENC {
				if err == nil || !strings.Contains(err.Error(), "incompatible with gpu_mode software") {
					t.Fatalf("software GPU mode accepted hardware encoding: %v", err)
				}
			} else if codec != "invalid" && err != nil {
				t.Fatal(err)
			}
		})
	}
}

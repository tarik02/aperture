package browser

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/tarik02/webdesktop/media"
)

const (
	gpuModeAuto     = "auto"
	gpuModeSoftware = "software"
	gpuModeHardware = "hardware"
	mediaCodecAuto  = "auto"
	mediaCodecVP8   = "vp8"
	mediaCodecH264  = "h264-va"
	mediaCodecNVENC = "h264-nvenc"
	mediaCodecX264  = "h264-software"
)

func resolveGPU(values RuntimeEnvValues) (RuntimeEnvValues, error) {
	if values.mediaProbeCache == nil {
		values.mediaProbeCache = newMediaProbeCache()
	}
	requestedMode := strings.ToLower(strings.TrimSpace(values.GPUMode))
	requestedCodec := strings.ToLower(strings.TrimSpace(values.MediaProducerCodec))
	if requestedMode == "" {
		requestedMode = gpuModeAuto
	}
	if requestedCodec == "" {
		requestedCodec = mediaCodecAuto
	}

	renderNode, renderErr := accessibleRenderNode()
	switch requestedMode {
	case gpuModeSoftware:
		values.GPUMode = gpuModeSoftware
		values.RenderNode = ""
	case gpuModeHardware:
		if renderErr != nil {
			return RuntimeEnvValues{}, fmt.Errorf("gpu_mode hardware: %w", renderErr)
		}
		values.GPUMode = gpuModeHardware
		values.RenderNode = renderNode
	case gpuModeAuto:
		if renderErr == nil {
			values.GPUMode = gpuModeHardware
			values.RenderNode = renderNode
		} else {
			values.GPUMode = gpuModeSoftware
			values.RenderNode = ""
		}
	default:
		return RuntimeEnvValues{}, fmt.Errorf("unsupported gpu mode %q", requestedMode)
	}

	values.MediaProducerCodec = requestedCodec
	values.mediaRequestedCodec = requestedCodec
	values.mediaRequestedGPUMode = requestedMode
	if !values.MediaProducerEnabled {
		return values, nil
	}
	selected, _, err := selectMediaCandidate(requestedCodec, mediaCandidates(values), func(candidate mediaCandidate) (media.EncoderProfile, error) {
		return probeMediaCandidate(values, candidate)
	})
	if err != nil {
		return RuntimeEnvValues{}, err
	}
	values.MediaProducerCodec = selected.codec
	return values, nil
}

func accessibleRenderNode() (string, error) {
	renderNodes, err := filepath.Glob("/dev/dri/renderD*")
	if err != nil {
		return "", fmt.Errorf("discover render nodes: %w", err)
	}
	if len(renderNodes) == 0 {
		return "", fmt.Errorf("no /dev/dri/renderD* device is available")
	}
	var lastErr error
	for _, renderNode := range renderNodes {
		device, err := os.OpenFile(renderNode, os.O_RDWR, 0)
		if err != nil {
			lastErr = fmt.Errorf("open %s: %w", renderNode, err)
			continue
		}
		_ = device.Close()
		return renderNode, nil
	}
	return "", fmt.Errorf("none of the render nodes are accessible: %w", lastErr)
}

package browser

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const (
	gpuModeAuto     = "auto"
	gpuModeSoftware = "software"
	gpuModeHardware = "hardware"
	mediaCodecAuto  = "auto"
	mediaCodecVP8   = "vp8"
	mediaCodecH264  = "h264-va"
)

func resolveGPU(values RuntimeEnvValues) (RuntimeEnvValues, error) {
	requestedMode := strings.ToLower(strings.TrimSpace(values.GPUMode))
	requestedCodec := strings.ToLower(strings.TrimSpace(values.MediaProducerCodec))
	if requestedMode == "" {
		requestedMode = gpuModeAuto
	}
	if requestedCodec == "" {
		requestedCodec = mediaCodecAuto
	}

	var renderNode string
	var renderErr error
	if requestedMode != gpuModeSoftware {
		renderNode, renderErr = accessibleRenderNode()
	}
	switch requestedMode {
	case gpuModeSoftware:
		values.GPUMode = gpuModeSoftware
		values.RenderNode = ""
		if requestedCodec == mediaCodecH264 {
			return RuntimeEnvValues{}, fmt.Errorf("h264-va requires gpu_mode hardware or auto with an accessible render node")
		}
		values.MediaProducerCodec = mediaCodecVP8
	case gpuModeHardware:
		if renderErr != nil {
			return RuntimeEnvValues{}, fmt.Errorf("gpu_mode hardware: %w", renderErr)
		}
		values.GPUMode = gpuModeHardware
		values.RenderNode = renderNode
		if requestedCodec == mediaCodecAuto {
			values.MediaProducerCodec = mediaCodecH264
		} else {
			values.MediaProducerCodec = requestedCodec
		}
	case gpuModeAuto:
		switch requestedCodec {
		case mediaCodecH264:
			if renderErr != nil {
				return RuntimeEnvValues{}, fmt.Errorf("h264-va requires an accessible render node: %w", renderErr)
			}
			values.GPUMode = gpuModeHardware
			values.RenderNode = renderNode
			values.MediaProducerCodec = mediaCodecH264
		case mediaCodecVP8:
			values.MediaProducerCodec = mediaCodecVP8
			if renderErr == nil {
				values.GPUMode = gpuModeHardware
				values.RenderNode = renderNode
			} else {
				values.GPUMode = gpuModeSoftware
			}
		case mediaCodecAuto:
			if renderErr == nil && (!values.MediaProducerEnabled || probeMediaCodec(values, mediaCodecH264) == nil) {
				values.GPUMode = gpuModeHardware
				values.RenderNode = renderNode
				values.MediaProducerCodec = mediaCodecH264
			} else {
				values.GPUMode = gpuModeSoftware
				values.MediaProducerCodec = mediaCodecVP8
			}
		default:
			return RuntimeEnvValues{}, fmt.Errorf("unsupported media producer codec %q", requestedCodec)
		}
	default:
		return RuntimeEnvValues{}, fmt.Errorf("unsupported gpu mode %q", requestedMode)
	}

	if values.MediaProducerEnabled {
		if err := probeMediaCodec(values, values.MediaProducerCodec); err != nil {
			return RuntimeEnvValues{}, err
		}
	}
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
	for _, renderNode := range renderNodes {
		device, err := os.OpenFile(renderNode, os.O_RDWR, 0)
		if err != nil {
			continue
		}
		_ = device.Close()
		return renderNode, nil
	}
	return "", fmt.Errorf("none of the render nodes are accessible")
}

func probeMediaCodec(values RuntimeEnvValues, codec string) error {
	inspectExecutable := filepath.Join(filepath.Dir(values.MediaProducerGSTExecutable), "gst-inspect-1.0")
	elements := []string{"pipewiresrc", "queue", "videorate", "udpsink"}
	switch codec {
	case mediaCodecVP8:
		elements = append(elements, "videoconvert", "vp8enc", "rtpvp8pay")
	case mediaCodecH264:
		elements = append(elements, "vapostproc", "vah264enc", "h264parse", "rtph264pay")
	default:
		return fmt.Errorf("unsupported media producer codec %q", codec)
	}
	for _, element := range elements {
		cmd := exec.Command(inspectExecutable, "--exists", element)
		cmd.Env = wrapperMediaProcessEnv(values.MediaProducerPluginPath)
		cmd.Env = append(cmd.Env, "GST_REGISTRY_1_0="+filepath.Join(values.CacheDir, "gstreamer-registry.bin"))
		if output, err := cmd.CombinedOutput(); err != nil {
			detail := strings.TrimSpace(string(output))
			if detail != "" {
				return fmt.Errorf("media codec %s requires GStreamer element %s: %s", codec, element, detail)
			}
			return fmt.Errorf("media codec %s requires GStreamer element %s", codec, element)
		}
	}
	return nil
}

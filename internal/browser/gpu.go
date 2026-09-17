package browser

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
)

const (
	gpuModeAuto     = "auto"
	gpuModeSoftware = "software"
	gpuModeHardware = "hardware"
	mediaCodecAuto  = "auto"
	mediaCodecVP8   = "vp8"
	mediaCodecH264  = "h264-va"
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
	mediaEncodingEnabled := values.MediaProducerEnabled || values.RecordingMechanism != ""

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
		if requestedCodec == mediaCodecX264 {
			values.MediaProducerCodec = mediaCodecX264
		} else {
			values.MediaProducerCodec = mediaCodecVP8
		}
	case gpuModeHardware:
		if renderErr != nil {
			return RuntimeEnvValues{}, fmt.Errorf("gpu_mode hardware: %w", renderErr)
		}
		values.GPUMode = gpuModeHardware
		values.RenderNode = renderNode
		if requestedCodec == mediaCodecAuto {
			if !mediaEncodingEnabled || probeMediaCodec(values, mediaCodecH264) == nil {
				values.MediaProducerCodec = mediaCodecH264
			} else {
				values.MediaProducerCodec = mediaCodecVP8
			}
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
		case mediaCodecVP8, mediaCodecX264:
			values.MediaProducerCodec = requestedCodec
			if renderErr == nil {
				values.GPUMode = gpuModeHardware
				values.RenderNode = renderNode
			} else {
				values.GPUMode = gpuModeSoftware
			}
		case mediaCodecAuto:
			if renderErr == nil && (!mediaEncodingEnabled || probeMediaCodec(values, mediaCodecH264) == nil) {
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

	if mediaEncodingEnabled {
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

func probeMediaCodec(values RuntimeEnvValues, codec string) error {
	inspectExecutable := filepath.Join(filepath.Dir(values.MediaProducerGSTExecutable), "gst-inspect-1.0")
	registryPath := filepath.Join(values.CacheDir, "gstreamer-registry.bin")
	cache := values.mediaProbeCache
	if cache == nil {
		cache = newMediaProbeCache()
	}
	elements := []string{"queue"}
	if values.RecordingMechanism == RecordingMechanismCDP {
		elements = append(elements, "appsrc", "videocrop", "filesink", "concat", "matroskademux")
	}
	if values.RecordingMechanism == RecordingMechanismCompositor || values.MediaProducerEnabled {
		elements = append(elements, "pipewiresrc", "videorate")
	}
	if values.MediaProducerEnabled {
		elements = append(elements, "udpsink")
	}
	switch codec {
	case mediaCodecVP8:
		elements = append(elements, "videoconvert", "vp8enc")
		if values.RecordingMechanism != "" {
			elements = append(elements, "webmmux")
		}
		if values.MediaProducerEnabled {
			elements = append(elements, "rtpvp8pay")
		}
	case mediaCodecH264:
		elements = append(elements, "vapostproc", "vah264enc", "h264parse")
		if values.RecordingMechanism != "" {
			elements = append(elements, "matroskamux")
		}
		if values.MediaProducerEnabled {
			elements = append(elements, "rtph264pay")
		}
	case mediaCodecX264:
		elements = append(elements, "videoconvert", "x264enc", "h264parse", "rtph264pay")
	default:
		return fmt.Errorf("unsupported media producer codec %q", codec)
	}
	for _, element := range elements {
		result := cache.probe(inspectExecutable, values.MediaProducerPluginPath, registryPath, element)
		if result.failed {
			detail := result.detail
			if detail != "" {
				return fmt.Errorf("media codec %s requires GStreamer element %s: %s", codec, element, detail)
			}
			return fmt.Errorf("media codec %s requires GStreamer element %s", codec, element)
		}
	}
	return nil
}

type mediaProbeCache struct {
	mu      sync.Mutex
	entries map[mediaProbeCacheKey]mediaProbeResult
}

type mediaProbeCacheKey struct {
	inspectExecutable string
	pluginPath        string
	registryPath      string
	element           string
}

type mediaProbeResult struct {
	failed bool
	detail string
}

func newMediaProbeCache() *mediaProbeCache {
	return &mediaProbeCache{entries: make(map[mediaProbeCacheKey]mediaProbeResult)}
}

func (c *mediaProbeCache) probe(inspectExecutable, pluginPath, registryPath, element string) mediaProbeResult {
	key := mediaProbeCacheKey{
		inspectExecutable: inspectExecutable,
		pluginPath:        pluginPath,
		registryPath:      registryPath,
		element:           element,
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	if result, ok := c.entries[key]; ok {
		return result
	}

	cmd := exec.Command(inspectExecutable, "--exists", element)
	cmd.Env = wrapperMediaProcessEnv(pluginPath)
	cmd.Env = append(cmd.Env, "GST_REGISTRY_1_0="+registryPath)
	output, err := cmd.CombinedOutput()
	result := mediaProbeResult{}
	if err != nil {
		result.failed = true
		result.detail = strings.TrimSpace(string(output))
	}
	c.entries[key] = result
	return result
}

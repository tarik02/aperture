package browser

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/go-gst/go-gst/gst"
	gstapp "github.com/go-gst/go-gst/gst/app"
	"github.com/tarik02/webdesktop/media"
)

const (
	mediaProbeTimeout = 5 * time.Second
	mediaProbeTTL     = 30 * time.Second
	MediaProbeArg     = "--probe-media-encoder"
)

type mediaProbeCache struct {
	mu      sync.Mutex
	entries map[[32]byte]mediaProbeResult
}

type mediaProbeResult struct {
	profile media.EncoderProfile
	expires time.Time
}

func newMediaProbeCache() *mediaProbeCache {
	return &mediaProbeCache{entries: make(map[[32]byte]mediaProbeResult)}
}

func probeMediaCandidate(values RuntimeEnvValues, candidate mediaCandidate) (media.EncoderProfile, error) {
	executable, err := os.Executable()
	if err != nil {
		return media.EncoderProfile{}, fmt.Errorf("locate encoder probe executable: %w", err)
	}
	config := mediaCandidateConfig(values, candidate)
	request, err := json.Marshal(config)
	if err != nil {
		return media.EncoderProfile{}, err
	}
	env := mediaProbeProcessEnv(values)
	key := mediaProbeIdentity(executable, values, request, env)
	cache := values.mediaProbeCache
	if cache == nil {
		cache = newMediaProbeCache()
	}
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if result, ok := cache.entries[key]; ok && time.Now().Before(result.expires) {
		return result.profile, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), mediaProbeTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, executable, MediaProbeArg)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
	cmd.Env = env
	cmd.Stdin = bytes.NewReader(request)
	output := &boundedProbeOutput{limit: 1 << 20}
	detail := &boundedProbeOutput{limit: 4096}
	cmd.Stdout = output
	cmd.Stderr = detail
	// WaitDelay also bounds inherited pipes if a plugin starts a child process.
	cmd.WaitDelay = time.Second
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return media.EncoderProfile{}, fmt.Errorf("keyframe probe exceeded %s", mediaProbeTimeout)
		}
		return media.EncoderProfile{}, fmt.Errorf("keyframe probe failed: %w: %s", err, strings.TrimSpace(detail.String()))
	}
	var profile media.EncoderProfile
	if err := json.Unmarshal(output.Bytes(), &profile); err != nil {
		return media.EncoderProfile{}, fmt.Errorf("read encoder probe result: %w", err)
	}
	for key, result := range cache.entries {
		if time.Now().After(result.expires) {
			delete(cache.entries, key)
		}
	}
	cache.entries[key] = mediaProbeResult{profile: profile, expires: time.Now().Add(mediaProbeTTL)}
	return profile, nil
}

func mediaProbeIdentity(executable string, values RuntimeEnvValues, request []byte, env []string) [32]byte {
	hash := sha256.New()
	_, _ = hash.Write(request)
	for _, value := range env {
		key, _, _ := strings.Cut(value, "=")
		switch key {
		case "LD_LIBRARY_PATH", "LD_PRELOAD", "LIBVA_DRIVER_NAME", "LIBVA_DRIVERS_PATH", "CUDA_VISIBLE_DEVICES", "NVIDIA_VISIBLE_DEVICES", "NVIDIA_DRIVER_CAPABILITIES", "GST_PLUGIN_PATH", "GST_PLUGIN_PATH_1_0", "GST_PLUGIN_SYSTEM_PATH", "GST_PLUGIN_SYSTEM_PATH_1_0", "GST_PLUGIN_SCANNER", "GST_PLUGIN_SCANNER_1_0", "GST_REGISTRY_1_0":
			_, _ = fmt.Fprintf(hash, "%q;", value)
		}
	}
	paths := []string{executable, values.MediaProducerGSTExecutable, values.RenderNode, "/sys/module/nvidia/version"}
	for _, pattern := range []string{"/dev/dri/renderD*", "/dev/nvidia*"} {
		devices, _ := filepath.Glob(pattern)
		paths = append(paths, devices...)
	}
	for _, directory := range filepath.SplitList(values.MediaProducerPluginPath) {
		paths = append(paths, directory)
		plugins, _ := filepath.Glob(filepath.Join(directory, "*.so"))
		paths = append(paths, plugins...)
	}
	for _, path := range paths {
		info, err := os.Stat(path)
		if err != nil {
			_, _ = fmt.Fprintf(hash, "%q:%v;", path, err)
			continue
		}
		_, _ = fmt.Fprintf(hash, "%q:%d:%d:%v;", path, info.Size(), info.ModTime().UnixNano(), info.Mode())
		if stat, ok := info.Sys().(*syscall.Stat_t); ok {
			_, _ = fmt.Fprintf(hash, "%d:%d:%d;", stat.Dev, stat.Ino, stat.Rdev)
		}
	}
	return [32]byte(hash.Sum(nil))
}

func mediaProbeProcessEnv(values RuntimeEnvValues) []string {
	// Native streaming inherits the wrapper's environment, including NVIDIA
	// library lookup paths. Probe under that same environment.
	env := make([]string, 0, len(os.Environ())+2)
	for _, value := range os.Environ() {
		key, _, _ := strings.Cut(value, "=")
		if key == "GST_REGISTRY_1_0" || (key == "GST_PLUGIN_SYSTEM_PATH_1_0" && values.MediaProducerPluginPath != "") {
			continue
		}
		env = append(env, value)
	}
	if values.MediaProducerPluginPath != "" {
		env = append(env, "GST_PLUGIN_SYSTEM_PATH_1_0="+values.MediaProducerPluginPath)
	}
	return append(env, "GST_REGISTRY_1_0="+filepath.Join(values.CacheDir, "gstreamer-registry.bin"))
}

type boundedProbeOutput struct {
	bytes.Buffer
	limit int
}

func (output *boundedProbeOutput) Write(data []byte) (int, error) {
	length := len(data)
	if remaining := output.limit - output.Len(); remaining > 0 {
		_, _ = output.Buffer.Write(data[:min(remaining, length)])
	}
	return length, nil
}

// RunMediaEncoderProbe is an internal child-process mode of the session wrapper.
// Native initialization and teardown can block in a driver, so the parent kills
// this process at its deadline rather than probing inside the session process.
func RunMediaEncoderProbe(input io.Reader, output io.Writer) error {
	var config media.Config
	decoder := json.NewDecoder(io.LimitReader(input, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&config); err != nil {
		return fmt.Errorf("decode encoder probe: %w", err)
	}
	if config.Quality.Width < 1 || config.Quality.Width > 7680 || config.Quality.Height < 1 || config.Quality.Height > 4320 || config.Quality.Framerate < 1 {
		return fmt.Errorf("invalid encoder probe dimensions or framerate")
	}
	gst.Init(nil)
	// PipeWire transport is not live yet, but missing capture dependencies must
	// still prevent us from advertising an encoder.
	for _, name := range []string{"pipewiresrc", "queue", "videorate", "appsrc", "appsink"} {
		element, err := gst.NewElement(name)
		if err != nil {
			return fmt.Errorf("capture dependency %s: %w", name, err)
		}
		runtime.SetFinalizer(element.GObject(), nil)
		element.Unref()
	}
	profile, ok := config.Profiles[config.Quality.Profile]
	if !ok {
		return fmt.Errorf("encoder probe profile %q is missing", config.Quality.Profile)
	}
	for _, hints := range []struct {
		factory string
		values  []string
	}{
		{"vah264enc", []string{"b-frames=0", "cabac=false", "cabac=true", "dct8x8=false", "dct8x8=true", "rate-control=cbr"}},
		{"nvh264enc", []string{"bframes=0", "zerolatency=true", "rc-mode=cbr"}},
	} {
		if !strings.Contains(profile.Pipeline, hints.factory+" ") {
			continue
		}
		element, err := gst.NewElement(hints.factory)
		if err != nil {
			return err
		}
		for _, hint := range hints.values {
			property, _, _ := strings.Cut(hint, "=")
			if _, err := element.GetProperty(property); err != nil {
				profile.Pipeline = strings.ReplaceAll(profile.Pipeline, hint, "")
			}
		}
		runtime.SetFinalizer(element.GObject(), nil)
		element.Unref()
	}
	if err := profile.Validate(config.Quality.Profile, config.Tuning); err != nil {
		return err
	}
	path, err := profile.RenderPipeline(config.Quality.Profile, "probe", config.Quality, config.Tuning)
	if err != nil {
		return err
	}
	description := fmt.Sprintf("appsrc name=probe-source is-live=true format=time block=false ! videorate drop-only=true max-rate=%d skip-to-first=true ! %s ! appsink name=probe-sink sync=false async=false wait-on-eos=false enable-last-sample=false max-buffers=1", config.Quality.Framerate, path)
	pipeline, err := gst.NewPipelineFromString(description)
	if err != nil {
		return fmt.Errorf("create encoder pipeline: %w", err)
	}
	defer func() { _ = pipeline.SetState(gst.StateNull) }()
	sourceElement, err := pipeline.GetElementByName("probe-source")
	if err != nil {
		return err
	}
	sinkElement, err := pipeline.GetElementByName("probe-sink")
	if err != nil {
		return err
	}
	source := gstapp.SrcFromElement(sourceElement)
	sink := gstapp.SinkFromElement(sinkElement)
	// Weston hands the media service ordinary raw buffers. Exercise conversion
	// and resizing as well as encoder initialization, not just element presence.
	width, height := config.Quality.Width+2, config.Quality.Height+2
	source.SetCaps(gst.NewCapsFromString(fmt.Sprintf("video/x-raw,format=BGRx,width=%d,height=%d,framerate=%d/1", width, height, config.Quality.Framerate)))
	if err := pipeline.SetState(gst.StatePlaying); err != nil {
		return err
	}
	buffer := gst.NewBufferFromBytes(make([]byte, width*height*4))
	buffer.SetPresentationTimestamp(0)
	buffer.SetDuration(gst.ClockTime(time.Second / time.Duration(config.Quality.Framerate)))
	if flow := source.PushBuffer(buffer); flow != gst.FlowOK {
		return fmt.Errorf("push probe frame: %s", flow)
	}
	runtime.SetFinalizer(buffer, nil)
	buffer.Unref()
	if flow := source.EndStream(); flow != gst.FlowOK {
		return fmt.Errorf("finish probe frame: %s", flow)
	}
	sample := sink.TryPullSample(gst.ClockTime(4 * time.Second))
	if sample == nil {
		if message := pipeline.GetBus().TimedPopFiltered(0, gst.MessageError); message != nil {
			return fmt.Errorf("encoder pipeline: %v", message.ParseError())
		}
		return fmt.Errorf("encoder emitted no keyframe within 4s")
	}
	runtime.SetFinalizer(sample, nil)
	defer sample.Unref()
	encoded := sample.GetBuffer()
	if encoded == nil || encoded.GetSize() == 0 || encoded.HasFlags(gst.BufferFlagDeltaUnit) {
		return fmt.Errorf("encoder emitted no non-empty keyframe")
	}
	return json.NewEncoder(output).Encode(profile)
}

// Recording pipelines still use command-line GStreamer and have their own
// element preflight. WebRTC candidates additionally require a keyframe probe.
func probeGStreamerElements(values RuntimeEnvValues, codec string, elements []string) error {
	ctx, cancel := context.WithTimeout(context.Background(), mediaProbeTimeout)
	defer cancel()
	inspect := filepath.Join(filepath.Dir(values.MediaProducerGSTExecutable), "gst-inspect-1.0")
	for _, element := range elements {
		cmd := exec.CommandContext(ctx, inspect, "--exists", element)
		cmd.Env = wrapperMediaProcessEnv(values.MediaProducerPluginPath)
		cmd.Env = append(cmd.Env, "GST_REGISTRY_1_0="+filepath.Join(values.CacheDir, "gstreamer-registry.bin"))
		cmd.WaitDelay = time.Second
		output := &boundedProbeOutput{limit: 4096}
		cmd.Stdout, cmd.Stderr = output, output
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("media codec %s requires GStreamer element %s: %w: %s", codec, element, err, strings.TrimSpace(output.String()))
		}
	}
	return nil
}

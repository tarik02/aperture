package browser

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/tarik02/webdesktop/media"
)

const (
	mediaProbeTimeout = 5 * time.Second
	MediaProbeArg     = "--probe-media-encoder"
)

func probeMediaEncoder(values RuntimeEnvValues, encoder mediaEncoder) (media.EncoderProfile, error) {
	executable, err := os.Executable()
	if err != nil {
		return media.EncoderProfile{}, fmt.Errorf("locate encoder probe executable: %w", err)
	}
	request, err := json.Marshal(mediaEncoderConfig(values, encoder))
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
	profile, err := runMediaProbe(executable, request, env)
	if err != nil {
		return media.EncoderProfile{}, err
	}
	for key, result := range cache.entries {
		if time.Now().After(result.expires) {
			delete(cache.entries, key)
		}
	}
	cache.entries[key] = mediaProbeResult{profile: profile, expires: time.Now().Add(mediaProbeTTL)}
	return profile, nil
}

func runMediaProbe(executable string, request []byte, env []string) (media.EncoderProfile, error) {
	ctx, cancel := context.WithTimeout(context.Background(), mediaProbeTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, executable, MediaProbeArg)
	// A hung driver or plugin scanner must not survive the probe deadline.
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
	cmd.Stdout, cmd.Stderr = output, detail
	// Bound inherited pipes even if a plugin leaves a descendant running.
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
	return profile, nil
}

func mediaProbeProcessEnv(values RuntimeEnvValues) []string {
	// Streaming inherits driver library paths and CUDA visibility settings.
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

// Recording pipelines use command-line GStreamer, not the WebRTC keyframe probe.
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

package browser

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/tarik02/webdesktop/media"
)

func TestMain(m *testing.M) {
	if len(os.Args) == 2 && os.Args[1] == MediaProbeArg {
		if err := RunMediaEncoderProbe(os.Stdin, os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestMediaCandidateSelection(t *testing.T) {
	for _, test := range []struct {
		name      string
		requested string
		failed    []string
		want      string
		attempts  []string
	}{
		{"va works", mediaCodecAuto, nil, mediaCodecH264, []string{mediaCodecH264}},
		{"va fails and nvenc works", mediaCodecAuto, []string{mediaCodecH264}, mediaCodecNVENC, []string{mediaCodecH264, mediaCodecNVENC}},
		{"hardware fails", mediaCodecAuto, []string{mediaCodecH264, mediaCodecNVENC}, mediaCodecVP8, []string{mediaCodecH264, mediaCodecNVENC, mediaCodecVP8}},
		{"all fail", mediaCodecAuto, []string{mediaCodecH264, mediaCodecNVENC, mediaCodecVP8}, "", []string{mediaCodecH264, mediaCodecNVENC, mediaCodecVP8}},
		{"explicit va does not fall back", mediaCodecH264, []string{mediaCodecH264}, "", []string{mediaCodecH264}},
		{"explicit nvenc", mediaCodecNVENC, nil, mediaCodecNVENC, []string{mediaCodecNVENC}},
		{"explicit software", mediaCodecX264, nil, mediaCodecX264, []string{mediaCodecX264}},
		{"unknown override", "unknown", nil, "", nil},
	} {
		t.Run(test.name, func(t *testing.T) {
			var attempts []string
			selected, _, err := selectMediaCandidate(test.requested, mediaCandidates(RuntimeEnvValues{GPUMode: gpuModeHardware, RenderNode: "/dev/dri/renderD128"}), func(candidate mediaCandidate) (media.EncoderProfile, error) {
				attempts = append(attempts, candidate.codec)
				for _, failed := range test.failed {
					if candidate.codec == failed {
						return media.EncoderProfile{}, errors.New("driver failed to emit a keyframe")
					}
				}
				return candidate.profile, nil
			})
			if selected.codec != test.want || (err != nil) != (test.want == "") {
				t.Fatalf("selected=%q err=%v, want %q", selected.codec, err, test.want)
			}
			if !reflect.DeepEqual(attempts, test.attempts) {
				t.Fatalf("attempts=%v, want %v", attempts, test.attempts)
			}
			if len(test.failed) > 0 && test.want == "" && !strings.Contains(err.Error(), "driver failed") {
				t.Fatalf("error discarded rejection details: %v", err)
			}
		})
	}
}

func TestSoftwareModeExcludesHardwareEncoders(t *testing.T) {
	for _, candidate := range mediaCandidates(RuntimeEnvValues{GPUMode: gpuModeSoftware, RenderNode: "/dev/dri/renderD128"}) {
		if candidate.codec != mediaCodecVP8 && candidate.codec != mediaCodecX264 {
			t.Fatalf("software mode offered %s", candidate.name)
		}
	}
}

func TestAutoModeCanProbeNVENCWithoutDRM(t *testing.T) {
	candidates := mediaCandidates(RuntimeEnvValues{GPUMode: gpuModeSoftware, mediaRequestedGPUMode: gpuModeAuto})
	if candidates[0].codec != mediaCodecNVENC {
		t.Fatal("auto mode excluded NVENC without a DRM render node")
	}
}

func TestMediaProfilesRenderWithoutVendorSpecificProperties(t *testing.T) {
	values := probeTestValues(t)
	values.GPUMode, values.RenderNode = gpuModeHardware, "/dev/dri/renderD128"
	for _, candidate := range mediaCandidates(values) {
		config := mediaCandidateConfig(values, candidate)
		profile := config.Profiles[candidate.name]
		if err := profile.Validate(candidate.name, config.Tuning); err != nil {
			t.Fatalf("%s: %v", candidate.name, err)
		}
		pipeline, err := profile.RenderPipeline(candidate.name, "test", config.Quality, config.Tuning)
		if err != nil {
			t.Fatal(err)
		}
		for _, unsupported := range []string{"scale-method=", "target-usage=", "mbbrc="} {
			if strings.Contains(pipeline, unsupported) {
				t.Fatalf("%s retains %s", candidate.name, unsupported)
			}
		}
	}
}

func TestMediaProbeIdentity(t *testing.T) {
	values := probeTestValues(t)
	values.MediaProducerPluginPath = t.TempDir()
	plugin := filepath.Join(values.MediaProducerPluginPath, "libgsttest.so")
	if err := os.WriteFile(plugin, []byte("first"), 0o600); err != nil {
		t.Fatal(err)
	}
	first := mediaProbeIdentity("/missing/executable", values, []byte("profile"), []string{"LIBVA_DRIVER_NAME=first"})
	if first != mediaProbeIdentity("/missing/executable", values, []byte("profile"), []string{"LIBVA_DRIVER_NAME=first"}) {
		t.Fatal("unchanged runtime changed cache identity")
	}
	if first == mediaProbeIdentity("/missing/executable", values, []byte("changed quality"), []string{"LIBVA_DRIVER_NAME=first"}) {
		t.Fatal("quality change did not invalidate cache")
	}
	if first == mediaProbeIdentity("/missing/executable", values, []byte("profile"), []string{"LIBVA_DRIVER_NAME=second"}) {
		t.Fatal("driver environment change did not invalidate cache")
	}
	if err := os.WriteFile(plugin, []byte("second version"), 0o600); err != nil {
		t.Fatal(err)
	}
	if first == mediaProbeIdentity("/missing/executable", values, []byte("profile"), []string{"LIBVA_DRIVER_NAME=first"}) {
		t.Fatal("plugin change did not invalidate cache")
	}
}

func TestMediaProbeUsesStreamingDriverEnvironment(t *testing.T) {
	t.Setenv("LD_LIBRARY_PATH", "/driver/lib")
	t.Setenv("CUDA_VISIBLE_DEVICES", "1")
	t.Setenv("GST_PLUGIN_SYSTEM_PATH_1_0", "/old/plugins")
	t.Setenv("GST_REGISTRY_1_0", "/old/registry")
	values := probeTestValues(t)
	values.MediaProducerPluginPath = "/configured/plugins"
	env := mediaProbeProcessEnv(values)
	for _, wanted := range []string{"LD_LIBRARY_PATH=/driver/lib", "CUDA_VISIBLE_DEVICES=1", "GST_PLUGIN_SYSTEM_PATH_1_0=/configured/plugins", "GST_REGISTRY_1_0=" + filepath.Join(values.CacheDir, "gstreamer-registry.bin")} {
		found := false
		for _, value := range env {
			if value == wanted {
				found = true
			}
			if value == "GST_PLUGIN_SYSTEM_PATH_1_0=/old/plugins" || value == "GST_REGISTRY_1_0=/old/registry" {
				t.Fatalf("probe retained an overridden environment value %s", value)
			}
		}
		if !found {
			t.Fatalf("probe omitted %s", wanted)
		}
	}
}

func TestMediaEncoderProbeIntegration(t *testing.T) {
	if os.Getenv("APERTURE_MEDIA_PROBE_INTEGRATION") != "1" {
		t.Skip("set APERTURE_MEDIA_PROBE_INTEGRATION=1 with the runtime GStreamer plugins to test encoding")
	}
	values := probeTestValues(t)
	values.MediaProducerPluginPath = os.Getenv("GST_PLUGIN_SYSTEM_PATH_1_0")
	values.mediaProbeCache = newMediaProbeCache()
	candidate := mediaCandidates(values)[0]
	profile, err := probeMediaCandidate(values, candidate)
	if err != nil {
		t.Fatal(err)
	}
	if profile.Codec.ID != "vp8" {
		t.Fatalf("probe returned codec %s", profile.Codec.ID)
	}
	if _, err := probeMediaCandidate(values, candidate); err != nil || len(values.mediaProbeCache.entries) != 1 {
		t.Fatalf("successful probe was not reused: %v", err)
	}
	broken := candidate
	broken.profile.Pipeline = strings.ReplaceAll(broken.profile.Pipeline, "deadline=1", "property-does-not-exist=1")
	if _, err := probeMediaCandidate(values, broken); err == nil || !strings.Contains(err.Error(), "property-does-not-exist") {
		t.Fatalf("element presence hid a bad property: %v", err)
	}
	noOutput := candidate
	noOutput.profile.Pipeline = strings.ReplaceAll(noOutput.profile.Pipeline, "video/x-vp8", "video/x-vp8 ! valve drop=true")
	start := time.Now()
	if _, err := probeMediaCandidate(values, noOutput); err == nil {
		t.Fatal("probe accepted a pipeline without an encoded frame")
	}
	if time.Since(start) > mediaProbeTimeout+2*time.Second {
		t.Fatal("failed probe exceeded its deadline")
	}
	if len(values.mediaProbeCache.entries) != 1 {
		t.Fatal("failed probes were cached")
	}
	hung := candidate
	hung.profile.Pipeline += " ! identity sleep-time=10000000"
	start = time.Now()
	if _, err := probeMediaCandidate(values, hung); err == nil || !strings.Contains(err.Error(), "exceeded") {
		t.Fatalf("parent did not kill a stuck native pipeline: %v", err)
	}
	if time.Since(start) > mediaProbeTimeout+2*time.Second {
		t.Fatal("stuck native pipeline exceeded its deadline")
	}
	t.Run("stuck plugin scanner", func(t *testing.T) {
		shell, err := exec.LookPath("sh")
		if err != nil {
			t.Fatal(err)
		}
		sleep, err := exec.LookPath("sleep")
		if err != nil {
			t.Fatal(err)
		}
		directory := t.TempDir()
		pidFile := filepath.Join(directory, "scanner.pid")
		scanner := filepath.Join(directory, "scanner")
		script := fmt.Sprintf("#!%s\nprintf '%%s' \"$$\" > %q\nexec %q 30\n", shell, pidFile, sleep)
		if err := os.WriteFile(scanner, []byte(script), 0o700); err != nil {
			t.Fatal(err)
		}
		t.Setenv("GST_PLUGIN_SCANNER_1_0", scanner)
		scannerValues := values
		scannerValues.CacheDir = t.TempDir()
		scannerValues.mediaProbeCache = newMediaProbeCache()
		if _, err := probeMediaCandidate(scannerValues, candidate); err == nil {
			t.Fatal("hung scanner did not fail the probe")
		}
		pidBytes, err := os.ReadFile(pidFile)
		if err != nil {
			t.Fatalf("scanner was not exercised: %v", err)
		}
		pid, err := strconv.Atoi(string(pidBytes))
		if err != nil {
			t.Fatal(err)
		}
		if err := syscall.Kill(pid, 0); err == nil {
			stat, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
			if err == nil && !strings.Contains(string(stat), ") Z ") {
				t.Fatalf("scanner process %d survived probe cancellation", pid)
			}
		}
	})
	_, _, err = selectMediaCandidate(mediaCodecAuto, []mediaCandidate{broken, candidate}, func(candidate mediaCandidate) (media.EncoderProfile, error) {
		return probeMediaCandidate(values, candidate)
	})
	if err != nil {
		t.Fatalf("real pipeline failure did not fall back: %v", err)
	}
}

func TestMediaEncoderHardwareProbeIntegration(t *testing.T) {
	codec := os.Getenv("APERTURE_MEDIA_PROBE_HARDWARE_CODEC")
	if codec == "" {
		t.Skip("set APERTURE_MEDIA_PROBE_HARDWARE_CODEC=h264-va or h264-nvenc with the runtime plugins and devices")
	}
	if codec != mediaCodecH264 && codec != mediaCodecNVENC {
		t.Fatalf("unsupported hardware test codec %q", codec)
	}
	values := probeTestValues(t)
	values.GPUMode = gpuModeHardware
	var err error
	values.RenderNode, err = accessibleRenderNode()
	if codec == mediaCodecH264 && err != nil {
		t.Fatal(err)
	}
	values.MediaProducerPluginPath = os.Getenv("GST_PLUGIN_SYSTEM_PATH_1_0")
	for _, candidate := range mediaCandidates(values) {
		if candidate.codec != codec {
			continue
		}
		t.Run(candidate.name, func(t *testing.T) {
			profile, err := probeMediaCandidate(values, candidate)
			if err != nil {
				t.Fatal(err)
			}
			t.Logf("%s emitted a keyframe with %s", candidate.name, profile.Codec.ID)
		})
	}
}

func probeTestValues(t *testing.T) RuntimeEnvValues {
	t.Helper()
	gstExecutable, _ := exec.LookPath("gst-launch-1.0")
	return RuntimeEnvValues{
		GPUMode: gpuModeSoftware, CacheDir: t.TempDir(), MediaProducerGSTExecutable: gstExecutable,
		CompositorWidth: 640, CompositorHeight: 480,
		MediaProducerFPS: 30, MediaProducerBitrateKbps: 1000, MediaProducerKeyframe: 30,
	}
}

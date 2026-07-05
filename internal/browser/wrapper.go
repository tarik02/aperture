package browser

import (
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// LaunchConfig describes a browser launch through bwrap.
type LaunchConfig struct {
	BwrapPath                string
	BrowserExecutable        string
	MergedUserDataDir        string
	DownloadsDir             string
	CacheDir                 string
	ArtifactsDir             string
	CDPPort                  int
	DefaultArgs              []string
	ExtraArgs                []string
	CaptureProofExtensionDir string
	HardwareAcceleration     bool
	NestedWaylandSocket      string
}

// BuildBwrapCommand constructs the bwrap command that launches Chromium.
func BuildBwrapCommand(cfg LaunchConfig) (*exec.Cmd, error) {
	if strings.TrimSpace(cfg.BwrapPath) == "" {
		return nil, fmt.Errorf("bwrap path is required")
	}
	if strings.TrimSpace(cfg.BrowserExecutable) == "" {
		return nil, fmt.Errorf("browser executable is required")
	}
	if strings.TrimSpace(cfg.CacheDir) == "" {
		return nil, fmt.Errorf("cache dir is required")
	}
	if !filepath.IsAbs(cfg.CacheDir) {
		return nil, fmt.Errorf("cache dir must be absolute")
	}
	if strings.TrimSpace(cfg.CaptureProofExtensionDir) != "" && !filepath.IsAbs(cfg.CaptureProofExtensionDir) {
		return nil, fmt.Errorf("capture proof extension dir must be absolute")
	}

	browserArgs, err := BuildLaunchArgs(cfg.MergedUserDataDir, cfg.CacheDir, cfg.CDPPort, cfg.DefaultArgs, cfg.ExtraArgs)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(cfg.CaptureProofExtensionDir) != "" {
		browserArgs = append(
			browserArgs,
			"--disable-extensions-except="+cfg.CaptureProofExtensionDir,
			"--load-extension="+cfg.CaptureProofExtensionDir,
		)
	}

	browserHome := filepath.Join(cfg.CacheDir, "home")
	browserCache := filepath.Join(browserHome, ".cache")
	browserConfig := filepath.Join(browserHome, ".config")
	for _, dir := range []struct {
		name string
		path string
	}{
		{name: "home", path: browserHome},
		{name: "cache", path: browserCache},
		{name: "config", path: browserConfig},
	} {
		if err := os.MkdirAll(dir.path, 0o700); err != nil {
			return nil, fmt.Errorf("mkdir browser %s dir: %w", dir.name, err)
		}
	}

	args := []string{
		"--die-with-parent",
		"--unshare-user-try",
		"--share-net",
		"--proc", "/proc",
		"--dev", "/dev",
		"--tmpfs", "/tmp",
	}

	isolatedRuntime := strings.TrimSpace(cfg.NestedWaylandSocket) != ""
	for _, bind := range hostBindMounts(!isolatedRuntime) {
		args = append(args, bind...)
	}

	runtimeMounts, err := runtimeBindMounts(cfg.NestedWaylandSocket)
	if err != nil {
		return nil, err
	}
	for _, bind := range runtimeMounts {
		args = append(args, bind...)
	}

	if cfg.HardwareAcceleration {
		hardwareMounts, err := hardwareAccelerationBindMounts()
		if err != nil {
			return nil, err
		}
		for _, bind := range hardwareMounts {
			args = append(args, bind...)
		}
	}

	for _, bind := range sessionBindMounts(cfg) {
		args = append(args, bind...)
	}
	if strings.TrimSpace(cfg.CaptureProofExtensionDir) != "" {
		args = append(args, "--ro-bind", cfg.CaptureProofExtensionDir, cfg.CaptureProofExtensionDir)
	}

	args = append(
		args,
		"--setenv", "TMPDIR", "/tmp",
		"--setenv", "HOME", browserHome,
		"--setenv", "XDG_CACHE_HOME", browserCache,
		"--setenv", "XDG_CONFIG_HOME", browserConfig,
	)

	for _, key := range passthroughEnvKeys(isolatedRuntime) {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			args = append(args, "--setenv", key, value)
		}
	}

	args = append(args, "--")
	args = append(args, cfg.BrowserExecutable)
	args = append(args, browserArgs...)

	cmd := exec.Command(cfg.BwrapPath, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd, nil
}

func sessionBindMounts(cfg LaunchConfig) [][]string {
	paths := []string{
		cfg.MergedUserDataDir,
		cfg.DownloadsDir,
		cfg.CacheDir,
		cfg.ArtifactsDir,
	}
	mounts := make([][]string, 0, len(paths))
	for _, path := range paths {
		if strings.TrimSpace(path) == "" {
			continue
		}
		mounts = append(mounts, []string{"--bind", path, path})
	}
	return mounts
}

func runtimeBindMounts(nestedWaylandSocket string) ([][]string, error) {
	runtimeDir := strings.TrimSpace(os.Getenv("XDG_RUNTIME_DIR"))
	if runtimeDir == "" || !filepath.IsAbs(runtimeDir) {
		if strings.TrimSpace(nestedWaylandSocket) != "" {
			return nil, fmt.Errorf("XDG_RUNTIME_DIR is required for nested Wayland socket")
		}
		return nil, nil
	}
	if strings.TrimSpace(nestedWaylandSocket) == "" {
		if _, err := os.Stat(runtimeDir); err != nil {
			return nil, nil
		}
		return [][]string{{"--bind", runtimeDir, runtimeDir}}, nil
	}

	socketName := strings.TrimSpace(nestedWaylandSocket)
	if strings.Contains(socketName, string(os.PathSeparator)) {
		return nil, fmt.Errorf("nested Wayland socket must be a socket name")
	}
	socketPath := filepath.Join(runtimeDir, socketName)
	if _, err := os.Stat(socketPath); err != nil {
		return nil, fmt.Errorf("stat nested Wayland socket: %w", err)
	}

	mounts := [][]string{{"--dir", "/run"}}
	if strings.HasPrefix(runtimeDir, "/run/") {
		mounts = append(mounts, []string{"--dir", "/run/user"})
	}
	mounts = append(
		mounts,
		[]string{"--dir", runtimeDir},
		[]string{"--bind", socketPath, socketPath},
	)
	return mounts, nil
}

func hardwareAccelerationBindMounts() ([][]string, error) {
	renderNodes, err := filepath.Glob("/dev/dri/renderD*")
	if err != nil || len(renderNodes) == 0 {
		return nil, fmt.Errorf("hardware acceleration requires /dev/dri/renderD*")
	}
	if _, err := os.Stat("/sys"); err != nil {
		return nil, fmt.Errorf("hardware acceleration requires /sys: %w", err)
	}

	mounts := make([][]string, 0, len(renderNodes)+4)
	mounts = append(mounts, []string{"--ro-bind", "/sys", "/sys"})
	for _, path := range []string{"/run/opengl-driver", "/run/opengl-driver-32"} {
		if _, err := os.Stat(path); err == nil {
			mounts = append(mounts, []string{"--ro-bind", path, path})
		}
	}
	mounts = append(mounts, []string{"--dir", "/dev/dri"})
	for _, path := range renderNodes {
		if _, err := os.Stat(path); err != nil {
			continue
		}
		mounts = append(mounts, []string{"--dev-bind", path, path})
	}
	return mounts, nil
}

func hostBindMounts(includeRun bool) [][]string {
	candidates := []string{
		"/usr",
		"/lib",
		"/lib64",
		"/bin",
		"/etc",
		"/var",
		"/nix",
	}
	if includeRun {
		candidates = append(candidates, "/run")
	}
	home, err := os.UserHomeDir()
	if err == nil && home != "" {
		candidates = append(candidates, home)
	}

	mounts := make([][]string, 0, len(candidates))
	for _, path := range candidates {
		if _, err := os.Stat(path); err != nil {
			continue
		}
		mounts = append(mounts, []string{"--ro-bind", path, path})
	}
	return mounts
}

func passthroughEnvKeys(isolatedRuntime bool) []string {
	if isolatedRuntime {
		return []string{
			"WAYLAND_DISPLAY",
			"XDG_RUNTIME_DIR",
			"NVIDIA_VISIBLE_DEVICES",
			"LIBVA_DRIVER_NAME",
		}
	}
	return []string{
		"DISPLAY",
		"WAYLAND_DISPLAY",
		"XDG_RUNTIME_DIR",
		"DBUS_SESSION_BUS_ADDRESS",
		"PULSE_SERVER",
		"XDG_SESSION_TYPE",
		"XDG_CURRENT_DESKTOP",
		"NVIDIA_VISIBLE_DEVICES",
		"LIBVA_DRIVER_NAME",
		"MOZ_DISABLE_RDD_SANDBOX",
	}
}

// LaunchFromRuntimeEnv reads the current process environment and launches Chromium through bwrap.
func LaunchFromRuntimeEnv() error {
	values, err := ParseRuntimeEnvFromProcess()
	if err != nil {
		return err
	}
	if values.MediaProducerEnabled && !values.CompositorEnabled {
		return fmt.Errorf("media producer requires compositor mode")
	}

	bwrapPath, err := exec.LookPath("bwrap")
	if err != nil {
		return fmt.Errorf("locate bwrap: %w", err)
	}

	if values.CompositorEnabled {
		return launchWithCompositor(values, bwrapPath)
	}

	cmd, err := BuildBwrapCommand(LaunchConfig{
		BwrapPath:                bwrapPath,
		BrowserExecutable:        values.BrowserExecutable,
		MergedUserDataDir:        values.MergedUserDataDir,
		DownloadsDir:             values.DownloadsDir,
		CacheDir:                 values.CacheDir,
		ArtifactsDir:             values.ArtifactsDir,
		CDPPort:                  values.CDPPort,
		DefaultArgs:              values.BrowserDefaultArgs,
		ExtraArgs:                values.BrowserExtraArgs,
		CaptureProofExtensionDir: values.CaptureProofExtensionDir,
	})
	if err != nil {
		return err
	}

	return cmd.Run()
}

func launchWithCompositor(values RuntimeEnvValues, bwrapPath string) error {
	if strings.TrimSpace(values.CompositorExecutable) == "" {
		return fmt.Errorf("compositor executable is required")
	}
	if !filepath.IsAbs(values.CompositorExecutable) {
		return fmt.Errorf("compositor executable must be absolute")
	}
	switch strings.TrimSpace(values.CompositorBackend) {
	case "headless", "pipewire":
	default:
		return fmt.Errorf("compositor backend must be headless or pipewire")
	}
	if strings.TrimSpace(values.CompositorRenderer) != "gl" {
		return fmt.Errorf("compositor renderer must be gl")
	}
	if strings.TrimSpace(values.CompositorShell) != "kiosk" {
		return fmt.Errorf("compositor shell must be kiosk")
	}
	if values.CompositorWidth <= 0 || values.CompositorHeight <= 0 {
		return fmt.Errorf("compositor dimensions must be positive")
	}
	if values.MediaProducerEnabled {
		if strings.TrimSpace(values.MediaProducerExecutable) == "" {
			return fmt.Errorf("media producer executable is required")
		}
		if !filepath.IsAbs(values.MediaProducerExecutable) {
			return fmt.Errorf("media producer executable must be absolute")
		}
		if pluginPath := strings.TrimSpace(values.MediaProducerPluginPath); pluginPath != "" {
			for _, entry := range filepath.SplitList(pluginPath) {
				if strings.TrimSpace(entry) == "" {
					continue
				}
				if !filepath.IsAbs(entry) {
					return fmt.Errorf("media producer plugin path entries must be absolute")
				}
			}
		}
		if strings.TrimSpace(values.MediaProducerTarget) == "" {
			return fmt.Errorf("media producer target is required")
		}
	}
	if err := ValidateCompositorBrowserArgs(values.BrowserDefaultArgs); err != nil {
		return err
	}
	if err := ValidateCompositorBrowserArgs(values.BrowserExtraArgs); err != nil {
		return err
	}

	runtimeDir := strings.TrimSpace(os.Getenv("XDG_RUNTIME_DIR"))
	if runtimeDir == "" || !filepath.IsAbs(runtimeDir) {
		return fmt.Errorf("XDG_RUNTIME_DIR is required for compositor mode")
	}

	socketName := "aperture-" + values.SessionID
	socketPath := filepath.Join(runtimeDir, socketName)
	if err := os.Remove(socketPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove stale compositor socket: %w", err)
	}
	if err := os.MkdirAll(values.CacheDir, 0o700); err != nil {
		return fmt.Errorf("mkdir compositor cache dir: %w", err)
	}

	compositorLog := filepath.Join(values.CacheDir, "weston.log")
	compositor := exec.Command(values.CompositorExecutable,
		"--backend="+values.CompositorBackend,
		"--renderer="+values.CompositorRenderer,
		"--shell="+values.CompositorShell,
		fmt.Sprintf("--width=%d", values.CompositorWidth),
		fmt.Sprintf("--height=%d", values.CompositorHeight),
		"--socket="+socketName,
		"--no-config",
		"--idle-time=0",
		"--log="+compositorLog,
	)
	compositor.Stdout = os.Stdout
	compositor.Stderr = os.Stderr
	if err := compositor.Start(); err != nil {
		return fmt.Errorf("start compositor: %w", err)
	}
	compositorDone := make(chan error, 1)
	go func() {
		compositorDone <- compositor.Wait()
	}()

	if err := waitForWaylandSocket(socketPath, compositorDone); err != nil {
		if compositor.ProcessState == nil {
			stopProcess(compositor, compositorDone)
		}
		return err
	}

	oldWayland, hadWayland := os.LookupEnv("WAYLAND_DISPLAY")
	if err := os.Setenv("WAYLAND_DISPLAY", socketName); err != nil {
		stopProcess(compositor, compositorDone)
		return fmt.Errorf("set nested WAYLAND_DISPLAY: %w", err)
	}
	defer func() {
		if hadWayland {
			_ = os.Setenv("WAYLAND_DISPLAY", oldWayland)
		} else {
			_ = os.Unsetenv("WAYLAND_DISPLAY")
		}
	}()

	extraArgs := append([]string(nil), values.BrowserExtraArgs...)
	extraArgs = append(extraArgs,
		"--ozone-platform=wayland",
		"--ignore-gpu-blocklist",
		"--enable-gpu-rasterization",
		"--kiosk",
		fmt.Sprintf("--window-size=%d,%d", values.CompositorWidth, values.CompositorHeight),
	)
	browserCmd, err := BuildBwrapCommand(LaunchConfig{
		BwrapPath:                bwrapPath,
		BrowserExecutable:        values.BrowserExecutable,
		MergedUserDataDir:        values.MergedUserDataDir,
		DownloadsDir:             values.DownloadsDir,
		CacheDir:                 values.CacheDir,
		ArtifactsDir:             values.ArtifactsDir,
		CDPPort:                  values.CDPPort,
		DefaultArgs:              values.BrowserDefaultArgs,
		ExtraArgs:                extraArgs,
		CaptureProofExtensionDir: values.CaptureProofExtensionDir,
		HardwareAcceleration:     true,
		NestedWaylandSocket:      socketName,
	})
	if err != nil {
		stopProcess(compositor, compositorDone)
		return err
	}
	if err := browserCmd.Start(); err != nil {
		stopProcess(compositor, compositorDone)
		return fmt.Errorf("start browser: %w", err)
	}
	browserDone := make(chan error, 1)
	go func() {
		browserDone <- browserCmd.Wait()
	}()

	var producerCmd *exec.Cmd
	var producerDone <-chan error
	if values.MediaProducerEnabled {
		var err error
		producerCmd, producerDone, err = startMediaProducer(values)
		if err != nil {
			stopProcess(browserCmd, browserDone)
			stopProcess(compositor, compositorDone)
			return err
		}
	}

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(signals)

	select {
	case err := <-browserDone:
		stopProcess(producerCmd, producerDone)
		stopProcess(compositor, compositorDone)
		return err
	case err := <-compositorDone:
		stopProcess(producerCmd, producerDone)
		stopProcess(browserCmd, browserDone)
		if err != nil {
			return fmt.Errorf("compositor exited before browser: %w", err)
		}
		return fmt.Errorf("compositor exited before browser")
	case err := <-producerDone:
		stopProcess(browserCmd, browserDone)
		stopProcess(compositor, compositorDone)
		if err != nil {
			return fmt.Errorf("media producer exited before browser: %w", err)
		}
		return fmt.Errorf("media producer exited before browser")
	case <-signals:
		stopProcess(producerCmd, producerDone)
		stopProcess(browserCmd, browserDone)
		stopProcess(compositor, compositorDone)
		return nil
	}
}

func startMediaProducer(values RuntimeEnvValues) (*exec.Cmd, <-chan error, error) {
	args := []string{
		"-v",
		"pipewiresrc",
		"target-object=" + values.MediaProducerTarget,
		"do-timestamp=true",
		"!",
		fmt.Sprintf("video/x-raw,width=%d,height=%d", values.CompositorWidth, values.CompositorHeight),
		"!",
		"videoconvert",
		"!",
		"queue",
		"max-size-buffers=2",
		"leaky=downstream",
		"!",
		"vp8enc",
		"deadline=1",
		"keyframe-max-dist=30",
		"cpu-used=8",
		"!",
		"rtpvp8pay",
		"picture-id-mode=15-bit",
		"!",
		"fakesink",
		"sync=false",
	}
	cmd := exec.Command(values.MediaProducerExecutable, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if pluginPath := strings.TrimSpace(values.MediaProducerPluginPath); pluginPath != "" {
		cmd.Env = append(os.Environ(), "GST_PLUGIN_SYSTEM_PATH_1_0="+pluginPath)
	}
	if err := cmd.Start(); err != nil {
		return nil, nil, fmt.Errorf("start media producer: %w", err)
	}

	done := make(chan error, 1)
	go func() {
		done <- cmd.Wait()
	}()

	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	select {
	case err := <-done:
		if err != nil {
			return nil, nil, fmt.Errorf("media producer exited during startup: %w", err)
		}
		return nil, nil, fmt.Errorf("media producer exited during startup")
	case <-timer.C:
		return cmd, done, nil
	}
}

func waitForWaylandSocket(socketPath string, compositorDone <-chan error) error {
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()

	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case err := <-compositorDone:
			if err != nil {
				return fmt.Errorf("compositor exited before Wayland socket was ready: %w", err)
			}
			return fmt.Errorf("compositor exited before Wayland socket was ready")
		case <-timer.C:
			return fmt.Errorf("timed out waiting for compositor Wayland socket %s", socketPath)
		case <-ticker.C:
			if _, err := os.Stat(socketPath); err == nil {
				return nil
			} else if !os.IsNotExist(err) {
				return fmt.Errorf("stat compositor Wayland socket: %w", err)
			}
		}
	}
}

func stopProcess(cmd *exec.Cmd, done <-chan error) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	if cmd.ProcessState != nil {
		return
	}
	_ = cmd.Process.Signal(syscall.SIGTERM)
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	select {
	case <-done:
	case <-timer.C:
		_ = cmd.Process.Kill()
		<-done
	}
}

// ParseRuntimeEnvFromProcess reconstructs runtime env values from the process environment.
func ParseRuntimeEnvFromProcess() (RuntimeEnvValues, error) {
	required := map[string]*string{
		"APERTURE_SESSION_ID":  nil,
		"MERGED_USER_DATA_DIR": nil,
		"DOWNLOADS_DIR":        nil,
		"CACHE_DIR":            nil,
		"ARTIFACTS_DIR":        nil,
		"BROWSER_EXECUTABLE":   nil,
	}

	for key := range required {
		value := strings.TrimSpace(os.Getenv(key))
		if value == "" {
			return RuntimeEnvValues{}, fmt.Errorf("missing required env %s", key)
		}
		required[key] = &value
	}

	portRaw := strings.TrimSpace(os.Getenv("CDP_PORT"))
	if portRaw == "" {
		return RuntimeEnvValues{}, fmt.Errorf("missing required env CDP_PORT")
	}

	values := RuntimeEnvValues{
		SessionID:         *required["APERTURE_SESSION_ID"],
		MergedUserDataDir: *required["MERGED_USER_DATA_DIR"],
		DownloadsDir:      *required["DOWNLOADS_DIR"],
		CacheDir:          *required["CACHE_DIR"],
		ArtifactsDir:      *required["ARTIFACTS_DIR"],
		BrowserExecutable: *required["BROWSER_EXECUTABLE"],
	}

	if _, err := fmt.Sscanf(portRaw, "%d", &values.CDPPort); err != nil {
		return RuntimeEnvValues{}, fmt.Errorf("parse cdp port: %w", err)
	}

	if encoded := strings.TrimSpace(os.Getenv("BROWSER_DEFAULT_ARGS")); encoded != "" {
		args, err := decodeArgVector(encoded)
		if err != nil {
			return RuntimeEnvValues{}, fmt.Errorf("decode default args: %w", err)
		}
		values.BrowserDefaultArgs = args
	}
	if encoded := strings.TrimSpace(os.Getenv("BROWSER_EXTRA_ARGS")); encoded != "" {
		args, err := decodeArgVector(encoded)
		if err != nil {
			return RuntimeEnvValues{}, fmt.Errorf("decode extra args: %w", err)
		}
		values.BrowserExtraArgs = args
	}
	values.CaptureProofExtensionDir = strings.TrimSpace(os.Getenv("CAPTURE_PROOF_EXTENSION_DIR"))
	values.CompositorEnabled = strings.TrimSpace(os.Getenv("WEBRTC_COMPOSITOR_ENABLED")) == "1"
	values.CompositorExecutable = strings.TrimSpace(os.Getenv("WEBRTC_COMPOSITOR_EXECUTABLE"))
	values.CompositorBackend = strings.TrimSpace(os.Getenv("WEBRTC_COMPOSITOR_BACKEND"))
	values.CompositorRenderer = strings.TrimSpace(os.Getenv("WEBRTC_COMPOSITOR_RENDERER"))
	values.CompositorShell = strings.TrimSpace(os.Getenv("WEBRTC_COMPOSITOR_SHELL"))
	values.MediaProducerEnabled = strings.TrimSpace(os.Getenv("WEBRTC_MEDIA_PRODUCER_ENABLED")) == "1"
	values.MediaProducerExecutable = strings.TrimSpace(os.Getenv("WEBRTC_MEDIA_PRODUCER_EXECUTABLE"))
	values.MediaProducerPluginPath = strings.TrimSpace(os.Getenv("WEBRTC_MEDIA_PRODUCER_PLUGIN_PATH"))
	values.MediaProducerTarget = strings.TrimSpace(os.Getenv("WEBRTC_MEDIA_PRODUCER_TARGET"))
	if width := strings.TrimSpace(os.Getenv("WEBRTC_COMPOSITOR_WIDTH")); width != "" {
		parsed, err := strconv.Atoi(width)
		if err != nil {
			return RuntimeEnvValues{}, fmt.Errorf("parse compositor width: %w", err)
		}
		values.CompositorWidth = parsed
	}
	if height := strings.TrimSpace(os.Getenv("WEBRTC_COMPOSITOR_HEIGHT")); height != "" {
		parsed, err := strconv.Atoi(height)
		if err != nil {
			return RuntimeEnvValues{}, fmt.Errorf("parse compositor height: %w", err)
		}
		values.CompositorHeight = parsed
	}

	if err := ensureSessionPaths(values); err != nil {
		return RuntimeEnvValues{}, err
	}

	return values, nil
}

func ensureSessionPaths(values RuntimeEnvValues) error {
	for name, path := range map[string]string{
		"merged user data dir": values.MergedUserDataDir,
		"downloads dir":        values.DownloadsDir,
		"cache dir":            values.CacheDir,
		"artifacts dir":        values.ArtifactsDir,
	} {
		if !filepath.IsAbs(path) {
			return fmt.Errorf("%s must be absolute", name)
		}
	}
	return nil
}

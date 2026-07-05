package browser

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
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

	for _, bind := range hostBindMounts() {
		args = append(args, bind...)
	}

	for _, bind := range runtimeBindMounts() {
		args = append(args, bind...)
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

	for _, key := range passthroughEnvKeys() {
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

func runtimeBindMounts() [][]string {
	runtimeDir := strings.TrimSpace(os.Getenv("XDG_RUNTIME_DIR"))
	if runtimeDir == "" || !filepath.IsAbs(runtimeDir) {
		return nil
	}
	if _, err := os.Stat(runtimeDir); err != nil {
		return nil
	}
	return [][]string{{"--bind", runtimeDir, runtimeDir}}
}

func hostBindMounts() [][]string {
	candidates := []string{
		"/usr",
		"/lib",
		"/lib64",
		"/bin",
		"/etc",
		"/run",
		"/var",
		"/nix",
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

func passthroughEnvKeys() []string {
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

	bwrapPath, err := exec.LookPath("bwrap")
	if err != nil {
		return fmt.Errorf("locate bwrap: %w", err)
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

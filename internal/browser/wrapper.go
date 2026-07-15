package browser

import (
	"context"
	"encoding/json"
	"errors"
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

const compositorBrowserAppID = "aperture-browser"

var errPipeWireNodeNotFound = errors.New("pipewire node not found")

func apertureWestonShellPath() (string, error) {
	executable, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("resolve wrapper executable: %w", err)
	}
	return filepath.Join(filepath.Dir(filepath.Dir(executable)), "lib", "weston", "aperture-weston-shell.so"), nil
}

const compositorLuaShellScript = `
background_layer = {}
normal_layer = {}
hidden_layer = {}
primary_output = nil
active_view = nil

function recreate_curtain(output)
  local pd = output:get_private()
  local ox, oy = output:get_position()
  local width, height = output:get_dimensions()

  if (pd ~= nil and pd.curtain ~= nil) then
    pd.curtain:dispose()
  end

  if (pd == nil) then
    pd = {}
    output:set_private(pd)
  end

  pd.curtain = weston:create_curtain("aperture background")
  pd.curtain:set_color(0xFF000000)
  pd.curtain:set_position(ox, oy)
  pd.curtain:set_dimensions(width, height)
  pd.curtain:set_capture_input(false)

  local view = pd.curtain:get_view()
  view:set_output(output)
  view:set_layer(background_layer)
end

function first_output()
  if (primary_output ~= nil) then
    return primary_output
  end

  local outputs = weston:get_outputs()
  for n, output in pairs(outputs) do
    primary_output = output
    return output
  end

  return nil
end

function first_seat()
  local seats = weston:get_seats()
  for n, seat in pairs(seats) do
    return seat
  end

  return nil
end

function fit_surface(surface)
  local pd = surface:get_private()
  local output = first_output()

  if (pd == nil or output == nil) then
    return
  end

  local ox, oy = output:get_position()
  local width, height = output:get_dimensions()
  local gx, gy = surface:get_geometry()

  surface:set_output(output)
  pd.view:set_output(output)
  pd.view:set_position(ox - gx, oy - gy)
  pd.view:set_dimensions(width, height)
  surface:set_state_normal(width, height)
end

function output_create(output)
  if (primary_output == nil) then
    primary_output = output
  end

  output:set_private({})
  recreate_curtain(output)
  output:set_ready()
end

function output_resized(output)
  primary_output = output
  recreate_curtain(output)

  local surfaces = weston:get_surfaces()
  for n, surface in pairs(surfaces) do
    fit_surface(surface)
  end
end

function output_moved(output, move_x, move_y)
  output_resized(output)
end

function surface_added(surface)
  local view = surface:create_view()

  surface:set_private({ view = view })
  fit_surface(surface)
end

function surface_removed(surface)
  local pd = surface:get_private()

  if (pd == nil) then
    return
  end

  if (active_view == pd.view) then
    pd.view:deactivate()
    active_view = nil
  end

  pd.view:dispose()
end

function surface_committed(surface)
  local pd = surface:get_private()
  local width, height = surface:get_dimensions()

  if (pd == nil or width == 0 or height == 0) then
    return
  end

  fit_surface(surface)

  if (surface:is_mapped()) then
    return
  end

  surface:map()
  pd.view:set_layer(normal_layer)

  local seat = first_seat()
  if (seat ~= nil) then
    if (active_view ~= nil) then
      active_view:deactivate()
    end
    pd.view:activate(seat)
    active_view = pd.view
  end
end

function surface_fullscreen(surface, output, fullscreen)
  fit_surface(surface)
end

function surface_maximize(surface, maximized)
  fit_surface(surface)
end

function click_to_activate(focus_view, seat, button)
  if (active_view == focus_view) then
    return
  end

  if (active_view ~= nil) then
    active_view:deactivate()
  end

  focus_view:activate(seat)
  active_view = focus_view
end

function init()
  background_layer = weston:create_layer()
  background_layer:set_position(WESTON_LAYER_POSITION_BACKGROUND)

  normal_layer = weston:create_layer()
  normal_layer:set_position(WESTON_LAYER_POSITION_NORMAL)

  hidden_layer = weston:create_layer()
  hidden_layer:set_position(WESTON_LAYER_POSITION_HIDDEN)

  weston:add_button_binding(BTN_LEFT, 0, click_to_activate)
end

lua_shell_callbacks = {
  init = init,
  surface_added = surface_added,
  surface_committed = surface_committed,
  surface_fullscreen = surface_fullscreen,
  surface_maximize = surface_maximize,
  surface_removed = surface_removed,
  output_create = output_create,
  output_moved = output_moved,
  output_resized = output_resized,
}
`

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
	RenderNode               string
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
		"--clearenv",
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
		hardwareMounts, err := hardwareAccelerationBindMounts(cfg.RenderNode)
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
	cmd.Env = []string{}
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

func hardwareAccelerationBindMounts(renderNode string) ([][]string, error) {
	if strings.TrimSpace(renderNode) == "" {
		return nil, fmt.Errorf("hardware acceleration requires a render node")
	}
	if _, err := os.Stat("/sys"); err != nil {
		return nil, fmt.Errorf("hardware acceleration requires /sys: %w", err)
	}

	mounts := make([][]string, 0, 5)
	mounts = append(mounts, []string{"--ro-bind", "/sys", "/sys"})
	for _, path := range []string{"/run/opengl-driver", "/run/opengl-driver-32"} {
		if _, err := os.Stat(path); err == nil {
			mounts = append(mounts, []string{"--ro-bind", path, path})
		}
	}
	mounts = append(mounts, []string{"--dir", "/dev/dri"})
	if _, err := os.Stat(renderNode); err != nil {
		return nil, fmt.Errorf("stat render node: %w", err)
	}
	mounts = append(mounts, []string{"--dev-bind", renderNode, renderNode})
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
			"LIBVA_DRIVERS_PATH",
			"LIBGL_DRIVERS_PATH",
			"__EGL_VENDOR_LIBRARY_FILENAMES",
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
		"LIBVA_DRIVERS_PATH",
		"LIBGL_DRIVERS_PATH",
		"__EGL_VENDOR_LIBRARY_FILENAMES",
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

	values, err = resolveGPU(values)
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "browser-session-wrapper: gpu mode=%s renderNode=%s mediaCodec=%s\n", values.GPUMode, values.RenderNode, values.MediaProducerCodec)

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
		HardwareAcceleration:     values.GPUMode == gpuModeHardware,
		RenderNode:               values.RenderNode,
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
	compositorShell := strings.TrimSpace(values.CompositorShell)
	switch compositorShell {
	case "kiosk", "desktop", "lua-shell", "lua-shell.so", "aperture", "aperture-weston-shell.so":
	default:
		return fmt.Errorf("compositor shell must be kiosk, desktop, or lua-shell")
	}
	if values.CompositorWidth <= 0 || values.CompositorHeight <= 0 {
		return fmt.Errorf("compositor dimensions must be positive")
	}
	if values.MediaProducerEnabled {
		if strings.TrimSpace(values.MediaProducerGSTExecutable) == "" {
			return fmt.Errorf("media producer gst executable is required")
		}
		if !filepath.IsAbs(values.MediaProducerGSTExecutable) {
			return fmt.Errorf("media producer gst executable must be absolute")
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

	controlSocket := filepath.Join(values.CacheDir, "compositor.control")
	if err := os.Remove(controlSocket); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove stale compositor control socket: %w", err)
	}
	ctx, stopWrapper := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stopWrapper()
	wrapper := newWrapperRuntime(values, controlSocket)
	wrapperServer, wrapperDone, err := wrapper.serve(ctx)
	if err != nil {
		return err
	}
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = wrapperServer.Shutdown(shutdownCtx)
	}()
	var pipeWire *exec.Cmd
	var pipeWireDone <-chan error
	var wirePlumber *exec.Cmd
	var wirePlumberDone <-chan error
	oldPipeWireRemote, hadPipeWireRemote := os.LookupEnv("PIPEWIRE_REMOTE")
	if values.CompositorBackend == "pipewire" {
		var err error
		pipeWire, pipeWireDone, err = startSessionPipeWire(runtimeDir, values.SessionID)
		if err != nil {
			return err
		}
		if err := os.Setenv("PIPEWIRE_REMOTE", sessionPipeWireRemote(values.SessionID)); err != nil {
			stopProcess(pipeWire, pipeWireDone)
			return fmt.Errorf("set session PipeWire remote: %w", err)
		}
		wirePlumber, wirePlumberDone, err = startSessionWirePlumber(values.SessionID)
		if err != nil {
			stopProcess(pipeWire, pipeWireDone)
			return err
		}
		defer func() {
			if hadPipeWireRemote {
				_ = os.Setenv("PIPEWIRE_REMOTE", oldPipeWireRemote)
			} else {
				_ = os.Unsetenv("PIPEWIRE_REMOTE")
			}
		}()
	}
	compositorLog := filepath.Join(values.CacheDir, "weston.log")
	compositorConfig := filepath.Join(values.CacheDir, "weston.ini")
	compositorConfigBody := "[shell]\npanel-position=none\nbackground-color=0x000000\nlocking=false\nanimation=none\nstartup-animation=none\n"
	apertureShellPath := ""
	switch compositorShell {
	case "lua-shell", "lua-shell.so":
		luaShellScript := filepath.Join(values.CacheDir, "aperture-shell.lua")
		if err := os.WriteFile(luaShellScript, []byte(compositorLuaShellScript), 0o600); err != nil {
			return fmt.Errorf("write compositor lua shell: %w", err)
		}
		compositorConfigBody = "[shell]\nlua-script=" + luaShellScript + "\n"
		compositorShell = "lua-shell.so"
	case "aperture", "aperture-weston-shell.so":
		var err error
		apertureShellPath, err = apertureWestonShellPath()
		if err != nil {
			return err
		}
		compositorShell = apertureShellPath
	}
	if err := os.WriteFile(compositorConfig, []byte(compositorConfigBody), 0o600); err != nil {
		return fmt.Errorf("write compositor config: %w", err)
	}
	compositorWidth := values.CompositorWidth
	compositorHeight := values.CompositorHeight
	if compositorShell == apertureShellPath {
		compositorWidth = max(compositorWidth, 1920)
		compositorHeight = max(compositorHeight, 1080)
	}
	compositorArgs := []string{
		"--backend=" + values.CompositorBackend,
		"--renderer=" + values.CompositorRenderer,
		"--shell=" + compositorShell,
		"--socket=" + socketName,
		fmt.Sprintf("--width=%d", compositorWidth),
		fmt.Sprintf("--height=%d", compositorHeight),
		"--idle-time=0",
		"--log=" + compositorLog,
		"--config=" + compositorConfig,
	}
	compositor := exec.Command(values.CompositorExecutable, compositorArgs...)
	compositor.Env = compositorProcessEnv(values.GPUMode)
	compositor.Env = append(
		compositor.Env,
		"APERTURE_CONTROL_SOCKET="+controlSocket,
		"APERTURE_VIEWPORT_WIDTH="+strconv.Itoa(values.CompositorWidth),
		"APERTURE_VIEWPORT_HEIGHT="+strconv.Itoa(values.CompositorHeight),
	)
	compositor.Stdout = os.Stdout
	compositor.Stderr = os.Stderr
	if err := compositor.Start(); err != nil {
		stopProcess(wirePlumber, wirePlumberDone)
		stopProcess(pipeWire, pipeWireDone)
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
		stopProcess(wirePlumber, wirePlumberDone)
		stopProcess(pipeWire, pipeWireDone)
		return err
	}

	oldWayland, hadWayland := os.LookupEnv("WAYLAND_DISPLAY")
	if err := os.Setenv("WAYLAND_DISPLAY", socketName); err != nil {
		stopProcess(compositor, compositorDone)
		stopProcess(wirePlumber, wirePlumberDone)
		stopProcess(pipeWire, pipeWireDone)
		return fmt.Errorf("set nested WAYLAND_DISPLAY: %w", err)
	}
	defer func() {
		if hadWayland {
			_ = os.Setenv("WAYLAND_DISPLAY", oldWayland)
		} else {
			_ = os.Unsetenv("WAYLAND_DISPLAY")
		}
	}()

	hardwareAcceleration := values.GPUMode == gpuModeHardware
	extraArgs := append([]string(nil), values.BrowserExtraArgs...)
	extraArgs = append(extraArgs,
		"--ozone-platform=wayland",
		"--class="+compositorBrowserAppID,
		"--kiosk",
		fmt.Sprintf("--window-size=%d,%d", values.CompositorWidth, values.CompositorHeight),
		"about:blank",
	)
	if hardwareAcceleration {
		extraArgs = append(extraArgs, "--ignore-gpu-blocklist", "--enable-gpu-rasterization")
	}
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
		HardwareAcceleration:     hardwareAcceleration,
		RenderNode:               values.RenderNode,
		NestedWaylandSocket:      socketName,
	})
	if err != nil {
		stopProcess(compositor, compositorDone)
		stopProcess(wirePlumber, wirePlumberDone)
		stopProcess(pipeWire, pipeWireDone)
		return err
	}
	if err := browserCmd.Start(); err != nil {
		stopProcess(compositor, compositorDone)
		stopProcess(wirePlumber, wirePlumberDone)
		stopProcess(pipeWire, pipeWireDone)
		return fmt.Errorf("start browser: %w", err)
	}
	browserDone := make(chan error, 1)
	go func() {
		browserDone <- browserCmd.Wait()
	}()

	var mediaProducer *producer
	mediaProducerTargetName := values.MediaProducerTarget
	if values.MediaProducerEnabled {
		if values.CompositorBackend == "pipewire" {
			target, err := waitForPipeWireNodeTarget(
				mediaProducerTargetName,
				compositor.Process.Pid,
				compositorDone,
			)
			if err != nil {
				stopProcess(browserCmd, browserDone)
				stopProcess(compositor, compositorDone)
				stopProcess(wirePlumber, wirePlumberDone)
				stopProcess(pipeWire, pipeWireDone)
				return err
			}
			values.MediaProducerTarget = target
			wrapper.setCaptureTarget(target, compositor.Process.Pid)
			fmt.Fprintf(
				os.Stderr,
				"browser-session-wrapper: resolved PipeWire target %s for compositor pid %d\n",
				target,
				compositor.Process.Pid,
			)
		} else {
			wrapper.setCaptureTarget(values.MediaProducerTarget, compositor.Process.Pid)
		}

		var err error
		mediaProducer, err = newWebRTCProducer(values, controlSocket, mediaProducerTargetName, compositor.Process.Pid)
		if err != nil {
			stopProcess(browserCmd, browserDone)
			stopProcess(compositor, compositorDone)
			stopProcess(wirePlumber, wirePlumberDone)
			stopProcess(pipeWire, pipeWireDone)
			return err
		}
		wrapper.setMediaProducer(mediaProducer)
	}

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(signals)

	for {
		select {
		case err := <-browserDone:
			stopMediaProducer(mediaProducer)
			stopProcess(compositor, compositorDone)
			stopProcess(wirePlumber, wirePlumberDone)
			stopProcess(pipeWire, pipeWireDone)
			return err
		case err := <-compositorDone:
			stopMediaProducer(mediaProducer)
			stopProcess(browserCmd, browserDone)
			stopProcess(wirePlumber, wirePlumberDone)
			stopProcess(pipeWire, pipeWireDone)
			if err != nil {
				return fmt.Errorf("compositor exited before browser: %w", err)
			}
			return fmt.Errorf("compositor exited before browser")
		case err := <-wirePlumberDone:
			stopMediaProducer(mediaProducer)
			stopProcess(browserCmd, browserDone)
			stopProcess(compositor, compositorDone)
			stopProcess(pipeWire, pipeWireDone)
			if err != nil {
				return fmt.Errorf("session WirePlumber exited before browser: %w", err)
			}
			return fmt.Errorf("session WirePlumber exited before browser")
		case err := <-pipeWireDone:
			stopMediaProducer(mediaProducer)
			stopProcess(browserCmd, browserDone)
			stopProcess(compositor, compositorDone)
			stopProcess(wirePlumber, wirePlumberDone)
			if err != nil {
				return fmt.Errorf("session PipeWire exited before browser: %w", err)
			}
			return fmt.Errorf("session PipeWire exited before browser")
		case err := <-wrapperDone:
			stopMediaProducer(mediaProducer)
			stopProcess(browserCmd, browserDone)
			stopProcess(compositor, compositorDone)
			stopProcess(wirePlumber, wirePlumberDone)
			stopProcess(pipeWire, pipeWireDone)
			if err != nil {
				return fmt.Errorf("wrapper api exited: %w", err)
			}
			return fmt.Errorf("wrapper api exited")
		case <-signals:
			stopMediaProducer(mediaProducer)
			stopProcess(browserCmd, browserDone)
			stopProcess(compositor, compositorDone)
			stopProcess(wirePlumber, wirePlumberDone)
			stopProcess(pipeWire, pipeWireDone)
			return nil
		}
	}
}

func sessionPipeWireRemote(sessionID string) string {
	return "aperture-pipewire-" + sessionID
}

func startSessionPipeWire(runtimeDir string, sessionID string) (*exec.Cmd, <-chan error, error) {
	pipewire, err := exec.LookPath("pipewire")
	if err != nil {
		return nil, nil, fmt.Errorf("locate pipewire: %w", err)
	}
	remote := sessionPipeWireRemote(sessionID)
	socketPath := filepath.Join(runtimeDir, remote)
	if err := os.Remove(socketPath); err != nil && !os.IsNotExist(err) {
		return nil, nil, fmt.Errorf("remove stale PipeWire socket: %w", err)
	}
	cmd := exec.Command(pipewire)
	cmd.Env = append(filteredEnv("PIPEWIRE_REMOTE", "PIPEWIRE_CORE"), "PIPEWIRE_CORE="+remote)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return nil, nil, fmt.Errorf("start session PipeWire: %w", err)
	}
	done := make(chan error, 1)
	go func() {
		done <- cmd.Wait()
	}()
	if err := waitForProcessSocket(socketPath, "session PipeWire", done); err != nil {
		if cmd.ProcessState == nil {
			stopProcess(cmd, done)
		}
		return nil, nil, err
	}
	return cmd, done, nil
}

func startSessionWirePlumber(sessionID string) (*exec.Cmd, <-chan error, error) {
	wireplumber, err := exec.LookPath("wireplumber")
	if err != nil {
		return nil, nil, fmt.Errorf("locate wireplumber: %w", err)
	}
	remote := sessionPipeWireRemote(sessionID)
	cmd := exec.Command(wireplumber)
	cmd.Env = append(filteredEnv("PIPEWIRE_REMOTE", "PIPEWIRE_CORE"), "PIPEWIRE_REMOTE="+remote)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return nil, nil, fmt.Errorf("start session WirePlumber: %w", err)
	}
	done := make(chan error, 1)
	go func() {
		done <- cmd.Wait()
	}()
	if err := waitForPipeWireClient(cmd.Process.Pid, done); err != nil {
		if cmd.ProcessState == nil {
			stopProcess(cmd, done)
		}
		return nil, nil, err
	}
	return cmd, done, nil
}

func filteredEnv(excludedKeys ...string) []string {
	env := make([]string, 0, len(os.Environ()))
	for _, entry := range os.Environ() {
		excluded := false
		for _, key := range excludedKeys {
			if strings.HasPrefix(entry, key+"=") {
				excluded = true
				break
			}
		}
		if !excluded {
			env = append(env, entry)
		}
	}
	return env
}

func waitForPipeWireClient(pid int, done <-chan error) error {
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()

	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()

	var lastErr error
	for {
		select {
		case err := <-done:
			if err != nil {
				return fmt.Errorf("WirePlumber exited before PipeWire client was ready: %w", err)
			}
			return fmt.Errorf("WirePlumber exited before PipeWire client was ready")
		case <-timer.C:
			if lastErr != nil {
				return fmt.Errorf("timed out waiting for WirePlumber PipeWire client: %w", lastErr)
			}
			return fmt.Errorf("timed out waiting for WirePlumber PipeWire client")
		case <-ticker.C:
			if pipeWireClientReady(pid) {
				return nil
			}
		}
	}
}

func pipeWireClientReady(pid int) bool {
	pwDump, err := exec.LookPath("pw-dump")
	if err != nil {
		return false
	}
	body, err := exec.Command(pwDump).Output()
	if err != nil {
		return false
	}
	var dump []pipeWireDumpObject
	if err := json.Unmarshal(body, &dump); err != nil {
		return false
	}
	for _, object := range dump {
		if object.Type != "PipeWire:Interface:Client" {
			continue
		}
		props := object.properties()
		processID, ok := intPipeWireProperty(props, "application.process.id")
		if !ok {
			processID, ok = intPipeWireProperty(props, "pipewire.sec.pid")
		}
		if ok && processID == pid {
			return true
		}
	}
	return false
}

func waitForPipeWireNodeTarget(
	targetName string,
	compositorPID int,
	compositorDone <-chan error,
) (string, error) {
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()

	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()

	var lastErr error
	for {
		select {
		case err := <-compositorDone:
			if err != nil {
				return "", fmt.Errorf("compositor exited before PipeWire node was ready: %w", err)
			}
			return "", fmt.Errorf("compositor exited before PipeWire node was ready")
		case <-timer.C:
			if lastErr != nil {
				return "", fmt.Errorf("timed out waiting for PipeWire node %q owned by pid %d: %w", targetName, compositorPID, lastErr)
			}
			return "", fmt.Errorf("timed out waiting for PipeWire node %q owned by pid %d", targetName, compositorPID)
		case <-ticker.C:
			target, err := ResolvePipeWireNodeTarget(targetName, compositorPID)
			if err == nil {
				return target, nil
			}
			if !errors.Is(err, errPipeWireNodeNotFound) {
				return "", err
			}
			lastErr = err
		}
	}
}

func ResolvePipeWireNodeTarget(targetName string, compositorPID int) (string, error) {
	targetName = strings.TrimSpace(targetName)
	if targetName == "" {
		return "", fmt.Errorf("pipewire target name is required")
	}

	pwDump, err := exec.LookPath("pw-dump")
	if err != nil {
		return "", fmt.Errorf("locate pw-dump: %w", err)
	}

	cmd := exec.Command(pwDump)
	body, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("run pw-dump: %w: %s", err, strings.TrimSpace(string(body)))
	}

	var dump []pipeWireDumpObject
	if err := json.Unmarshal(body, &dump); err != nil {
		return "", fmt.Errorf("decode pw-dump: %w", err)
	}

	clientPIDs := make(map[int]int)
	for _, object := range dump {
		if object.Type != "PipeWire:Interface:Client" {
			continue
		}
		props := object.properties()
		pid, ok := intPipeWireProperty(props, "application.process.id")
		if !ok {
			pid, ok = intPipeWireProperty(props, "pipewire.sec.pid")
		}
		if !ok {
			continue
		}
		clientPIDs[object.ID] = pid
	}

	var named []pipeWireDumpObject
	for _, object := range dump {
		if object.Type != "PipeWire:Interface:Node" {
			continue
		}
		props := object.properties()
		if stringPipeWireProperty(props, "node.name") != targetName {
			continue
		}
		if mediaClass := stringPipeWireProperty(props, "media.class"); mediaClass != "" && mediaClass != "Stream/Output/Video" {
			continue
		}
		named = append(named, object)

		clientID, ok := intPipeWireProperty(props, "client.id")
		if !ok || clientPIDs[clientID] != compositorPID {
			continue
		}
		serial := stringPipeWireProperty(props, "object.serial")
		if serial == "" {
			return "", fmt.Errorf("PipeWire node %q owned by pid %d has no object.serial", targetName, compositorPID)
		}
		return serial, nil
	}

	if len(named) == 1 {
		serial := stringPipeWireProperty(named[0].properties(), "object.serial")
		if serial == "" {
			return "", fmt.Errorf("PipeWire node %q has no object.serial", targetName)
		}
		return serial, nil
	}
	if len(named) > 1 {
		return "", fmt.Errorf("%w: %d PipeWire nodes named %q, none owned by pid %d", errPipeWireNodeNotFound, len(named), targetName, compositorPID)
	}
	return "", fmt.Errorf("%w: %q owned by pid %d", errPipeWireNodeNotFound, targetName, compositorPID)
}

type pipeWireDumpObject struct {
	ID    int                  `json:"id"`
	Type  string               `json:"type"`
	Info  pipeWireDumpInfo     `json:"info"`
	Props pipeWireDumpProperty `json:"props"`
}

type pipeWireDumpInfo struct {
	Props pipeWireDumpProperty `json:"props"`
}

type pipeWireDumpProperty map[string]any

func (object pipeWireDumpObject) properties() pipeWireDumpProperty {
	if object.Info.Props != nil {
		return object.Info.Props
	}
	return object.Props
}

func intPipeWireProperty(props pipeWireDumpProperty, key string) (int, bool) {
	switch value := props[key].(type) {
	case float64:
		return int(value), true
	case string:
		parsed, err := strconv.Atoi(value)
		return parsed, err == nil
	default:
		return 0, false
	}
}

func stringPipeWireProperty(props pipeWireDumpProperty, key string) string {
	switch value := props[key].(type) {
	case string:
		return value
	case float64:
		return strconv.Itoa(int(value))
	default:
		return ""
	}
}

func compositorProcessEnv(gpuMode string) []string {
	keys := []string{
		"XDG_RUNTIME_DIR",
		"PIPEWIRE_REMOTE",
		"DBUS_SESSION_BUS_ADDRESS",
		"LIBVA_DRIVER_NAME",
		"LIBVA_DRIVERS_PATH",
		"NVIDIA_VISIBLE_DEVICES",
		"LIBGL_DRIVERS_PATH",
		"__EGL_VENDOR_LIBRARY_FILENAMES",
	}
	env := make([]string, 0, len(keys))
	for _, key := range keys {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			env = append(env, key+"="+value)
		}
	}
	if gpuMode == gpuModeSoftware {
		env = append(env, "LIBGL_ALWAYS_SOFTWARE=1")
	}
	return env
}

func waitForWaylandSocket(socketPath string, compositorDone <-chan error) error {
	return waitForProcessSocket(socketPath, "compositor Wayland", compositorDone)
}

func waitForProcessSocket(socketPath string, label string, done <-chan error) error {
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()

	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case err := <-done:
			if err != nil {
				return fmt.Errorf("%s process exited before socket was ready: %w", label, err)
			}
			return fmt.Errorf("%s process exited before socket was ready", label)
		case <-timer.C:
			return fmt.Errorf("timed out waiting for %s socket %s", label, socketPath)
		case <-ticker.C:
			if _, err := os.Stat(socketPath); err == nil {
				return nil
			} else if !os.IsNotExist(err) {
				return fmt.Errorf("stat compositor Wayland socket: %w", err)
			}
		}
	}
}

func stopMediaProducer(mediaProducer *producer) {
	if mediaProducer != nil {
		mediaProducer.stopPeer()
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
	wrapperPortRaw := strings.TrimSpace(os.Getenv("WRAPPER_PORT"))
	if wrapperPortRaw == "" {
		return RuntimeEnvValues{}, fmt.Errorf("missing required env WRAPPER_PORT")
	}

	values := RuntimeEnvValues{
		SessionID:         *required["APERTURE_SESSION_ID"],
		ExternalBaseURL:   strings.TrimSpace(os.Getenv("EXTERNAL_BASE_URL")),
		CDPToken:          strings.TrimSpace(os.Getenv("CDP_TOKEN")),
		CDPTokenPath:      strings.TrimSpace(os.Getenv("CDP_TOKEN_PATH")),
		MergedUserDataDir: *required["MERGED_USER_DATA_DIR"],
		DownloadsDir:      *required["DOWNLOADS_DIR"],
		CacheDir:          *required["CACHE_DIR"],
		ArtifactsDir:      *required["ARTIFACTS_DIR"],
		BrowserExecutable: *required["BROWSER_EXECUTABLE"],
	}

	if _, err := fmt.Sscanf(portRaw, "%d", &values.CDPPort); err != nil {
		return RuntimeEnvValues{}, fmt.Errorf("parse cdp port: %w", err)
	}
	if _, err := fmt.Sscanf(wrapperPortRaw, "%d", &values.WrapperPort); err != nil {
		return RuntimeEnvValues{}, fmt.Errorf("parse wrapper port: %w", err)
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
	values.GPUMode = strings.TrimSpace(os.Getenv("GPU_MODE"))
	values.CompositorEnabled = strings.TrimSpace(os.Getenv("WEBRTC_COMPOSITOR_ENABLED")) == "1"
	values.CompositorExecutable = strings.TrimSpace(os.Getenv("WEBRTC_COMPOSITOR_EXECUTABLE"))
	values.CompositorBackend = strings.TrimSpace(os.Getenv("WEBRTC_COMPOSITOR_BACKEND"))
	values.CompositorRenderer = strings.TrimSpace(os.Getenv("WEBRTC_COMPOSITOR_RENDERER"))
	values.CompositorShell = strings.TrimSpace(os.Getenv("WEBRTC_COMPOSITOR_SHELL"))
	values.MediaProducerEnabled = strings.TrimSpace(os.Getenv("WEBRTC_MEDIA_PRODUCER_ENABLED")) == "1"
	values.MediaProducerGSTExecutable = strings.TrimSpace(os.Getenv("WEBRTC_MEDIA_PRODUCER_GST_EXECUTABLE"))
	values.MediaProducerPluginPath = strings.TrimSpace(os.Getenv("WEBRTC_MEDIA_PRODUCER_PLUGIN_PATH"))
	values.MediaProducerTarget = strings.TrimSpace(os.Getenv("WEBRTC_MEDIA_PRODUCER_TARGET"))
	values.MediaProducerICEServers = strings.TrimSpace(os.Getenv("WEBRTC_MEDIA_PRODUCER_ICE_SERVERS"))
	values.MediaProducerCodec = strings.TrimSpace(os.Getenv("WEBRTC_MEDIA_PRODUCER_CODEC"))
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
	if fps := strings.TrimSpace(os.Getenv("WEBRTC_MEDIA_PRODUCER_FPS")); fps != "" {
		parsed, err := strconv.Atoi(fps)
		if err != nil {
			return RuntimeEnvValues{}, fmt.Errorf("parse media producer fps: %w", err)
		}
		values.MediaProducerFPS = parsed
	}
	if bitrate := strings.TrimSpace(os.Getenv("WEBRTC_MEDIA_PRODUCER_BITRATE_KBPS")); bitrate != "" {
		parsed, err := strconv.Atoi(bitrate)
		if err != nil {
			return RuntimeEnvValues{}, fmt.Errorf("parse media producer bitrate: %w", err)
		}
		values.MediaProducerBitrateKbps = parsed
	}
	if keyframe := strings.TrimSpace(os.Getenv("WEBRTC_MEDIA_PRODUCER_KEYFRAME_INTERVAL")); keyframe != "" {
		parsed, err := strconv.Atoi(keyframe)
		if err != nil {
			return RuntimeEnvValues{}, fmt.Errorf("parse media producer keyframe interval: %w", err)
		}
		values.MediaProducerKeyframe = parsed
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

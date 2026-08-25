package devrunner

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	frontendContainerPort = 3000
	backendContainerPort  = 8080
	defaultUDPPortRange   = "50000-50010"
	defaultRenderNode     = "/dev/dri/renderD128"
)

var imageDigestPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

type options struct {
	port          int
	containerName string
	bindAddress   string
	udpPortMin    int
	udpPortMax    int
	envFile       string
	configFile    string
	renderNode    string
	gpu           bool
	projectDir    string
	stateVolume   string
	imageArchive  string
	imageRef      string
	traefikConfig string
}

type commandRunner struct {
	stdin  io.Reader
	stdout io.Writer
	stderr io.Writer
}

// Run starts the development container described by the Nix wrapper environment.
func Run(args []string, stdin io.Reader, stdout, stderr io.Writer) error {
	opts, help, err := parseOptions(args, stdout, stderr)
	if err != nil || help {
		return err
	}

	runner := commandRunner{stdin: stdin, stdout: stdout, stderr: stderr}
	return runner.run(opts)
}

func parseOptions(args []string, stdout, stderr io.Writer) (options, bool, error) {
	workingDir, err := os.Getwd()
	if err != nil {
		return options{}, false, fmt.Errorf("get working directory: %w", err)
	}

	checksum := posixChecksum([]byte(workingDir + "\n"))
	bindAddress := fmt.Sprintf(
		"127.%d.%d.%d",
		64+checksum%64,
		(checksum>>6)%256,
		1+(checksum>>14)%254,
	)
	worktreeHash := sha256.Sum256([]byte(workingDir + "\n"))
	stateVolume := "aperture-dev-" + hex.EncodeToString(worktreeHash[:])[:16]

	var (
		portText     = "8080"
		udpRangeText = defaultUDPPortRange
		renderNode   = defaultRenderNode
	)
	opts := options{
		containerName: filepath.Base(workingDir),
		bindAddress:   bindAddress,
		stateVolume:   stateVolume,
	}

	flags := flag.NewFlagSet("aperture-dev", flag.ContinueOnError)
	flags.SetOutput(stderr)
	flags.Usage = func() {
		writeln(stdout, `Usage: nix run .#dev -- [options]

Run the Nix-built Aperture backend with rootless Podman and the live Vite frontend.

Options:
  --port PORT              Public HTTP port (default: 8080)
  --container-name NAME    Podman container name (default: worktree directory)
  --bind-address ADDRESS   Loopback address (default: derived from worktree)
  --udp-port-range RANGE   WebRTC UDP range (default: 50000-50010)
  --env-file PATH          Pass an environment file to the container
  --config PATH            Mount an Aperture TOML config
  --render-node PATH       DRM render node for .#dev-gpu
  -h, --help               Show this help

Vite runs in the foreground. State persists in a worktree-specific Podman
volume, and the initial system-admin token persists under .data/.`)
	}
	flags.StringVar(&portText, "port", portText, "")
	flags.StringVar(&opts.containerName, "container-name", opts.containerName, "")
	flags.StringVar(&opts.bindAddress, "bind-address", opts.bindAddress, "")
	flags.StringVar(&udpRangeText, "udp-port-range", udpRangeText, "")
	flags.StringVar(&opts.envFile, "env-file", "", "")
	flags.StringVar(&opts.configFile, "config", "", "")
	flags.StringVar(&renderNode, "render-node", renderNode, "")

	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return options{}, true, nil
		}
		return options{}, false, err
	}
	if flags.NArg() != 0 {
		return options{}, false, fmt.Errorf("unexpected argument: %s", flags.Arg(0))
	}

	opts.port, err = parsePort(portText, "port")
	if err != nil {
		return options{}, false, err
	}
	if !validContainerName(opts.containerName) {
		return options{}, false, errors.New("container name must start with an alphanumeric character and contain only alphanumerics, ., _, or -")
	}
	if err := validateLoopbackAddress(opts.bindAddress); err != nil {
		return options{}, false, err
	}
	opts.udpPortMin, opts.udpPortMax, err = parseUDPPortRange(udpRangeText)
	if err != nil {
		return options{}, false, err
	}

	gpuValue := os.Getenv("APERTURE_DEV_GPU")
	if gpuValue == "" {
		gpuValue = "0"
	}
	switch gpuValue {
	case "0":
	case "1":
		opts.gpu = true
	default:
		return options{}, false, errors.New("APERTURE_DEV_GPU must be 0 or 1")
	}

	renderNodeSet := false
	flags.Visit(func(visited *flag.Flag) {
		if visited.Name == "render-node" {
			renderNodeSet = true
		}
	})
	if !opts.gpu && renderNodeSet {
		return options{}, false, errors.New("--render-node requires nix run .#dev-gpu")
	}
	if opts.gpu {
		opts.renderNode, err = characterDevicePath(renderNode)
		if err != nil {
			return options{}, false, err
		}
	}

	if opts.envFile != "" {
		opts.envFile, err = regularFilePath(opts.envFile, "environment file")
		if err != nil {
			return options{}, false, err
		}
	}
	if opts.configFile != "" {
		opts.configFile, err = regularFilePath(opts.configFile, "config file")
		if err != nil {
			return options{}, false, err
		}
	}

	opts.projectDir, err = filepath.EvalSymlinks(workingDir)
	if err != nil {
		return options{}, false, fmt.Errorf("resolve project directory: %w", err)
	}
	opts.imageArchive, err = regularFilePath(os.Getenv("APERTURE_DEV_IMAGE_ARCHIVE"), "Nix image archive")
	if err != nil {
		return options{}, false, err
	}
	opts.imageRef = os.Getenv("APERTURE_DEV_IMAGE_REF")
	if opts.imageRef == "" {
		return options{}, false, errors.New("nix image reference is unavailable")
	}
	opts.traefikConfig, err = regularFilePath(os.Getenv("APERTURE_DEV_TRAEFIK_TEMPLATE"), "Traefik config template")
	if err != nil {
		return options{}, false, err
	}
	if _, err := os.Stat(filepath.Join(opts.projectDir, "web", "package.json")); err != nil {
		return options{}, false, errors.New("run this command from the Aperture repository root")
	}

	return opts, false, nil
}

func (runner commandRunner) run(opts options) error {
	dataDir := filepath.Join(opts.projectDir, ".data")
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return fmt.Errorf("create data directory: %w", err)
	}
	if err := os.Chmod(dataDir, 0o700); err != nil {
		return fmt.Errorf("set data directory permissions: %w", err)
	}

	tempDir, err := os.MkdirTemp("", "aperture-dev.")
	if err != nil {
		return fmt.Errorf("create temporary directory: %w", err)
	}
	defer func() {
		_ = os.RemoveAll(tempDir)
	}()

	traefikPath := filepath.Join(tempDir, "traefik.yaml")
	if err := renderTraefikConfig(opts.traefikConfig, traefikPath); err != nil {
		return err
	}
	if err := runner.loadImage(opts, dataDir); err != nil {
		return err
	}
	if err := runner.prepareState(opts, dataDir); err != nil {
		return err
	}

	adminTokenPath := filepath.Join(dataDir, "admin-token")
	writef(runner.stdout, "Container: %s\n", opts.containerName)
	writef(runner.stdout, "State volume: %s\n", opts.stateVolume)
	writef(runner.stdout, "Loopback address: %s\n", opts.bindAddress)
	writef(runner.stdout, "WebRTC UDP ports: %d-%d\n", opts.udpPortMin, opts.udpPortMax)
	writef(runner.stdout, "System-admin token: %s\n", adminTokenPath)

	url := fmt.Sprintf("http://%s:%d", opts.bindAddress, opts.port)
	writef(runner.stdout, "Starting Aperture at %s through containerized Vite...\n", url)

	readinessContext, cancelReadiness := context.WithCancel(context.Background())
	defer cancelReadiness()
	go runner.waitUntilReady(readinessContext, url)

	return runner.runContainer(opts, traefikPath)
}

func (runner commandRunner) loadImage(opts options, dataDir string) error {
	cachePath := filepath.Join(dataDir, "image-cache")
	imageDigest := ""
	if cache, err := os.ReadFile(cachePath); err == nil {
		lines := strings.Split(string(cache), "\n")
		if len(lines) >= 2 && lines[0] == opts.imageArchive && imageDigestPattern.MatchString(lines[1]) {
			imageDigest = lines[1]
		}
	}

	if imageDigest == "" {
		writef(runner.stdout, "Inspecting %s...\n", opts.imageRef)
		output, err := runner.output("skopeo", "inspect", "--format", "{{.Digest}}", "docker-archive:"+opts.imageArchive)
		if err != nil {
			return fmt.Errorf("inspect development image: %w", err)
		}
		imageDigest = strings.TrimSpace(output)
		if !imageDigestPattern.MatchString(imageDigest) {
			return errors.New("could not determine the development image digest")
		}
	}

	loadedDigest, _ := runner.outputQuiet("podman", "image", "inspect", "--format", "{{.Digest}}", opts.imageRef)
	if strings.TrimSpace(loadedDigest) == imageDigest {
		writef(runner.stdout, "Using cached %s\n", opts.imageRef)
	} else {
		writef(runner.stdout, "Loading %s...\n", opts.imageRef)
		if err := runner.runCommand(
			"skopeo",
			"--insecure-policy", "copy", "--quiet",
			"docker-archive:"+opts.imageArchive,
			"containers-storage:"+opts.imageRef,
		); err != nil {
			return fmt.Errorf("load development image: %w", err)
		}
	}

	if err := os.WriteFile(cachePath, []byte(opts.imageArchive+"\n"+imageDigest+"\n"), 0o600); err != nil {
		return fmt.Errorf("write image cache: %w", err)
	}
	return os.Chmod(cachePath, 0o600)
}

func (runner commandRunner) prepareState(opts options, dataDir string) error {
	volumeCreated := false
	if !runner.succeeds("podman", "volume", "exists", opts.stateVolume) {
		if err := runner.runCommandDiscardOutput(
			"podman", "volume", "create",
			"--label", "io.aperture.dev.worktree="+opts.projectDir,
			opts.stateVolume,
		); err != nil {
			return fmt.Errorf("create state volume: %w", err)
		}
		volumeCreated = true
	}

	stateVolumePath := filepath.Join(dataDir, "state-volume")
	adminTokenPath := filepath.Join(dataDir, "admin-token")
	if !volumeCreated && fileContains(stateVolumePath, opts.stateVolume) && nonEmptyFile(adminTokenPath) {
		return nil
	}

	if runner.succeeds("podman", "container", "exists", opts.containerName) {
		writef(runner.stdout, "Stopping %s before initializing its state volume...\n", opts.containerName)
		if err := runner.runCommandDiscardOutput("podman", "stop", "--ignore", "--time", "35", opts.containerName); err != nil {
			return fmt.Errorf("stop development container: %w", err)
		}
	}

	legacyStorePath := filepath.Join(dataDir, "store")
	if volumeCreated && directoryHasEntries(legacyStorePath) {
		writef(runner.stdout, "Migrating development state from %s to %s...\n", legacyStorePath, opts.stateVolume)
		err := runner.runCommand(
			"podman", "run", "--rm",
			"--userns", "host",
			"--user", "0:0",
			"--volume", legacyStorePath+":/source:ro",
			"--volume", opts.stateVolume+":/target",
			"--entrypoint", "/bin/cp",
			opts.imageRef,
			"-a", "/source/.", "/target/",
		)
		if err != nil {
			_ = runner.runCommandQuiet("podman", "volume", "rm", opts.stateVolume)
			return errors.New("could not migrate the development state")
		}
	}

	writeln(runner.stdout, "Provisioning the development database...")
	provisionArgs := []string{
		"run", "--rm",
		"--userns", "host",
		"--user", "0:0",
		"--volume", dataDir + ":/provision",
		"--volume", opts.stateVolume + ":/var/lib/aperture",
		"--entrypoint", "aperture",
	}
	if opts.envFile != "" {
		provisionArgs = append(provisionArgs, "--env-file", opts.envFile)
	}
	provisionArgs = append(provisionArgs, "--env", fmt.Sprintf("APERTURE_EXTERNAL_BASE_URL=http://%s:%d", opts.bindAddress, opts.port))
	if opts.configFile != "" {
		provisionArgs = append(provisionArgs, "--volume", opts.configFile+":/etc/aperture/aperture.toml:ro")
	}
	provisionArgs = append(
		provisionArgs,
		opts.imageRef,
		"--config", "/etc/aperture/aperture.toml",
		"admin", "provision",
		"--admin-token-file", "/provision/admin-token",
		"--default-tenant", "default",
	)
	if err := runner.runCommand("podman", provisionArgs...); err != nil {
		return fmt.Errorf("provision development database: %w", err)
	}
	if !nonEmptyFile(adminTokenPath) {
		return fmt.Errorf("provisioning did not create %s", adminTokenPath)
	}

	if err := runner.runCommand(
		"podman", "run", "--rm",
		"--userns", "host",
		"--user", "0:0",
		"--volume", opts.stateVolume+":/var/lib/aperture",
		"--entrypoint", "/bin/chown",
		opts.imageRef,
		"-R", "1000:1000", "/var/lib/aperture",
	); err != nil {
		return fmt.Errorf("set development state ownership: %w", err)
	}

	if err := os.WriteFile(stateVolumePath, []byte(opts.stateVolume+"\n"), 0o600); err != nil {
		return fmt.Errorf("write state volume marker: %w", err)
	}
	return os.Chmod(stateVolumePath, 0o600)
}

func (runner commandRunner) runContainer(opts options, traefikPath string) error {
	args := []string{
		"run", "--rm",
		"--name", opts.containerName,
		"--replace",
		"--userns", "host",
		"--user", "0:0",
		"--network", "pasta",
		"--publish", fmt.Sprintf("%s:%d:%d/tcp", opts.bindAddress, opts.port, frontendContainerPort),
		"--publish", fmt.Sprintf(
			"%s:%d-%d:%d-%d/udp",
			opts.bindAddress,
			opts.udpPortMin,
			opts.udpPortMax,
			opts.udpPortMin,
			opts.udpPortMax,
		),
		"--cap-add", "SYS_ADMIN",
		"--shm-size", "2g",
		"--stop-timeout", "35",
		"--tmpfs", "/run/aperture:rw,nosuid,nodev,size=512m",
		"--volume", opts.projectDir + ":/workspace",
		"--volume", opts.stateVolume + ":/var/lib/aperture",
		"--volume", traefikPath + ":/etc/aperture/traefik.yaml:ro",
		"--health-cmd", fmt.Sprintf("curl -fsS http://127.0.0.1:%d/api/health", frontendContainerPort),
	}
	if opts.envFile != "" {
		args = append(args, "--env-file", opts.envFile)
	}
	args = append(
		args,
		"--env", "APERTURE_CONFIG_SOURCE=",
		"--env", fmt.Sprintf("APERTURE_DEV_PROXY_TARGET=http://127.0.0.1:%d", backendContainerPort),
		"--env", fmt.Sprintf("APERTURE_EXTERNAL_BASE_URL=http://%s:%d", opts.bindAddress, opts.port),
		"--env", "APERTURE_WEBRTC_MEDIA_PRODUCER_ADVERTISED_IP="+opts.bindAddress,
		"--env", fmt.Sprintf("APERTURE_WEBRTC_MEDIA_PRODUCER_UDP_PORT_MIN=%d", opts.udpPortMin),
		"--env", fmt.Sprintf("APERTURE_WEBRTC_MEDIA_PRODUCER_UDP_PORT_MAX=%d", opts.udpPortMax),
	)
	if opts.configFile != "" {
		args = append(
			args,
			"--env", "APERTURE_CONFIG_SOURCE=/run/aperture-config.toml",
			"--volume", opts.configFile+":/run/aperture-config.toml:ro",
		)
	}
	if opts.gpu {
		args = append(
			args,
			"--group-add", "keep-groups",
			"--env", "APERTURE_GPU_MODE=hardware",
			"--env", "APERTURE_WEBRTC_COMPOSITOR_RENDERER=gl",
		)
		device, nvidia, err := nvidiaDevice(opts.renderNode)
		if err != nil {
			return err
		}
		if nvidia {
			const nvidiaVendorFile = "/run/opengl-driver/share/glvnd/egl_vendor.d/10_nvidia.json"
			args = append(
				args,
				"--device", "nvidia.com/gpu="+device,
				"--volume", nvidiaVendorFile+":/etc/glvnd/egl_vendor.d/10_nvidia.json:ro",
				"--env", "__EGL_VENDOR_LIBRARY_FILENAMES=/etc/glvnd/egl_vendor.d/10_nvidia.json",
			)
		} else {
			args = append(args, "--device", opts.renderNode+":"+opts.renderNode)
		}
	}
	args = append(args, opts.imageRef)

	cmd := runner.command("podman", args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start development container: %w", err)
	}

	waitResult := make(chan error, 1)
	go func() {
		waitResult <- cmd.Wait()
	}()

	select {
	case err := <-waitResult:
		return err
	case received := <-signals:
		if signalValue, ok := received.(syscall.Signal); ok {
			_ = syscall.Kill(-cmd.Process.Pid, signalValue)
		}
		return <-waitResult
	}
}

func (runner commandRunner) waitUntilReady(ctx context.Context, baseURL string) {
	for {
		if endpointReady(ctx, baseURL+"/", 2*time.Second) &&
			endpointReady(ctx, baseURL+"/@id/virtual:tanstack-start-dev-client-entry", 10*time.Second) &&
			endpointReady(ctx, baseURL+"/api/health", 2*time.Second) {
			writef(runner.stdout, "\nAperture is ready: %s/\n\n", baseURL)
			return
		}

		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Second):
		}
	}
}

func endpointReady(ctx context.Context, url string, timeout time.Duration) bool {
	requestContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestContext, http.MethodGet, url, nil)
	if err != nil {
		return false
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return false
	}
	defer func() {
		_ = response.Body.Close()
	}()
	_, _ = io.Copy(io.Discard, response.Body)
	return response.StatusCode < http.StatusBadRequest
}

func renderTraefikConfig(templatePath, destinationPath string) error {
	template, err := os.ReadFile(templatePath)
	if err != nil {
		return fmt.Errorf("read Traefik config template: %w", err)
	}
	config := strings.ReplaceAll(string(template), "@ENTRYPOINT_ADDRESS@", fmt.Sprintf(":%d", backendContainerPort))
	config = strings.ReplaceAll(config, "@DYNAMIC_CONFIG_DIR@", "/run/aperture/traefik/dynamic")
	if err := os.WriteFile(destinationPath, []byte(config), 0o644); err != nil {
		return fmt.Errorf("write Traefik config: %w", err)
	}
	return os.Chmod(destinationPath, 0o644)
}

func nvidiaDevice(renderNode string) (string, bool, error) {
	renderNodeName := filepath.Base(renderNode)
	vendorPath := filepath.Join("/sys/class/drm", renderNodeName, "device", "vendor")
	vendor, err := os.ReadFile(vendorPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) || errors.Is(err, os.ErrPermission) {
			return "", false, nil
		}
		return "", false, fmt.Errorf("read render node vendor: %w", err)
	}
	if strings.TrimSpace(string(vendor)) != "0x10de" {
		return "", false, nil
	}

	const (
		nvidiaVendorFile = "/run/opengl-driver/share/glvnd/egl_vendor.d/10_nvidia.json"
		nvidiaCDISpec    = "/run/cdi/nvidia-container-toolkit.json"
	)
	if _, err := os.Stat(nvidiaVendorFile); err != nil {
		return "", false, fmt.Errorf("NVIDIA EGL vendor file not found: %s", nvidiaVendorFile)
	}
	specFile, err := os.Open(nvidiaCDISpec)
	if err != nil {
		return "", false, fmt.Errorf("NVIDIA CDI spec not found: %s", nvidiaCDISpec)
	}
	defer func() {
		_ = specFile.Close()
	}()

	var spec struct {
		Devices []struct {
			Name           string `json:"name"`
			ContainerEdits struct {
				DeviceNodes []struct {
					Path string `json:"path"`
				} `json:"deviceNodes"`
			} `json:"containerEdits"`
		} `json:"devices"`
	}
	if err := json.NewDecoder(specFile).Decode(&spec); err != nil {
		return "", false, fmt.Errorf("could not read NVIDIA CDI spec: %s: %w", nvidiaCDISpec, err)
	}
	containerPath := "/dev/dri/" + renderNodeName
	for _, device := range spec.Devices {
		if device.Name == "all" {
			continue
		}
		for _, node := range device.ContainerEdits.DeviceNodes {
			if node.Path == containerPath {
				return device.Name, true, nil
			}
		}
	}
	return "", false, fmt.Errorf("render node not found in NVIDIA CDI spec: %s", containerPath)
}

func parsePort(value, name string) (int, error) {
	port, err := strconv.Atoi(value)
	if err != nil {
		return 0, fmt.Errorf("%s must be an integer", name)
	}
	if port < 1 || port > 65535 {
		return 0, fmt.Errorf("%s must be between 1 and 65535", name)
	}
	return port, nil
}

func parseUDPPortRange(value string) (int, int, error) {
	parts := strings.Split(value, "-")
	if len(parts) != 2 {
		return 0, 0, errors.New("UDP port range must be MIN-MAX")
	}
	minimum, err := parsePort(parts[0], "UDP ports")
	if err != nil {
		return 0, 0, err
	}
	maximum, err := parsePort(parts[1], "UDP ports")
	if err != nil {
		return 0, 0, err
	}
	if minimum > maximum {
		return 0, 0, errors.New("UDP port range minimum exceeds maximum")
	}
	return minimum, maximum, nil
}

func validateLoopbackAddress(address string) error {
	parts := strings.Split(address, ".")
	if len(parts) != 4 {
		return errors.New("bind address must be an IPv4 loopback address")
	}
	for index, part := range parts {
		octet, err := strconv.Atoi(part)
		if err != nil || octet < 0 || octet > 255 {
			return errors.New("bind address contains an invalid octet")
		}
		if index == 0 && octet != 127 {
			return errors.New("bind address must be in 127.0.0.0/8")
		}
	}
	return nil
}

func validContainerName(name string) bool {
	for index, character := range name {
		alphanumeric := character >= 'a' && character <= 'z' ||
			character >= 'A' && character <= 'Z' ||
			character >= '0' && character <= '9'
		if index == 0 && !alphanumeric {
			return false
		}
		if !alphanumeric && character != '.' && character != '_' && character != '-' {
			return false
		}
	}
	return name != ""
}

func characterDevicePath(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("render node is not a character device: %s", path)
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return "", fmt.Errorf("render node is not a character device: %s", path)
	}
	info, err := os.Stat(resolved)
	if err != nil || info.Mode()&os.ModeCharDevice == 0 {
		return "", fmt.Errorf("render node is not a character device: %s", path)
	}
	return resolved, nil
}

func regularFilePath(path, description string) (string, error) {
	if path == "" {
		return "", fmt.Errorf("%s is unavailable", description)
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("%s is unavailable", description)
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return "", fmt.Errorf("%s is unavailable", description)
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.Mode().IsRegular() {
		return "", fmt.Errorf("%s is unavailable", description)
	}
	return resolved, nil
}

func fileContains(path, expected string) bool {
	contents, err := os.ReadFile(path)
	return err == nil && strings.TrimSpace(string(contents)) == expected
}

func nonEmptyFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular() && info.Size() > 0
}

func directoryHasEntries(path string) bool {
	directory, err := os.Open(path)
	if err != nil {
		return false
	}
	defer func() {
		_ = directory.Close()
	}()
	_, err = directory.Readdirnames(1)
	return err == nil
}

func posixChecksum(data []byte) uint32 {
	var checksum uint32
	update := func(value byte) {
		checksum ^= uint32(value) << 24
		for range 8 {
			if checksum&0x80000000 != 0 {
				checksum = checksum<<1 ^ 0x04c11db7
			} else {
				checksum <<= 1
			}
		}
	}
	for _, value := range data {
		update(value)
	}
	for length := len(data); length != 0; length >>= 8 {
		update(byte(length))
	}
	return ^checksum
}

func (runner commandRunner) command(name string, args ...string) *exec.Cmd {
	cmd := exec.Command(name, args...)
	cmd.Stdin = runner.stdin
	cmd.Stdout = runner.stdout
	cmd.Stderr = runner.stderr
	return cmd
}

func (runner commandRunner) runCommand(name string, args ...string) error {
	return runner.command(name, args...).Run()
}

func (runner commandRunner) runCommandDiscardOutput(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Stdin = runner.stdin
	cmd.Stdout = io.Discard
	cmd.Stderr = runner.stderr
	return cmd.Run()
}

func (runner commandRunner) runCommandQuiet(name string, args ...string) error {
	return exec.Command(name, args...).Run()
}

func (runner commandRunner) output(name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	cmd.Stderr = runner.stderr
	output, err := cmd.Output()
	return string(output), err
}

func (runner commandRunner) outputQuiet(name string, args ...string) (string, error) {
	output, err := exec.Command(name, args...).Output()
	return string(output), err
}

func (runner commandRunner) succeeds(name string, args ...string) bool {
	return runner.runCommandQuiet(name, args...) == nil
}

func writef(writer io.Writer, format string, args ...any) {
	_, _ = fmt.Fprintf(writer, format, args...)
}

func writeln(writer io.Writer, args ...any) {
	_, _ = fmt.Fprintln(writer, args...)
}

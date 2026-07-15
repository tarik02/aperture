package browser

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/google/renameio/v2"
)

// RuntimeEnvValues are written for browser-session-wrapper consumption.
type RuntimeEnvValues struct {
	SessionID                  string
	ExternalBaseURL            string
	SessionToken               string
	SessionTokenPath           string
	MergedUserDataDir          string
	DownloadsDir               string
	RecordingsDir              string
	CacheDir                   string
	ArtifactsDir               string
	CDPPort                    int
	WrapperPort                int
	BrowserExecutable          string
	BrowserDefaultArgs         []string
	BrowserExtraArgs           []string
	CaptureProofExtensionDir   string
	GPUMode                    string
	RenderNode                 string
	CompositorEnabled          bool
	CompositorExecutable       string
	CompositorBackend          string
	CompositorRenderer         string
	CompositorShell            string
	CompositorWidth            int
	CompositorHeight           int
	MediaProducerEnabled       bool
	MediaProducerGSTExecutable string
	MediaProducerPluginPath    string
	MediaProducerTarget        string
	MediaProducerICEServers    string
	MediaProducerCodec         string
	MediaProducerFPS           int
	MediaProducerBitrateKbps   int
	MediaProducerKeyframe      int
}

// RenderRuntimeEnv renders a systemd EnvironmentFile body.
func RenderRuntimeEnv(values RuntimeEnvValues) ([]byte, error) {
	if strings.TrimSpace(values.SessionID) == "" {
		return nil, fmt.Errorf("session id is required")
	}
	if strings.TrimSpace(values.MergedUserDataDir) == "" {
		return nil, fmt.Errorf("merged user data dir is required")
	}
	if strings.TrimSpace(values.DownloadsDir) == "" {
		return nil, fmt.Errorf("downloads dir is required")
	}
	if strings.TrimSpace(values.RecordingsDir) == "" {
		return nil, fmt.Errorf("recordings dir is required")
	}
	if strings.TrimSpace(values.CacheDir) == "" {
		return nil, fmt.Errorf("cache dir is required")
	}
	if strings.TrimSpace(values.ArtifactsDir) == "" {
		return nil, fmt.Errorf("artifacts dir is required")
	}
	if values.CDPPort <= 0 || values.CDPPort > 65535 {
		return nil, fmt.Errorf("cdp port must be between 1 and 65535")
	}
	if values.WrapperPort <= 0 || values.WrapperPort > 65535 {
		return nil, fmt.Errorf("wrapper port must be between 1 and 65535")
	}
	if strings.TrimSpace(values.BrowserExecutable) == "" {
		return nil, fmt.Errorf("browser executable is required")
	}
	if extensionDir := strings.TrimSpace(values.CaptureProofExtensionDir); extensionDir != "" && !filepath.IsAbs(extensionDir) {
		return nil, fmt.Errorf("capture proof extension dir must be absolute")
	}
	if strings.TrimSpace(values.GPUMode) == "" {
		values.GPUMode = gpuModeAuto
	}
	if values.CompositorEnabled {
		if strings.TrimSpace(values.CompositorExecutable) == "" {
			return nil, fmt.Errorf("compositor executable is required")
		}
		if !filepath.IsAbs(values.CompositorExecutable) {
			return nil, fmt.Errorf("compositor executable must be absolute")
		}
		if strings.TrimSpace(values.CompositorBackend) == "" {
			return nil, fmt.Errorf("compositor backend is required")
		}
		if strings.TrimSpace(values.CompositorRenderer) == "" {
			return nil, fmt.Errorf("compositor renderer is required")
		}
		if strings.TrimSpace(values.CompositorShell) == "" {
			return nil, fmt.Errorf("compositor shell is required")
		}
		if values.CompositorWidth <= 0 {
			return nil, fmt.Errorf("compositor width must be positive")
		}
		if values.CompositorHeight <= 0 {
			return nil, fmt.Errorf("compositor height must be positive")
		}
		if err := ValidateCompositorBrowserArgs(values.BrowserDefaultArgs); err != nil {
			return nil, err
		}
		if err := ValidateCompositorBrowserArgs(values.BrowserExtraArgs); err != nil {
			return nil, err
		}
	}
	if values.MediaProducerEnabled {
		if !values.CompositorEnabled {
			return nil, fmt.Errorf("media producer requires compositor mode")
		}
		if strings.TrimSpace(values.MediaProducerGSTExecutable) == "" {
			return nil, fmt.Errorf("media producer gst executable is required")
		}
		if !filepath.IsAbs(values.MediaProducerGSTExecutable) {
			return nil, fmt.Errorf("media producer gst executable must be absolute")
		}
		if pluginPath := strings.TrimSpace(values.MediaProducerPluginPath); pluginPath != "" {
			for _, entry := range filepath.SplitList(pluginPath) {
				if strings.TrimSpace(entry) == "" {
					continue
				}
				if !filepath.IsAbs(entry) {
					return nil, fmt.Errorf("media producer plugin path entries must be absolute")
				}
			}
		}
		if strings.TrimSpace(values.MediaProducerTarget) == "" {
			return nil, fmt.Errorf("media producer target is required")
		}
		if strings.TrimSpace(values.MediaProducerCodec) == "" {
			return nil, fmt.Errorf("media producer codec is required")
		}
		if values.MediaProducerFPS <= 0 {
			return nil, fmt.Errorf("media producer fps must be positive")
		}
		if values.MediaProducerBitrateKbps <= 0 {
			return nil, fmt.Errorf("media producer bitrate must be positive")
		}
		if values.MediaProducerKeyframe <= 0 {
			return nil, fmt.Errorf("media producer keyframe interval must be positive")
		}
	}

	defaultArgs, err := encodeArgVector(values.BrowserDefaultArgs)
	if err != nil {
		return nil, fmt.Errorf("encode default args: %w", err)
	}
	extraArgs, err := encodeArgVector(values.BrowserExtraArgs)
	if err != nil {
		return nil, fmt.Errorf("encode extra args: %w", err)
	}

	lines := []string{
		"APERTURE_SESSION_ID=" + shellQuote(values.SessionID),
		"EXTERNAL_BASE_URL=" + shellQuote(values.ExternalBaseURL),
		"SESSION_TOKEN=" + shellQuote(values.SessionToken),
		"SESSION_TOKEN_PATH=" + shellQuote(values.SessionTokenPath),
		"MERGED_USER_DATA_DIR=" + shellQuote(values.MergedUserDataDir),
		"DOWNLOADS_DIR=" + shellQuote(values.DownloadsDir),
		"RECORDINGS_DIR=" + shellQuote(values.RecordingsDir),
		"CACHE_DIR=" + shellQuote(values.CacheDir),
		"ARTIFACTS_DIR=" + shellQuote(values.ArtifactsDir),
		"CDP_PORT=" + strconv.Itoa(values.CDPPort),
		"WRAPPER_PORT=" + strconv.Itoa(values.WrapperPort),
		"BROWSER_EXECUTABLE=" + shellQuote(values.BrowserExecutable),
		"BROWSER_DEFAULT_ARGS=" + defaultArgs,
		"BROWSER_EXTRA_ARGS=" + extraArgs,
		"GPU_MODE=" + shellQuote(values.GPUMode),
	}
	if strings.TrimSpace(values.CaptureProofExtensionDir) != "" {
		lines = append(lines, "CAPTURE_PROOF_EXTENSION_DIR="+shellQuote(values.CaptureProofExtensionDir))
	}
	if values.CompositorEnabled {
		lines = append(
			lines,
			"WEBRTC_COMPOSITOR_ENABLED=1",
			"WEBRTC_COMPOSITOR_EXECUTABLE="+shellQuote(values.CompositorExecutable),
			"WEBRTC_COMPOSITOR_BACKEND="+shellQuote(values.CompositorBackend),
			"WEBRTC_COMPOSITOR_RENDERER="+shellQuote(values.CompositorRenderer),
			"WEBRTC_COMPOSITOR_SHELL="+shellQuote(values.CompositorShell),
			"WEBRTC_COMPOSITOR_WIDTH="+strconv.Itoa(values.CompositorWidth),
			"WEBRTC_COMPOSITOR_HEIGHT="+strconv.Itoa(values.CompositorHeight),
		)
	}
	if values.MediaProducerEnabled {
		lines = append(
			lines,
			"WEBRTC_MEDIA_PRODUCER_ENABLED=1",
			"WEBRTC_MEDIA_PRODUCER_GST_EXECUTABLE="+shellQuote(values.MediaProducerGSTExecutable),
			"WEBRTC_MEDIA_PRODUCER_PLUGIN_PATH="+shellQuote(values.MediaProducerPluginPath),
			"WEBRTC_MEDIA_PRODUCER_TARGET="+shellQuote(values.MediaProducerTarget),
			"WEBRTC_MEDIA_PRODUCER_ICE_SERVERS="+shellQuote(values.MediaProducerICEServers),
			"WEBRTC_MEDIA_PRODUCER_CODEC="+shellQuote(values.MediaProducerCodec),
			"WEBRTC_MEDIA_PRODUCER_FPS="+strconv.Itoa(values.MediaProducerFPS),
			"WEBRTC_MEDIA_PRODUCER_BITRATE_KBPS="+strconv.Itoa(values.MediaProducerBitrateKbps),
			"WEBRTC_MEDIA_PRODUCER_KEYFRAME_INTERVAL="+strconv.Itoa(values.MediaProducerKeyframe),
		)
	}

	return []byte(strings.Join(lines, "\n") + "\n"), nil
}

// WriteRuntimeEnv atomically writes the runtime env file for a session.
func WriteRuntimeEnv(path string, values RuntimeEnvValues) error {
	body, err := RenderRuntimeEnv(values)
	if err != nil {
		return err
	}

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("mkdir runtime env dir: %w", err)
	}

	if err := renameio.WriteFile(path, body, 0o600, renameio.WithStaticPermissions(0o600)); err != nil {
		return fmt.Errorf("write runtime env: %w", err)
	}

	return nil
}

// ParseRuntimeEnv parses a rendered runtime env file body.
func ParseRuntimeEnv(body []byte) (RuntimeEnvValues, error) {
	values := RuntimeEnvValues{}
	lines := bytes.Split(bytes.TrimSpace(body), []byte("\n"))

	for _, line := range lines {
		key, val, ok := strings.Cut(string(line), "=")
		if !ok {
			return RuntimeEnvValues{}, fmt.Errorf("invalid env line: %q", line)
		}

		switch key {
		case "APERTURE_SESSION_ID", "EXTERNAL_BASE_URL", "SESSION_TOKEN", "SESSION_TOKEN_PATH", "MERGED_USER_DATA_DIR", "DOWNLOADS_DIR", "RECORDINGS_DIR", "CACHE_DIR", "ARTIFACTS_DIR", "BROWSER_EXECUTABLE", "CAPTURE_PROOF_EXTENSION_DIR", "GPU_MODE", "WEBRTC_COMPOSITOR_EXECUTABLE", "WEBRTC_COMPOSITOR_BACKEND", "WEBRTC_COMPOSITOR_RENDERER", "WEBRTC_COMPOSITOR_SHELL", "WEBRTC_MEDIA_PRODUCER_GST_EXECUTABLE", "WEBRTC_MEDIA_PRODUCER_PLUGIN_PATH", "WEBRTC_MEDIA_PRODUCER_TARGET", "WEBRTC_MEDIA_PRODUCER_ICE_SERVERS", "WEBRTC_MEDIA_PRODUCER_CODEC":
			unquoted, err := shellUnquote(val)
			if err != nil {
				return RuntimeEnvValues{}, fmt.Errorf("unquote %s: %w", key, err)
			}
			assignRuntimeString(&values, key, unquoted)
		case "WEBRTC_COMPOSITOR_ENABLED":
			values.CompositorEnabled = strings.TrimSpace(val) == "1"
		case "WEBRTC_MEDIA_PRODUCER_ENABLED":
			values.MediaProducerEnabled = strings.TrimSpace(val) == "1"
		case "CDP_PORT":
			port, err := strconv.Atoi(val)
			if err != nil {
				return RuntimeEnvValues{}, fmt.Errorf("parse cdp port: %w", err)
			}
			values.CDPPort = port
		case "WRAPPER_PORT":
			port, err := strconv.Atoi(val)
			if err != nil {
				return RuntimeEnvValues{}, fmt.Errorf("parse wrapper port: %w", err)
			}
			values.WrapperPort = port
		case "WEBRTC_COMPOSITOR_WIDTH":
			width, err := strconv.Atoi(val)
			if err != nil {
				return RuntimeEnvValues{}, fmt.Errorf("parse compositor width: %w", err)
			}
			values.CompositorWidth = width
		case "WEBRTC_COMPOSITOR_HEIGHT":
			height, err := strconv.Atoi(val)
			if err != nil {
				return RuntimeEnvValues{}, fmt.Errorf("parse compositor height: %w", err)
			}
			values.CompositorHeight = height
		case "WEBRTC_MEDIA_PRODUCER_FPS":
			fps, err := strconv.Atoi(val)
			if err != nil {
				return RuntimeEnvValues{}, fmt.Errorf("parse media producer fps: %w", err)
			}
			values.MediaProducerFPS = fps
		case "WEBRTC_MEDIA_PRODUCER_BITRATE_KBPS":
			bitrate, err := strconv.Atoi(val)
			if err != nil {
				return RuntimeEnvValues{}, fmt.Errorf("parse media producer bitrate: %w", err)
			}
			values.MediaProducerBitrateKbps = bitrate
		case "WEBRTC_MEDIA_PRODUCER_KEYFRAME_INTERVAL":
			keyframe, err := strconv.Atoi(val)
			if err != nil {
				return RuntimeEnvValues{}, fmt.Errorf("parse media producer keyframe interval: %w", err)
			}
			values.MediaProducerKeyframe = keyframe
		case "BROWSER_DEFAULT_ARGS":
			args, err := decodeArgVector(val)
			if err != nil {
				return RuntimeEnvValues{}, fmt.Errorf("decode default args: %w", err)
			}
			values.BrowserDefaultArgs = args
		case "BROWSER_EXTRA_ARGS":
			args, err := decodeArgVector(val)
			if err != nil {
				return RuntimeEnvValues{}, fmt.Errorf("decode extra args: %w", err)
			}
			values.BrowserExtraArgs = args
		default:
			return RuntimeEnvValues{}, fmt.Errorf("unexpected env key: %s", key)
		}
	}

	return values, nil
}

func assignRuntimeString(values *RuntimeEnvValues, key, value string) {
	switch key {
	case "APERTURE_SESSION_ID":
		values.SessionID = value
	case "EXTERNAL_BASE_URL":
		values.ExternalBaseURL = value
	case "SESSION_TOKEN":
		values.SessionToken = value
	case "SESSION_TOKEN_PATH":
		values.SessionTokenPath = value
	case "MERGED_USER_DATA_DIR":
		values.MergedUserDataDir = value
	case "DOWNLOADS_DIR":
		values.DownloadsDir = value
	case "RECORDINGS_DIR":
		values.RecordingsDir = value
	case "CACHE_DIR":
		values.CacheDir = value
	case "ARTIFACTS_DIR":
		values.ArtifactsDir = value
	case "BROWSER_EXECUTABLE":
		values.BrowserExecutable = value
	case "CAPTURE_PROOF_EXTENSION_DIR":
		values.CaptureProofExtensionDir = value
	case "GPU_MODE":
		values.GPUMode = value
	case "WEBRTC_COMPOSITOR_EXECUTABLE":
		values.CompositorExecutable = value
	case "WEBRTC_COMPOSITOR_BACKEND":
		values.CompositorBackend = value
	case "WEBRTC_COMPOSITOR_RENDERER":
		values.CompositorRenderer = value
	case "WEBRTC_COMPOSITOR_SHELL":
		values.CompositorShell = value
	case "WEBRTC_MEDIA_PRODUCER_GST_EXECUTABLE":
		values.MediaProducerGSTExecutable = value
	case "WEBRTC_MEDIA_PRODUCER_PLUGIN_PATH":
		values.MediaProducerPluginPath = value
	case "WEBRTC_MEDIA_PRODUCER_TARGET":
		values.MediaProducerTarget = value
	case "WEBRTC_MEDIA_PRODUCER_ICE_SERVERS":
		values.MediaProducerICEServers = value
	case "WEBRTC_MEDIA_PRODUCER_CODEC":
		values.MediaProducerCodec = value
	}
}

func encodeArgVector(args []string) (string, error) {
	if len(args) == 0 {
		return "", nil
	}
	data, err := json.Marshal(args)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(data), nil
}

func decodeArgVector(encoded string) ([]string, error) {
	if encoded == "" {
		return nil, nil
	}
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, err
	}
	var args []string
	if err := json.Unmarshal(data, &args); err != nil {
		return nil, err
	}
	return args, nil
}

func shellQuote(value string) string {
	if value == "" {
		return `""`
	}
	if !strings.ContainsAny(value, " \t\n\"'\\$`") {
		return value
	}
	return strconv.Quote(value)
}

func shellUnquote(value string) (string, error) {
	if value == "" {
		return "", nil
	}
	if len(value) >= 2 && value[0] == '"' && value[len(value)-1] == '"' {
		return strconv.Unquote(value)
	}
	return value, nil
}

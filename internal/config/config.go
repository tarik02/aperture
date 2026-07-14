package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/viper"
)

const (
	envPrefix     = "APERTURE"
	defaultConfig = "aperture"

	WebRTCMediaModeAuto          = "auto"
	WebRTCMediaModeCDP           = "cdp"
	WebRTCMediaProducerCodecVP8  = "vp8"
	WebRTCMediaProducerCodecH264 = "h264-va"
	DeployColorBlue              = "blue"
	DeployColorGreen             = "green"
)

// ChannelConfig describes a configured browser channel.
type ChannelConfig struct {
	Executable  string   `mapstructure:"executable"`
	DefaultArgs []string `mapstructure:"default_args"`
}

// WebRTCICEServer describes a STUN/TURN server shared by producer and viewer.
type WebRTCICEServer struct {
	URLs       []string `mapstructure:"urls" json:"urls"`
	Username   string   `mapstructure:"username" json:"username,omitempty"`
	Credential string   `mapstructure:"credential" json:"credential,omitempty"`
}

// Config holds resolved runtime configuration decoded from Viper.
type Config struct {
	StoreRoot                        string                   `mapstructure:"store_root"`
	RuntimeRoot                      string                   `mapstructure:"runtime_root"`
	ArtifactRoot                     string                   `mapstructure:"artifact_root"`
	DatabasePath                     string                   `mapstructure:"database_path"`
	TraefikDynamicConfigDir          string                   `mapstructure:"traefik_dynamic_config_dir"`
	DeployColor                      string                   `mapstructure:"deploy_color"`
	DeployStatePath                  string                   `mapstructure:"deploy_state_path"`
	DeployVersion                    string                   `mapstructure:"deploy_version"`
	DeployBlueURL                    string                   `mapstructure:"deploy_blue_url"`
	DeployGreenURL                   string                   `mapstructure:"deploy_green_url"`
	ListenAddress                    string                   `mapstructure:"listen_address"`
	SystemdBrowserUnitName           string                   `mapstructure:"systemd_browser_unit_name"`
	SessionRetentionDays             int                      `mapstructure:"session_retention_days"`
	SnapshotRetentionDays            int                      `mapstructure:"snapshot_retention_days"`
	ChannelRegistry                  map[string]ChannelConfig `mapstructure:"channels"`
	ExternalBaseURL                  string                   `mapstructure:"external_base_url"`
	CdpRouteBasePath                 string                   `mapstructure:"cdp_route_base_path"`
	WebRTCCaptureProofExtensionDir   string                   `mapstructure:"webrtc_capture_proof_extension_dir"`
	WebRTCMediaMode                  string                   `mapstructure:"webrtc_media_mode"`
	WebRTCCompositorEnabled          bool                     `mapstructure:"webrtc_compositor_enabled"`
	WebRTCCompositorExecutable       string                   `mapstructure:"webrtc_compositor_executable"`
	WebRTCCompositorBackend          string                   `mapstructure:"webrtc_compositor_backend"`
	WebRTCCompositorRenderer         string                   `mapstructure:"webrtc_compositor_renderer"`
	WebRTCCompositorShell            string                   `mapstructure:"webrtc_compositor_shell"`
	WebRTCCompositorWidth            int                      `mapstructure:"webrtc_compositor_width"`
	WebRTCCompositorHeight           int                      `mapstructure:"webrtc_compositor_height"`
	WebRTCMediaProducerEnabled       bool                     `mapstructure:"webrtc_media_producer_enabled"`
	WebRTCMediaProducerGSTExecutable string                   `mapstructure:"webrtc_media_producer_gst_executable"`
	WebRTCMediaProducerPluginPath    string                   `mapstructure:"webrtc_media_producer_plugin_path"`
	WebRTCMediaProducerTarget        string                   `mapstructure:"webrtc_media_producer_target"`
	WebRTCMediaProducerCodec         string                   `mapstructure:"webrtc_media_producer_codec"`
	WebRTCMediaProducerFPS           int                      `mapstructure:"webrtc_media_producer_fps"`
	WebRTCMediaProducerBitrateKbps   int                      `mapstructure:"webrtc_media_producer_bitrate_kbps"`
	WebRTCMediaProducerKeyframe      int                      `mapstructure:"webrtc_media_producer_keyframe_interval"`
	WebRTCICEServers                 []WebRTCICEServer        `mapstructure:"webrtc_ice_servers"`
	MCPEnabled                       bool                     `mapstructure:"mcp_enabled"`
	AgentBrowserToolsDefault         string                   `mapstructure:"agent_browser_tools_default"`
	AgentBrowserIdleTimeout          time.Duration            `mapstructure:"agent_browser_idle_timeout"`
	ToolOutputMaxBytes               int64                    `mapstructure:"tool_output_max_bytes"`
	SignedFileURLTTL                 time.Duration            `mapstructure:"signed_file_url_ttl"`
	SignedFileURLMaxTTL              time.Duration            `mapstructure:"signed_file_url_max_ttl"`
	LogLevel                         string                   `mapstructure:"log_level"`
	ConfigFile                       string                   `mapstructure:"-"`
}

// Defaults returns built-in default configuration values.
func Defaults() Config {
	storeRoot := defaultStoreRoot()
	runtimeRoot := defaultRuntimeRoot()

	return Config{
		StoreRoot:                        storeRoot,
		RuntimeRoot:                      runtimeRoot,
		ArtifactRoot:                     filepath.Join(storeRoot, "artifacts"),
		DatabasePath:                     filepath.Join(storeRoot, "aperture.db"),
		TraefikDynamicConfigDir:          filepath.Join(runtimeRoot, "traefik", "dynamic"),
		DeployColor:                      DeployColorBlue,
		DeployStatePath:                  filepath.Join(storeRoot, "deployment-state.json"),
		DeployVersion:                    "",
		DeployBlueURL:                    "http://127.0.0.1:28080",
		DeployGreenURL:                   "http://127.0.0.1:28082",
		ListenAddress:                    "127.0.0.1:8080",
		SystemdBrowserUnitName:           "browser-session@.service",
		SessionRetentionDays:             7,
		SnapshotRetentionDays:            7,
		ChannelRegistry:                  nil,
		ExternalBaseURL:                  "",
		CdpRouteBasePath:                 "/cdp",
		WebRTCCaptureProofExtensionDir:   "",
		WebRTCMediaMode:                  WebRTCMediaModeAuto,
		WebRTCCompositorEnabled:          false,
		WebRTCCompositorExecutable:       "",
		WebRTCCompositorBackend:          "pipewire",
		WebRTCCompositorRenderer:         "gl",
		WebRTCCompositorShell:            "kiosk",
		WebRTCCompositorWidth:            1280,
		WebRTCCompositorHeight:           720,
		WebRTCMediaProducerEnabled:       false,
		WebRTCMediaProducerGSTExecutable: "",
		WebRTCMediaProducerPluginPath:    "",
		WebRTCMediaProducerTarget:        "weston.pipewire",
		WebRTCMediaProducerCodec:         WebRTCMediaProducerCodecVP8,
		WebRTCMediaProducerFPS:           60,
		WebRTCMediaProducerBitrateKbps:   6000,
		WebRTCMediaProducerKeyframe:      120,
		WebRTCICEServers:                 nil,
		MCPEnabled:                       true,
		AgentBrowserToolsDefault:         "core,tabs,mobile,network",
		AgentBrowserIdleTimeout:          5 * time.Minute,
		ToolOutputMaxBytes:               16 * 1024 * 1024,
		SignedFileURLTTL:                 15 * time.Minute,
		SignedFileURLMaxTTL:              24 * time.Hour,
		LogLevel:                         "info",
	}
}

func defaultStoreRoot() string {
	if stateHome := strings.TrimSpace(os.Getenv("XDG_STATE_HOME")); stateHome != "" {
		return filepath.Join(stateHome, "aperture")
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(os.TempDir(), "aperture-state")
	}

	return filepath.Join(home, ".local", "state", "aperture")
}

func defaultRuntimeRoot() string {
	if runtimeDir := strings.TrimSpace(os.Getenv("XDG_RUNTIME_DIR")); runtimeDir != "" {
		return filepath.Join(runtimeDir, "aperture")
	}

	return filepath.Join(os.TempDir(), "aperture-runtime")
}

// Load resolves configuration using flag, environment, file, and default precedence.
func Load(flags *viper.Viper) (Config, error) {
	v := viper.New()
	v.SetEnvPrefix(envPrefix)
	v.SetEnvKeyReplacer(strings.NewReplacer(".", "_", "-", "_"))
	v.AutomaticEnv()

	defaults := Defaults()
	v.SetDefault("store_root", defaults.StoreRoot)
	v.SetDefault("runtime_root", defaults.RuntimeRoot)
	v.SetDefault("listen_address", defaults.ListenAddress)
	v.SetDefault("deploy_color", defaults.DeployColor)
	v.SetDefault("deploy_blue_url", defaults.DeployBlueURL)
	v.SetDefault("deploy_green_url", defaults.DeployGreenURL)
	v.SetDefault("systemd_browser_unit_name", defaults.SystemdBrowserUnitName)
	v.SetDefault("session_retention_days", defaults.SessionRetentionDays)
	v.SetDefault("snapshot_retention_days", defaults.SnapshotRetentionDays)
	v.SetDefault("cdp_route_base_path", defaults.CdpRouteBasePath)
	v.SetDefault("webrtc_media_mode", defaults.WebRTCMediaMode)
	v.SetDefault("webrtc_compositor_enabled", defaults.WebRTCCompositorEnabled)
	v.SetDefault("webrtc_compositor_backend", defaults.WebRTCCompositorBackend)
	v.SetDefault("webrtc_compositor_renderer", defaults.WebRTCCompositorRenderer)
	v.SetDefault("webrtc_compositor_shell", defaults.WebRTCCompositorShell)
	v.SetDefault("webrtc_compositor_width", defaults.WebRTCCompositorWidth)
	v.SetDefault("webrtc_compositor_height", defaults.WebRTCCompositorHeight)
	v.SetDefault("webrtc_media_producer_enabled", defaults.WebRTCMediaProducerEnabled)
	v.SetDefault("webrtc_media_producer_target", defaults.WebRTCMediaProducerTarget)
	v.SetDefault("webrtc_media_producer_codec", defaults.WebRTCMediaProducerCodec)
	v.SetDefault("webrtc_media_producer_fps", defaults.WebRTCMediaProducerFPS)
	v.SetDefault("webrtc_media_producer_bitrate_kbps", defaults.WebRTCMediaProducerBitrateKbps)
	v.SetDefault("webrtc_media_producer_keyframe_interval", defaults.WebRTCMediaProducerKeyframe)
	v.SetDefault("webrtc_ice_servers", defaults.WebRTCICEServers)
	v.SetDefault("mcp_enabled", defaults.MCPEnabled)
	v.SetDefault("agent_browser_tools_default", defaults.AgentBrowserToolsDefault)
	v.SetDefault("agent_browser_idle_timeout", defaults.AgentBrowserIdleTimeout)
	v.SetDefault("tool_output_max_bytes", defaults.ToolOutputMaxBytes)
	v.SetDefault("signed_file_url_ttl", defaults.SignedFileURLTTL)
	v.SetDefault("signed_file_url_max_ttl", defaults.SignedFileURLMaxTTL)
	v.SetDefault("log_level", defaults.LogLevel)

	if configFile := flags.GetString("config"); configFile != "" {
		v.SetConfigFile(configFile)
	} else {
		v.SetConfigName(defaultConfig)
		v.AddConfigPath(".")
		v.AddConfigPath("$HOME/.config/aperture")
	}

	for _, key := range []string{
		"store_root",
		"runtime_root",
		"artifact_root",
		"database_path",
		"traefik_dynamic_config_dir",
		"deploy_color",
		"deploy_state_path",
		"deploy_version",
		"deploy_blue_url",
		"deploy_green_url",
		"listen_address",
		"systemd_browser_unit_name",
		"session_retention_days",
		"snapshot_retention_days",
		"external_base_url",
		"cdp_route_base_path",
		"webrtc_capture_proof_extension_dir",
		"webrtc_media_mode",
		"webrtc_compositor_enabled",
		"webrtc_compositor_executable",
		"webrtc_compositor_backend",
		"webrtc_compositor_renderer",
		"webrtc_compositor_shell",
		"webrtc_compositor_width",
		"webrtc_compositor_height",
		"webrtc_media_producer_enabled",
		"webrtc_media_producer_gst_executable",
		"webrtc_media_producer_plugin_path",
		"webrtc_media_producer_target",
		"webrtc_media_producer_codec",
		"webrtc_media_producer_fps",
		"webrtc_media_producer_bitrate_kbps",
		"webrtc_media_producer_keyframe_interval",
		"webrtc_ice_servers",
		"mcp_enabled",
		"agent_browser_tools_default",
		"agent_browser_idle_timeout",
		"tool_output_max_bytes",
		"signed_file_url_ttl",
		"signed_file_url_max_ttl",
		"log_level",
	} {
		if err := v.BindEnv(key); err != nil {
			return Config{}, fmt.Errorf("bind env %s: %w", key, err)
		}
	}

	explicitConfig := flags.GetString("config") != ""
	if err := v.ReadInConfig(); err != nil {
		if explicitConfig {
			return Config{}, fmt.Errorf("read config %s: %w", flags.GetString("config"), err)
		}

		var notFound viper.ConfigFileNotFoundError
		if !errors.As(err, &notFound) {
			return Config{}, fmt.Errorf("read config: %w", err)
		}
	}

	applyFlagOverrides(v, flags)

	var cfg Config
	if err := v.Unmarshal(&cfg); err != nil {
		return Config{}, err
	}

	if v.ConfigFileUsed() != "" {
		cfg.ConfigFile = v.ConfigFileUsed()
	}

	explicit := explicitPathsFrom(v, flags)
	cfg.applyDerivedPaths(explicit)

	return cfg, Validate(cfg)
}

type explicitPaths struct {
	artifactRoot            bool
	databasePath            bool
	traefikDynamicConfigDir bool
	deployStatePath         bool
}

func explicitPathsFrom(v *viper.Viper, flags *viper.Viper) explicitPaths {
	return explicitPaths{
		artifactRoot:            v.IsSet("artifact_root") || flags.IsSet("artifact-root"),
		databasePath:            v.IsSet("database_path") || flags.IsSet("database-path"),
		traefikDynamicConfigDir: v.IsSet("traefik_dynamic_config_dir") || flags.IsSet("traefik-dynamic-config-dir"),
		deployStatePath:         v.IsSet("deploy_state_path") || flags.IsSet("deploy-state-path"),
	}
}

func (cfg *Config) applyDerivedPaths(explicit explicitPaths) {
	if !explicit.artifactRoot && strings.TrimSpace(cfg.StoreRoot) != "" {
		cfg.ArtifactRoot = filepath.Join(cfg.StoreRoot, "artifacts")
	}
	if !explicit.databasePath && strings.TrimSpace(cfg.StoreRoot) != "" {
		cfg.DatabasePath = filepath.Join(cfg.StoreRoot, "aperture.db")
	}
	if !explicit.traefikDynamicConfigDir && strings.TrimSpace(cfg.RuntimeRoot) != "" {
		cfg.TraefikDynamicConfigDir = filepath.Join(cfg.RuntimeRoot, "traefik", "dynamic")
	}
	if !explicit.deployStatePath && strings.TrimSpace(cfg.StoreRoot) != "" {
		cfg.DeployStatePath = filepath.Join(cfg.StoreRoot, "deployment-state.json")
	}
}

func applyFlagOverrides(v *viper.Viper, flags *viper.Viper) {
	flagBindings := map[string]string{
		"listen-address":                          "listen_address",
		"log-level":                               "log_level",
		"store-root":                              "store_root",
		"runtime-root":                            "runtime_root",
		"artifact-root":                           "artifact_root",
		"database-path":                           "database_path",
		"traefik-dynamic-config-dir":              "traefik_dynamic_config_dir",
		"deploy-color":                            "deploy_color",
		"deploy-state-path":                       "deploy_state_path",
		"deploy-version":                          "deploy_version",
		"deploy-blue-url":                         "deploy_blue_url",
		"deploy-green-url":                        "deploy_green_url",
		"systemd-browser-unit-name":               "systemd_browser_unit_name",
		"session-retention-days":                  "session_retention_days",
		"snapshot-retention-days":                 "snapshot_retention_days",
		"external-base-url":                       "external_base_url",
		"cdp-route-base-path":                     "cdp_route_base_path",
		"webrtc-media-mode":                       "webrtc_media_mode",
		"webrtc-compositor-enabled":               "webrtc_compositor_enabled",
		"webrtc-compositor-executable":            "webrtc_compositor_executable",
		"webrtc-compositor-backend":               "webrtc_compositor_backend",
		"webrtc-compositor-renderer":              "webrtc_compositor_renderer",
		"webrtc-compositor-shell":                 "webrtc_compositor_shell",
		"webrtc-compositor-width":                 "webrtc_compositor_width",
		"webrtc-compositor-height":                "webrtc_compositor_height",
		"webrtc-media-producer-enabled":           "webrtc_media_producer_enabled",
		"webrtc-media-producer-gst-executable":    "webrtc_media_producer_gst_executable",
		"webrtc-media-producer-plugin-path":       "webrtc_media_producer_plugin_path",
		"webrtc-media-producer-target":            "webrtc_media_producer_target",
		"webrtc-media-producer-codec":             "webrtc_media_producer_codec",
		"webrtc-media-producer-fps":               "webrtc_media_producer_fps",
		"webrtc-media-producer-bitrate-kbps":      "webrtc_media_producer_bitrate_kbps",
		"webrtc-media-producer-keyframe-interval": "webrtc_media_producer_keyframe_interval",
	}

	for flagName, configKey := range flagBindings {
		if flags.IsSet(flagName) {
			v.Set(configKey, flags.Get(flagName))
		}
	}
}

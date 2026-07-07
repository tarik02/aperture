package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/spf13/viper"
)

// LoadFromFileOnly reads configuration exclusively from path without environment or flag overrides.
func LoadFromFileOnly(path string) (Config, error) {
	trimmed := strings.TrimSpace(path)
	if trimmed == "" {
		return Config{}, fmt.Errorf("config path is required")
	}
	if !filepath.IsAbs(trimmed) {
		return Config{}, fmt.Errorf("config path must be absolute")
	}

	v := viper.New()
	v.SetConfigFile(trimmed)

	defaults := Defaults()
	v.SetDefault("systemd_browser_unit_name", defaults.SystemdBrowserUnitName)
	v.SetDefault("session_retention_days", defaults.SessionRetentionDays)
	v.SetDefault("snapshot_retention_days", defaults.SnapshotRetentionDays)
	v.SetDefault("cdp_route_base_path", defaults.CdpRouteBasePath)
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
	v.SetDefault("log_level", defaults.LogLevel)

	if err := v.ReadInConfig(); err != nil {
		return Config{}, fmt.Errorf("read config %s: %w", trimmed, err)
	}

	var cfg Config
	if err := v.Unmarshal(&cfg); err != nil {
		return Config{}, err
	}

	cfg.ConfigFile = trimmed
	cfg.applyDerivedPaths(explicitPaths{
		artifactRoot:             v.IsSet("artifact_root"),
		databasePath:             v.IsSet("database_path"),
		traefikDynamicConfigPath: v.IsSet("traefik_dynamic_config_path"),
	})

	return cfg, Validate(cfg)
}

// ValidateTrustedConfigFile checks that path is a root-owned config file in a root-owned parent directory.
func ValidateTrustedConfigFile(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("stat config: %w", err)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("config must be a regular file")
	}

	mode := info.Mode().Perm()
	if mode&0o022 != 0 {
		return fmt.Errorf("config must not be group or world writable")
	}

	if !fileOwnedByRoot(info) {
		return fmt.Errorf("config must be owned by root")
	}

	parent := filepath.Dir(path)
	parentInfo, err := os.Stat(parent)
	if err != nil {
		return fmt.Errorf("stat config parent: %w", err)
	}
	if !parentInfo.IsDir() {
		return fmt.Errorf("config parent must be a directory")
	}
	if err := validateTrustedConfigParentDir(parentInfo); err != nil {
		return err
	}

	return nil
}

func validateTrustedConfigParentDir(parentInfo os.FileInfo) error {
	if parentInfo.Mode().Perm()&0o022 != 0 {
		return fmt.Errorf("config parent directory must not be group or world writable")
	}
	if !fileOwnedByRoot(parentInfo) {
		return fmt.Errorf("config parent directory must be owned by root")
	}
	return nil
}

func fileOwnedByRoot(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return false
	}
	return stat.Uid == 0
}

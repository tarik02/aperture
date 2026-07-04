package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/viper"
)

const (
	envPrefix     = "APERTURE"
	defaultConfig = "aperture"
)

// ChannelConfig describes a configured browser channel.
type ChannelConfig struct {
	Executable  string   `mapstructure:"executable"`
	DefaultArgs []string `mapstructure:"default_args"`
}

// Config holds resolved runtime configuration decoded from Viper.
type Config struct {
	StoreRoot                string                   `mapstructure:"store_root"`
	RuntimeRoot              string                   `mapstructure:"runtime_root"`
	ArtifactRoot             string                   `mapstructure:"artifact_root"`
	DatabasePath             string                   `mapstructure:"database_path"`
	TraefikDynamicConfigPath string                   `mapstructure:"traefik_dynamic_config_path"`
	ListenAddress            string                   `mapstructure:"listen_address"`
	SystemdBrowserUnitName   string                   `mapstructure:"systemd_browser_unit_name"`
	SessionRetentionDays     int                      `mapstructure:"session_retention_days"`
	SnapshotRetentionDays    int                      `mapstructure:"snapshot_retention_days"`
	ChannelRegistry          map[string]ChannelConfig `mapstructure:"channels"`
	ExternalBaseURL          string                   `mapstructure:"external_base_url"`
	CdpRouteBasePath         string                   `mapstructure:"cdp_route_base_path"`
	LogLevel                 string                   `mapstructure:"log_level"`
	ConfigFile               string                   `mapstructure:"-"`
}

// Defaults returns built-in default configuration values.
func Defaults() Config {
	storeRoot := defaultStoreRoot()
	runtimeRoot := defaultRuntimeRoot()

	return Config{
		StoreRoot:                storeRoot,
		RuntimeRoot:              runtimeRoot,
		ArtifactRoot:             filepath.Join(storeRoot, "artifacts"),
		DatabasePath:             filepath.Join(storeRoot, "aperture.db"),
		TraefikDynamicConfigPath: filepath.Join(runtimeRoot, "traefik", "dynamic.yaml"),
		ListenAddress:            "127.0.0.1:8080",
		SystemdBrowserUnitName:   "browser-session@.service",
		SessionRetentionDays:     7,
		SnapshotRetentionDays:    7,
		ChannelRegistry:          nil,
		ExternalBaseURL:          "",
		CdpRouteBasePath:         "/cdp",
		LogLevel:                 "info",
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
	v.SetDefault("systemd_browser_unit_name", defaults.SystemdBrowserUnitName)
	v.SetDefault("session_retention_days", defaults.SessionRetentionDays)
	v.SetDefault("snapshot_retention_days", defaults.SnapshotRetentionDays)
	v.SetDefault("cdp_route_base_path", defaults.CdpRouteBasePath)
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
		"traefik_dynamic_config_path",
		"listen_address",
		"systemd_browser_unit_name",
		"session_retention_days",
		"snapshot_retention_days",
		"external_base_url",
		"cdp_route_base_path",
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
	artifactRoot             bool
	databasePath             bool
	traefikDynamicConfigPath bool
}

func explicitPathsFrom(v *viper.Viper, flags *viper.Viper) explicitPaths {
	return explicitPaths{
		artifactRoot:             v.IsSet("artifact_root") || flags.IsSet("artifact-root"),
		databasePath:             v.IsSet("database_path") || flags.IsSet("database-path"),
		traefikDynamicConfigPath: v.IsSet("traefik_dynamic_config_path") || flags.IsSet("traefik-dynamic-config-path"),
	}
}

func (cfg *Config) applyDerivedPaths(explicit explicitPaths) {
	if !explicit.artifactRoot && strings.TrimSpace(cfg.StoreRoot) != "" {
		cfg.ArtifactRoot = filepath.Join(cfg.StoreRoot, "artifacts")
	}
	if !explicit.databasePath && strings.TrimSpace(cfg.StoreRoot) != "" {
		cfg.DatabasePath = filepath.Join(cfg.StoreRoot, "aperture.db")
	}
	if !explicit.traefikDynamicConfigPath && strings.TrimSpace(cfg.RuntimeRoot) != "" {
		cfg.TraefikDynamicConfigPath = filepath.Join(cfg.RuntimeRoot, "traefik", "dynamic.yaml")
	}
}

func applyFlagOverrides(v *viper.Viper, flags *viper.Viper) {
	flagBindings := map[string]string{
		"listen-address":              "listen_address",
		"log-level":                   "log_level",
		"store-root":                  "store_root",
		"runtime-root":                "runtime_root",
		"artifact-root":               "artifact_root",
		"database-path":               "database_path",
		"traefik-dynamic-config-path": "traefik_dynamic_config_path",
		"systemd-browser-unit-name":   "systemd_browser_unit_name",
		"session-retention-days":      "session_retention_days",
		"snapshot-retention-days":     "snapshot_retention_days",
		"external-base-url":           "external_base_url",
		"cdp-route-base-path":         "cdp_route_base_path",
	}

	for flagName, configKey := range flagBindings {
		if flags.IsSet(flagName) {
			v.Set(configKey, flags.Get(flagName))
		}
	}
}

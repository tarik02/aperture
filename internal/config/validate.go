package config

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"path/filepath"
	"strings"
)

// Validate checks resolved configuration before service startup.
func Validate(cfg Config) error {
	var errs []error

	errs = append(errs, validateRequiredAbsolutePath("store_root", cfg.StoreRoot)...)
	errs = append(errs, validateRequiredAbsolutePath("runtime_root", cfg.RuntimeRoot)...)
	errs = append(errs, validateRequiredAbsolutePath("artifact_root", cfg.ArtifactRoot)...)
	errs = append(errs, validateRequiredAbsolutePath("database_path", cfg.DatabasePath)...)
	errs = append(errs, validateRequiredAbsolutePath("traefik_dynamic_config_path", cfg.TraefikDynamicConfigPath)...)

	if strings.TrimSpace(cfg.ListenAddress) == "" {
		errs = append(errs, errors.New("listen_address is required"))
	} else if host, _, err := net.SplitHostPort(cfg.ListenAddress); err != nil {
		errs = append(errs, fmt.Errorf("listen_address: %w", err))
	} else if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		errs = append(errs, errors.New("listen_address must be loopback"))
	}

	if strings.TrimSpace(cfg.SystemdBrowserUnitName) == "" {
		errs = append(errs, errors.New("systemd_browser_unit_name is required"))
	}

	if cfg.SessionRetentionDays <= 0 {
		errs = append(errs, errors.New("session_retention_days must be positive"))
	}
	if cfg.SnapshotRetentionDays <= 0 {
		errs = append(errs, errors.New("snapshot_retention_days must be positive"))
	}

	if strings.TrimSpace(cfg.ExternalBaseURL) == "" {
		errs = append(errs, errors.New("external_base_url is required"))
	} else if parsed, err := url.Parse(cfg.ExternalBaseURL); err != nil {
		errs = append(errs, fmt.Errorf("external_base_url: %w", err))
	} else if parsed.Scheme == "" || parsed.Host == "" {
		errs = append(errs, errors.New("external_base_url must include scheme and host"))
	}

	cdpRoute := strings.TrimSpace(cfg.CdpRouteBasePath)
	if cdpRoute == "" {
		errs = append(errs, errors.New("cdp_route_base_path is required"))
	} else if !strings.HasPrefix(cdpRoute, "/") {
		errs = append(errs, errors.New("cdp_route_base_path must start with /"))
	}

	if len(cfg.ChannelRegistry) == 0 {
		errs = append(errs, errors.New("channels must include at least one browser channel"))
	} else {
		for name, channel := range cfg.ChannelRegistry {
			if strings.TrimSpace(name) == "" {
				errs = append(errs, errors.New("channels contains an empty channel name"))
				continue
			}
			if strings.TrimSpace(channel.Executable) == "" {
				errs = append(errs, fmt.Errorf("channels.%s.executable is required", name))
			}
		}
	}

	switch strings.ToLower(strings.TrimSpace(cfg.LogLevel)) {
	case "debug", "info", "warn", "error":
	default:
		errs = append(errs, errors.New("log_level must be debug, info, warn, or error"))
	}

	return errors.Join(errs...)
}

func validateRequiredAbsolutePath(name, value string) []error {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return []error{fmt.Errorf("%s is required", name)}
	}
	if !filepath.IsAbs(trimmed) {
		return []error{fmt.Errorf("%s must be an absolute path", name)}
	}
	return nil
}

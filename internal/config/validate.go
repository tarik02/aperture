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
	if captureProofDir := strings.TrimSpace(cfg.WebRTCCaptureProofExtensionDir); captureProofDir != "" && !filepath.IsAbs(captureProofDir) {
		errs = append(errs, errors.New("webrtc_capture_proof_extension_dir must be an absolute path"))
	}
	if cfg.WebRTCCompositorEnabled {
		if executable := strings.TrimSpace(cfg.WebRTCCompositorExecutable); executable == "" {
			errs = append(errs, errors.New("webrtc_compositor_executable is required when webrtc_compositor_enabled is true"))
		} else if !filepath.IsAbs(executable) {
			errs = append(errs, errors.New("webrtc_compositor_executable must be an absolute path"))
		}
		switch strings.TrimSpace(cfg.WebRTCCompositorBackend) {
		case "headless", "pipewire":
		default:
			errs = append(errs, errors.New("webrtc_compositor_backend must be headless or pipewire"))
		}
		if strings.TrimSpace(cfg.WebRTCCompositorRenderer) != "gl" {
			errs = append(errs, errors.New("webrtc_compositor_renderer must be gl when webrtc_compositor_enabled is true"))
		}
		if strings.TrimSpace(cfg.WebRTCCompositorShell) != "kiosk" {
			errs = append(errs, errors.New("webrtc_compositor_shell must be kiosk when webrtc_compositor_enabled is true"))
		}
		if cfg.WebRTCCompositorWidth <= 0 {
			errs = append(errs, errors.New("webrtc_compositor_width must be positive when webrtc_compositor_enabled is true"))
		}
		if cfg.WebRTCCompositorHeight <= 0 {
			errs = append(errs, errors.New("webrtc_compositor_height must be positive when webrtc_compositor_enabled is true"))
		}
	}
	if cfg.WebRTCMediaProducerEnabled {
		if !cfg.WebRTCCompositorEnabled {
			errs = append(errs, errors.New("webrtc_media_producer_enabled requires webrtc_compositor_enabled"))
		}
		if executable := strings.TrimSpace(cfg.WebRTCMediaProducerExecutable); executable == "" {
			errs = append(errs, errors.New("webrtc_media_producer_executable is required when webrtc_media_producer_enabled is true"))
		} else if !filepath.IsAbs(executable) {
			errs = append(errs, errors.New("webrtc_media_producer_executable must be an absolute path"))
		}
		if executable := strings.TrimSpace(cfg.WebRTCMediaProducerGSTExecutable); executable == "" {
			errs = append(errs, errors.New("webrtc_media_producer_gst_executable is required when webrtc_media_producer_enabled is true"))
		} else if !filepath.IsAbs(executable) {
			errs = append(errs, errors.New("webrtc_media_producer_gst_executable must be an absolute path"))
		}
		if pluginPath := strings.TrimSpace(cfg.WebRTCMediaProducerPluginPath); pluginPath != "" {
			for _, entry := range filepath.SplitList(pluginPath) {
				if strings.TrimSpace(entry) == "" {
					continue
				}
				if !filepath.IsAbs(entry) {
					errs = append(errs, errors.New("webrtc_media_producer_plugin_path entries must be absolute paths"))
					break
				}
			}
		}
		if strings.TrimSpace(cfg.WebRTCMediaProducerTarget) == "" {
			errs = append(errs, errors.New("webrtc_media_producer_target is required when webrtc_media_producer_enabled is true"))
		}
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

	cdpRoute := strings.TrimRight(strings.TrimSpace(cfg.CdpRouteBasePath), "/")
	if cdpRoute == "" {
		errs = append(errs, errors.New("cdp_route_base_path is required"))
	} else if !strings.HasPrefix(cdpRoute, "/") {
		errs = append(errs, errors.New("cdp_route_base_path must start with /"))
	} else if cdpRoute == "/internal" || strings.HasPrefix(cdpRoute, "/internal/") {
		errs = append(errs, errors.New("cdp_route_base_path must not be under /internal"))
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

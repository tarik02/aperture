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
	errs = append(errs, validateMCP(cfg)...)

	errs = append(errs, validateRequiredAbsolutePath("store_root", cfg.StoreRoot)...)
	errs = append(errs, validateRequiredAbsolutePath("runtime_root", cfg.RuntimeRoot)...)
	errs = append(errs, validateRequiredAbsolutePath("artifact_root", cfg.ArtifactRoot)...)
	errs = append(errs, validateRequiredAbsolutePath("database_path", cfg.DatabasePath)...)
	errs = append(errs, validateRequiredAbsolutePath("traefik_dynamic_config_dir", cfg.TraefikDynamicConfigDir)...)
	errs = append(errs, validateRequiredAbsolutePath("deploy_state_path", cfg.DeployStatePath)...)

	switch strings.ToLower(strings.TrimSpace(cfg.DeployColor)) {
	case DeployColorBlue, DeployColorGreen:
	default:
		errs = append(errs, errors.New("deploy_color must be blue or green"))
	}
	errs = append(errs, validateDeployURL("deploy_blue_url", cfg.DeployBlueURL)...)
	errs = append(errs, validateDeployURL("deploy_green_url", cfg.DeployGreenURL)...)

	if strings.TrimSpace(cfg.ListenAddress) == "" {
		errs = append(errs, errors.New("listen_address is required"))
	} else if host, _, err := net.SplitHostPort(cfg.ListenAddress); err != nil {
		errs = append(errs, fmt.Errorf("listen_address: %w", err))
	} else if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		errs = append(errs, errors.New("listen_address must be loopback"))
	}

	switch strings.ToLower(strings.TrimSpace(cfg.BrowserSupervisor)) {
	case BrowserSupervisorDirect:
	case BrowserSupervisorSystemd:
		if strings.TrimSpace(cfg.SystemdBrowserUnitName) == "" {
			errs = append(errs, errors.New("systemd_browser_unit_name is required when browser_supervisor is systemd"))
		}
	default:
		errs = append(errs, errors.New("browser_supervisor must be systemd or direct"))
	}
	if captureProofDir := strings.TrimSpace(cfg.WebRTCCaptureProofExtensionDir); captureProofDir != "" && !filepath.IsAbs(captureProofDir) {
		errs = append(errs, errors.New("webrtc_capture_proof_extension_dir must be an absolute path"))
	}
	mediaMode := strings.ToLower(strings.TrimSpace(cfg.WebRTCMediaMode))
	if mediaMode == "" {
		mediaMode = WebRTCMediaModeAuto
	}
	switch mediaMode {
	case WebRTCMediaModeAuto, WebRTCMediaModeCDP:
	default:
		errs = append(errs, errors.New("webrtc_media_mode must be auto or cdp"))
	}
	gpuMode := strings.ToLower(strings.TrimSpace(cfg.GPUMode))
	if gpuMode == "" {
		gpuMode = GPUModeAuto
	}
	switch gpuMode {
	case GPUModeAuto, GPUModeSoftware, GPUModeHardware:
	default:
		errs = append(errs, errors.New("gpu_mode must be auto, software, or hardware"))
	}
	webRTCRuntimeEnabled := mediaMode == WebRTCMediaModeAuto
	if webRTCRuntimeEnabled && cfg.WebRTCCompositorEnabled {
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
		switch strings.TrimSpace(cfg.WebRTCCompositorShell) {
		case "kiosk", "desktop", "lua-shell", "lua-shell.so", "aperture", "aperture-weston-shell.so":
		default:
			errs = append(errs, errors.New("webrtc_compositor_shell must be kiosk, desktop, or lua-shell when webrtc_compositor_enabled is true"))
		}
		if cfg.WebRTCCompositorWidth <= 0 {
			errs = append(errs, errors.New("webrtc_compositor_width must be positive when webrtc_compositor_enabled is true"))
		}
		if cfg.WebRTCCompositorHeight <= 0 {
			errs = append(errs, errors.New("webrtc_compositor_height must be positive when webrtc_compositor_enabled is true"))
		}
	}
	if webRTCRuntimeEnabled && cfg.WebRTCMediaProducerEnabled {
		if !cfg.WebRTCCompositorEnabled {
			errs = append(errs, errors.New("webrtc_media_producer_enabled requires webrtc_compositor_enabled"))
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
		switch strings.ToLower(strings.TrimSpace(cfg.WebRTCMediaProducerCodec)) {
		case WebRTCMediaProducerCodecAuto, WebRTCMediaProducerCodecVP8, WebRTCMediaProducerCodecH264:
		default:
			errs = append(errs, errors.New("webrtc_media_producer_codec must be auto, vp8, or h264-va"))
		}
		if gpuMode == GPUModeSoftware && strings.EqualFold(strings.TrimSpace(cfg.WebRTCMediaProducerCodec), WebRTCMediaProducerCodecH264) {
			errs = append(errs, errors.New("webrtc_media_producer_codec h264-va is incompatible with gpu_mode software"))
		}
		if cfg.WebRTCMediaProducerFPS <= 0 || cfg.WebRTCMediaProducerFPS > 120 {
			errs = append(errs, errors.New("webrtc_media_producer_fps must be between 1 and 120"))
		}
		if cfg.WebRTCMediaProducerBitrateKbps <= 0 {
			errs = append(errs, errors.New("webrtc_media_producer_bitrate_kbps must be positive"))
		}
		if cfg.WebRTCMediaProducerKeyframe <= 0 {
			errs = append(errs, errors.New("webrtc_media_producer_keyframe_interval must be positive"))
		}
	}
	for index, server := range cfg.WebRTCICEServers {
		if len(server.URLs) == 0 {
			errs = append(errs, fmt.Errorf("webrtc_ice_servers[%d].urls is required", index))
			continue
		}
		for _, rawURL := range server.URLs {
			parsed, err := url.Parse(strings.TrimSpace(rawURL))
			if err != nil || parsed.Scheme == "" {
				errs = append(errs, fmt.Errorf("webrtc_ice_servers[%d].urls contains an invalid URL", index))
				continue
			}
			switch parsed.Scheme {
			case "stun", "stuns":
			case "turn", "turns":
				if strings.TrimSpace(server.Username) == "" || strings.TrimSpace(server.Credential) == "" {
					errs = append(errs, fmt.Errorf("webrtc_ice_servers[%d] TURN credentials are required", index))
				}
			default:
				errs = append(errs, fmt.Errorf("webrtc_ice_servers[%d].urls scheme must be stun, stuns, turn, or turns", index))
			}
		}
	}

	if cfg.SessionRetentionDays <= 0 {
		errs = append(errs, errors.New("session_retention_days must be positive"))
	}
	if cfg.SessionUploadMaxFileBytes <= 0 {
		errs = append(errs, errors.New("session_upload_max_file_bytes must be positive"))
	}
	if cfg.SessionStorageQuotaBytes <= 0 {
		errs = append(errs, errors.New("session_storage_quota_bytes must be positive"))
	} else if cfg.SessionUploadMaxFileBytes > cfg.SessionStorageQuotaBytes {
		errs = append(errs, errors.New("session_upload_max_file_bytes must not exceed session_storage_quota_bytes"))
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

func validateDeployURL(name, value string) []error {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return []error{fmt.Errorf("%s is required", name)}
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return []error{fmt.Errorf("%s: %w", name, err)}
	}
	if parsed.Scheme == "" || parsed.Host == "" {
		return []error{fmt.Errorf("%s must include scheme and host", name)}
	}
	switch parsed.Scheme {
	case "http", "https":
	default:
		return []error{fmt.Errorf("%s scheme must be http or https", name)}
	}
	return nil
}

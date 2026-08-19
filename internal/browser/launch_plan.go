package browser

import (
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/aperture/aperture/internal/config"
)

const (
	BrowserModeHeaded   = config.BrowserModeHeaded
	BrowserModeHeadless = config.BrowserModeHeadless

	CapabilityStateActive      = "active"
	CapabilityStateProspective = "prospective"
	CapabilityStateUnavailable = "unavailable"

	LiveViewTransportWebRTC = "webrtc"
	LiveViewTransportCDP    = "cdp"

	RecordingMechanismCompositor = "compositor"
	RecordingMechanismCDP        = "cdp"
)

var ErrInvalidBrowserMode = errors.New("invalid browser mode")

var ErrBrowserConfigurationUnavailable = errors.New("browser configuration is unavailable")

// LiveViewCapability describes ordered live-view transports.
type LiveViewCapability struct {
	Transports []string `json:"transports"`
}

// RecordingCodecCapability pairs a recording codec with its output media type.
type RecordingCodecCapability struct {
	Codec     string `json:"codec"`
	MediaType string `json:"mediaType"`
}

// CDPRecordingCapability describes controls specific to CDP frame capture.
type CDPRecordingCapability struct {
	Formats        []string `json:"formats"`
	DefaultFormat  string   `json:"defaultFormat"`
	DefaultQuality int      `json:"defaultQuality"`
}

// RecordingCapability describes one recording mechanism and its contract.
type RecordingCapability struct {
	Mechanism        string                     `json:"mechanism"`
	Scope            string                     `json:"scope"`
	Modes            []string                   `json:"modes"`
	Audio            bool                       `json:"audio"`
	Codecs           []RecordingCodecCapability `json:"codecs"`
	ConcurrencyLimit int                        `json:"concurrencyLimit"`
	CDP              *CDPRecordingCapability    `json:"cdp,omitempty"`
}

// Capabilities describe configuration-dependent behavior for a browser session.
type Capabilities struct {
	State     string               `json:"state"`
	LiveView  LiveViewCapability   `json:"liveView"`
	Recording *RecordingCapability `json:"recording,omitempty"`
}

// BrowserConfiguration is one concrete channel and browser-mode choice.
type BrowserConfiguration struct {
	Channel      string       `json:"channel"`
	Mode         string       `json:"mode"`
	Capabilities Capabilities `json:"capabilities"`
}

// LaunchPlan is the single resolved input used to launch and route a session.
type LaunchPlan struct {
	Channel               Channel
	Mode                  string
	Capabilities          Capabilities
	CompositorEnabled     bool
	MediaProducerEnabled  bool
	TargetRegistryEnabled bool
	RecordingMechanism    string
}

// ResolveLaunchPlan resolves persisted browser choices against this deployment.
func (r *Registry) ResolveLaunchPlan(channelName string, mode string) (LaunchPlan, error) {
	channel, err := r.Resolve(channelName)
	if err != nil {
		return LaunchPlan{}, err
	}

	mode = strings.ToLower(strings.TrimSpace(mode))
	if mode == "" {
		mode = BrowserModeHeaded
	}
	if mode != BrowserModeHeaded && mode != BrowserModeHeadless {
		return LaunchPlan{}, fmt.Errorf("%w: %q", ErrInvalidBrowserMode, mode)
	}
	if !slices.Contains(r.allowedModes, mode) {
		return LaunchPlan{}, fmt.Errorf("%w: mode %q is not allowed", ErrBrowserConfigurationUnavailable, mode)
	}

	plan := LaunchPlan{
		Channel:               channel,
		Mode:                  mode,
		TargetRegistryEnabled: true,
		Capabilities: Capabilities{
			State:    CapabilityStateProspective,
			LiveView: LiveViewCapability{Transports: []string{LiveViewTransportCDP}},
		},
	}

	switch mode {
	case BrowserModeHeaded:
		if !r.cfg.WebRTCCompositorEnabled || strings.TrimSpace(r.cfg.WebRTCCompositorBackend) != "pipewire" || !isApertureCompositorShell(r.cfg.WebRTCCompositorShell) {
			if r.implicitModes {
				return plan, nil
			}
			return LaunchPlan{}, fmt.Errorf("%w: headed mode requires the Aperture compositor shell and PipeWire backend", ErrBrowserConfigurationUnavailable)
		}
		plan.CompositorEnabled = true
		plan.MediaProducerEnabled = r.cfg.WebRTCMediaProducerEnabled
		if plan.MediaProducerEnabled {
			plan.Capabilities.LiveView.Transports = []string{LiveViewTransportWebRTC, LiveViewTransportCDP}
		}
		if strings.TrimSpace(r.cfg.WebRTCMediaProducerGSTExecutable) != "" {
			plan.RecordingMechanism = RecordingMechanismCompositor
			plan.Capabilities.Recording = recordingCapability(r.cfg, RecordingMechanismCompositor)
		}
	case BrowserModeHeadless:
		if strings.TrimSpace(r.cfg.WebRTCMediaProducerGSTExecutable) != "" {
			plan.RecordingMechanism = RecordingMechanismCDP
			plan.Capabilities.Recording = recordingCapability(r.cfg, RecordingMechanismCDP)
		}
	}

	return plan, nil
}

// Configurations returns every launchable browser configuration in stable order.
func (r *Registry) Configurations() []BrowserConfiguration {
	configurations := make([]BrowserConfiguration, 0, len(r.channels)*len(r.allowedModes))
	for _, channel := range r.Names() {
		for _, mode := range r.allowedModes {
			plan, err := r.ResolveLaunchPlan(channel, mode)
			if err != nil {
				continue
			}
			configurations = append(configurations, BrowserConfiguration{
				Channel:      channel,
				Mode:         mode,
				Capabilities: plan.Capabilities,
			})
		}
	}
	return configurations
}

func recordingCapability(cfg config.Config, mechanism string) *RecordingCapability {
	codecs := []RecordingCodecCapability{{Codec: "vp8", MediaType: "video/webm"}}
	if strings.EqualFold(strings.TrimSpace(cfg.GPUMode), config.GPUModeHardware) || strings.EqualFold(strings.TrimSpace(cfg.WebRTCMediaProducerCodec), config.WebRTCMediaProducerCodecH264) {
		codecs = append(codecs, RecordingCodecCapability{Codec: "h264-va", MediaType: "video/x-matroska"})
	}
	capability := &RecordingCapability{
		Mechanism:        mechanism,
		Scope:            "window",
		Modes:            []string{"tab", "viewer"},
		Audio:            false,
		Codecs:           codecs,
		ConcurrencyLimit: wrapperRecordingCapacity,
	}
	if mechanism == RecordingMechanismCDP {
		capability.Scope = "page"
		capability.CDP = &CDPRecordingCapability{
			Formats:        []string{"jpeg", "png"},
			DefaultFormat:  "jpeg",
			DefaultQuality: 80,
		}
	}
	return capability
}

// CapabilitiesFromRuntime reports the capabilities selected for a running wrapper.
func CapabilitiesFromRuntime(values RuntimeEnvValues) Capabilities {
	capabilities := Capabilities{
		State:    CapabilityStateActive,
		LiveView: LiveViewCapability{Transports: []string{LiveViewTransportCDP}},
	}
	if values.MediaProducerEnabled {
		capabilities.LiveView.Transports = []string{LiveViewTransportWebRTC, LiveViewTransportCDP}
	}
	if values.RecordingMechanism == "" {
		return capabilities
	}
	codecs := []RecordingCodecCapability{{Codec: "vp8", MediaType: "video/webm"}}
	if values.GPUMode == config.GPUModeHardware {
		codecs = append(codecs, RecordingCodecCapability{Codec: "h264-va", MediaType: "video/x-matroska"})
	}
	capabilities.Recording = &RecordingCapability{
		Mechanism:        values.RecordingMechanism,
		Scope:            "window",
		Modes:            []string{"tab", "viewer"},
		Audio:            false,
		Codecs:           codecs,
		ConcurrencyLimit: wrapperRecordingCapacity,
	}
	if values.RecordingMechanism == RecordingMechanismCDP {
		capabilities.Recording.Scope = "page"
		capabilities.Recording.CDP = &CDPRecordingCapability{
			Formats:        []string{"jpeg", "png"},
			DefaultFormat:  "jpeg",
			DefaultQuality: 80,
		}
	}
	return capabilities
}

func isApertureCompositorShell(value string) bool {
	switch strings.TrimSpace(value) {
	case "aperture", "aperture-weston-shell.so":
		return true
	default:
		return false
	}
}

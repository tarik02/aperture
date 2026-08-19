package browser

import (
	"fmt"
	"slices"
	"strings"

	"github.com/aperture/aperture/internal/config"
)

// Channel describes a resolved browser channel from the server registry.
type Channel struct {
	Name        string
	Executable  string
	DefaultArgs []string
}

// Registry resolves configured browser channel names to trusted executables.
type Registry struct {
	cfg           config.Config
	channels      map[string]config.ChannelConfig
	allowedModes  []string
	implicitModes bool
}

// NewRegistry builds a channel registry from validated configuration.
func NewRegistry(cfg config.Config) (*Registry, error) {
	if len(cfg.ChannelRegistry) == 0 {
		return nil, fmt.Errorf("channels must include at least one browser channel")
	}

	channels := make(map[string]config.ChannelConfig, len(cfg.ChannelRegistry))
	for name, channel := range cfg.ChannelRegistry {
		trimmed := strings.TrimSpace(name)
		if trimmed == "" {
			return nil, ErrInvalidChannel
		}
		if strings.TrimSpace(channel.Executable) == "" {
			return nil, fmt.Errorf("channels.%s.executable is required", trimmed)
		}
		if err := ValidateBrowserArgs(channel.DefaultArgs); err != nil {
			return nil, fmt.Errorf("channels.%s.default_args: %w", trimmed, err)
		}
		channels[trimmed] = channel
	}

	implicitModes := len(cfg.AllowedBrowserModes) == 0
	allowedModes := make([]string, 0, len(cfg.AllowedBrowserModes))
	for _, mode := range cfg.AllowedBrowserModes {
		mode = strings.ToLower(strings.TrimSpace(mode))
		if mode == "" {
			continue
		}
		allowedModes = append(allowedModes, mode)
	}
	if len(allowedModes) == 0 {
		allowedModes = []string{BrowserModeHeaded}
	}
	slices.Sort(allowedModes)

	return &Registry{cfg: cfg, channels: channels, allowedModes: allowedModes, implicitModes: implicitModes}, nil
}

// Resolve returns the configured channel for name.
func (r *Registry) Resolve(name string) (Channel, error) {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return Channel{}, ErrInvalidChannel
	}

	channel, ok := r.channels[trimmed]
	if !ok {
		return Channel{}, fmt.Errorf("%w: %q", ErrUnknownChannel, trimmed)
	}

	return Channel{
		Name:        trimmed,
		Executable:  channel.Executable,
		DefaultArgs: append([]string(nil), channel.DefaultArgs...),
	}, nil
}

// Names returns configured channel names in stable order.
func (r *Registry) Names() []string {
	names := make([]string, 0, len(r.channels))
	for name := range r.channels {
		names = append(names, name)
	}
	slices.Sort(names)
	return names
}

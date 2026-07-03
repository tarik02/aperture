package browser

import (
	"errors"
	"testing"

	"github.com/aperture/aperture/internal/config"
)

func TestRegistryResolveConfiguredChannel(t *testing.T) {
	t.Parallel()

	cfg := config.Config{
		ChannelRegistry: map[string]config.ChannelConfig{
			"chromium": {
				Executable:  "/usr/bin/chromium",
				DefaultArgs: []string{"--no-first-run"},
			},
		},
	}

	registry, err := NewRegistry(cfg)
	if err != nil {
		t.Fatalf("NewRegistry() error = %v", err)
	}

	channel, err := registry.Resolve("chromium")
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	if channel.Executable != "/usr/bin/chromium" {
		t.Fatalf("executable = %q", channel.Executable)
	}
	if len(channel.DefaultArgs) != 1 || channel.DefaultArgs[0] != "--no-first-run" {
		t.Fatalf("default args = %#v", channel.DefaultArgs)
	}
}

func TestRegistryRejectsUnknownChannel(t *testing.T) {
	t.Parallel()

	registry, err := NewRegistry(config.Config{
		ChannelRegistry: map[string]config.ChannelConfig{
			"chromium": {Executable: "/usr/bin/chromium"},
		},
	})
	if err != nil {
		t.Fatalf("NewRegistry() error = %v", err)
	}

	if _, err := registry.Resolve("firefox"); !errors.Is(err, ErrUnknownChannel) {
		t.Fatalf("expected unknown channel error, got %v", err)
	}
}

func TestRegistryRejectsEmptyName(t *testing.T) {
	t.Parallel()

	registry, err := NewRegistry(config.Config{
		ChannelRegistry: map[string]config.ChannelConfig{
			"chromium": {Executable: "/usr/bin/chromium"},
		},
	})
	if err != nil {
		t.Fatalf("NewRegistry() error = %v", err)
	}

	if _, err := registry.Resolve("  "); !errors.Is(err, ErrInvalidChannel) {
		t.Fatalf("expected invalid channel error, got %v", err)
	}
}

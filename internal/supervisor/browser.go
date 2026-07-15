package supervisor

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/aperture/aperture/internal/browser"
	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/paths"
	"github.com/aperture/aperture/internal/systemd"
)

type browserBackend interface {
	Start(context.Context, string) error
	Stop(context.Context, string) error
	IsActive(context.Context, string) (bool, error)
	ListActiveSessionIDs(context.Context) ([]string, error)
	Close(context.Context) error
}

// Browser supervises browser runtime environments and processes.
type Browser struct {
	cfg     config.Config
	backend browserBackend
}

// NewBrowser constructs a browser supervisor.
func NewBrowser(cfg config.Config, runner systemd.CommandRunner) (*Browser, error) {
	var backend browserBackend
	switch strings.ToLower(strings.TrimSpace(cfg.BrowserSupervisor)) {
	case config.BrowserSupervisorDirect:
		direct, err := newDirectBackend(cfg)
		if err != nil {
			return nil, err
		}
		backend = direct
	case config.BrowserSupervisorSystemd:
		adapter, err := systemd.NewUserAdapter(cfg)
		if err != nil {
			return nil, err
		}
		backend = &systemdBackend{adapter: adapter, runner: runner}
	default:
		return nil, fmt.Errorf("unsupported browser supervisor: %s", cfg.BrowserSupervisor)
	}
	return &Browser{cfg: cfg, backend: backend}, nil
}

// PrepareRuntime writes Chromium preferences and the runtime env file for a session.
func (b *Browser) PrepareRuntime(values browser.RuntimeEnvValues) error {
	layout, err := paths.Session(b.cfg, values.SessionID)
	if err != nil {
		return fmt.Errorf("derive session paths: %w", err)
	}

	if err := browser.WriteProfilePreferences(values.MergedUserDataDir, values.DownloadsDir); err != nil {
		return fmt.Errorf("write chromium preferences: %w", err)
	}

	if err := browser.WriteRuntimeEnv(layout.RuntimeEnv, values); err != nil {
		return fmt.Errorf("write runtime env: %w", err)
	}

	return nil
}

// Start starts the browser process for sessionID.
func (b *Browser) Start(ctx context.Context, sessionID string) error {
	if err := b.backend.Start(ctx, sessionID); err != nil {
		return &BrowserSupervisorError{
			SessionID: sessionID,
			Operation: "start",
			Err:       err,
		}
	}
	return nil
}

// Stop stops the browser process for sessionID.
func (b *Browser) Stop(ctx context.Context, sessionID string) error {
	if err := b.backend.Stop(ctx, sessionID); err != nil {
		return &BrowserSupervisorError{
			SessionID: sessionID,
			Operation: "stop",
			Err:       err,
		}
	}
	return nil
}

// IsActive reports whether the browser process is active.
func (b *Browser) IsActive(ctx context.Context, sessionID string) (bool, error) {
	return b.backend.IsActive(ctx, sessionID)
}

// RemoveRuntimeEnv deletes the runtime env file for a session.
func (b *Browser) RemoveRuntimeEnv(sessionID string) error {
	layout, err := paths.Session(b.cfg, sessionID)
	if err != nil {
		return fmt.Errorf("derive session paths: %w", err)
	}
	if layout.RuntimeEnv == "" {
		return nil
	}
	if err := os.Remove(layout.RuntimeEnv); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove runtime env: %w", err)
	}
	return nil
}

// RuntimeEnvPath returns the runtime env path for a session.
func (b *Browser) RuntimeEnvPath(sessionID string) (string, error) {
	layout, err := paths.Session(b.cfg, sessionID)
	if err != nil {
		return "", err
	}
	return layout.RuntimeEnv, nil
}

// ListActiveSessionIDs returns session ids with active browser processes.
func (b *Browser) ListActiveSessionIDs(ctx context.Context) ([]string, error) {
	return b.backend.ListActiveSessionIDs(ctx)
}

// Close stops browser processes owned by this supervisor.
func (b *Browser) Close(ctx context.Context) error { return b.backend.Close(ctx) }

// RuntimeEnvExists reports whether the runtime env file exists for a session.
func (b *Browser) RuntimeEnvExists(sessionID string) (bool, error) {
	path, err := b.RuntimeEnvPath(sessionID)
	if err != nil {
		return false, err
	}
	_, err = os.Stat(path)
	if err == nil {
		return true, nil
	}
	if os.IsNotExist(err) {
		return false, nil
	}
	return false, err
}

type systemdBackend struct {
	adapter *systemd.UserAdapter
	runner  systemd.CommandRunner
}

func (b *systemdBackend) Start(ctx context.Context, sessionID string) error {
	return b.adapter.Start(ctx, b.runner, sessionID)
}

func (b *systemdBackend) Stop(ctx context.Context, sessionID string) error {
	return b.adapter.Stop(ctx, b.runner, sessionID)
}

func (b *systemdBackend) IsActive(ctx context.Context, sessionID string) (bool, error) {
	return b.adapter.IsActive(ctx, b.runner, sessionID)
}

func (b *systemdBackend) ListActiveSessionIDs(ctx context.Context) ([]string, error) {
	return b.adapter.ListActiveInstances(ctx, b.runner)
}

func (b *systemdBackend) Close(context.Context) error { return nil }

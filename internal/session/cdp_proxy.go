package session

import (
	"context"
	"os"

	"github.com/aperture/aperture/internal/browser"
	"github.com/aperture/aperture/internal/db"
)

// RunningCDPPort returns the loopback CDP port for a tenant-owned running session.
func (s *Service) RunningCDPPort(ctx context.Context, tenantID, sessionID string) (int, error) {
	sessionRow, err := s.requireTenantSession(ctx, tenantID, sessionID)
	if err != nil {
		return 0, err
	}
	if sessionRow.Status != db.SessionStatusRunning {
		return 0, ErrNotRunning
	}
	if sessionRow.CurrentCDPPort == nil || *sessionRow.CurrentCDPPort <= 0 {
		return 0, ErrNotRunning
	}
	return *sessionRow.CurrentCDPPort, nil
}

// RunningWrapperPort returns the loopback browser-session-wrapper API port for a tenant-owned running session.
func (s *Service) RunningWrapperPort(ctx context.Context, tenantID, sessionID string) (int, error) {
	sessionRow, err := s.requireTenantSession(ctx, tenantID, sessionID)
	if err != nil {
		return 0, err
	}
	if sessionRow.Status != db.SessionStatusRunning || sessionRow.RuntimeEnvPath == nil {
		return 0, ErrNotRunning
	}
	body, err := os.ReadFile(*sessionRow.RuntimeEnvPath)
	if err != nil {
		return 0, err
	}
	values, err := browser.ParseRuntimeEnv(body)
	if err != nil {
		return 0, err
	}
	if values.WrapperPort <= 0 {
		return 0, ErrNotRunning
	}
	return values.WrapperPort, nil
}

// ValidateLiveSessionForwardAuth confirms a tenant-owned live session still exists.
func (s *Service) ValidateLiveSessionForwardAuth(ctx context.Context, tenantID, sessionID string) error {
	_, release, err := s.AcquireWrapperPort(ctx, tenantID, sessionID)
	if err != nil {
		return err
	}
	release()
	return nil
}

// RunningCDPToken returns the stored CDP token for a tenant-owned running session.
func (s *Service) RunningCDPToken(ctx context.Context, tenantID, sessionID string) (string, error) {
	sessionRow, err := s.requireTenantSession(ctx, tenantID, sessionID)
	if err != nil {
		return "", err
	}
	if !retainedCDPAvailable(sessionRow.Status) {
		return "", ErrNotRunning
	}
	return s.loadCDPToken(ctx, sessionID)
}

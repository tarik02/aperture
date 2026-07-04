package session

import (
	"context"

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

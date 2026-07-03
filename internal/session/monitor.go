package session

import (
	"context"
	"time"

	"github.com/aperture/aperture/internal/db"
	"go.uber.org/zap"
)

// Monitor periodically refreshes leases for active running sessions.
type Monitor struct {
	service  *Service
	logger   *zap.Logger
	interval time.Duration
}

// NewMonitor constructs a running-session monitor.
func NewMonitor(service *Service, logger *zap.Logger) *Monitor {
	return &Monitor{
		service:  service,
		logger:   logger,
		interval: service.MonitorInterval(),
	}
}

// Run executes the monitor loop until ctx is canceled.
func (m *Monitor) Run(ctx context.Context) {
	ticker := time.NewTicker(m.interval)
	defer ticker.Stop()

	m.tick(ctx)

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.tick(ctx)
		}
	}
}

func (m *Monitor) tick(ctx context.Context) {
	sessions, err := m.service.repo.ListSessionsByStatus(ctx, db.SessionStatusRunning)
	if err != nil {
		m.logger.Error("list running sessions", zap.Error(err))
		return
	}

	for _, sessionRow := range sessions {
		active, err := m.service.browser.IsActive(ctx, sessionRow.ID)
		if err != nil {
			m.logger.Error("check browser unit", zap.String("sessionId", sessionRow.ID), zap.Error(err))
			continue
		}
		if !active {
			if err := m.service.markFailedRetained(ctx, &sessionRow, "browser unit became inactive", nil); err != nil {
				m.logger.Error("mark failed session", zap.String("sessionId", sessionRow.ID), zap.Error(err))
			}
			continue
		}

		now := m.service.now().UTC()
		expiresAt := now.Add(time.Duration(m.service.cfg.SessionRetentionDays) * 24 * time.Hour).Format(time.RFC3339Nano)
		sessionRow.ExpiresAt = expiresAt
		if err := m.service.repo.UpdateSession(ctx, &sessionRow); err != nil {
			m.logger.Error("refresh session lease", zap.String("sessionId", sessionRow.ID), zap.Error(err))
		}
	}
}

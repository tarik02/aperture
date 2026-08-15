package session

import (
	"context"
	"time"

	"github.com/aperture/aperture/internal/db"
	"go.uber.org/zap"
)

// Monitor periodically refreshes leases for active running sessions.
type Monitor struct {
	service       *Service
	logger        *zap.Logger
	interval      time.Duration
	activeChecker func() (bool, error)
}

// NewMonitor constructs a running-session monitor.
func NewMonitor(service *Service, logger *zap.Logger) *Monitor {
	return &Monitor{
		service:  service,
		logger:   logger,
		interval: service.MonitorInterval(),
	}
}

// SetActiveChecker configures ownership checks before each monitor tick.
func (m *Monitor) SetActiveChecker(checker func() (bool, error)) {
	m.activeChecker = checker
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
	if m.activeChecker != nil {
		active, err := m.activeChecker()
		if err != nil {
			m.logger.Error("check deployment role", zap.Error(err))
			return
		}
		if !active {
			m.logger.Debug("skip session monitor tick on inactive api")
			return
		}
	}

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
		if isExpired(sessionRow.ExpiresAt, now) {
			continue
		}
		expiresAt := now.Add(time.Duration(m.service.cfg.SessionRetentionDays) * 24 * time.Hour).Format(time.RFC3339Nano)
		if err := m.service.repo.RefreshRunningSessionExpiry(ctx, sessionRow.ID, expiresAt); err != nil {
			m.logger.Error("refresh session lease", zap.String("sessionId", sessionRow.ID), zap.Error(err))
		}
	}

	suspended, err := m.service.SuspendIdleSessions(ctx)
	if err != nil {
		m.logger.Error("suspend idle sessions", zap.Error(err))
		return
	}
	if suspended > 0 {
		m.logger.Info("suspended idle sessions", zap.Int("count", suspended))
	}
}

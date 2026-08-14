package session

import (
	"context"
	"sync"
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
	runWG         sync.WaitGroup
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
	m.runWG.Add(1)
	m.loop(ctx)
}

// Start registers the monitor before launching its loop, making Wait safe immediately.
func (m *Monitor) Start(ctx context.Context) {
	m.start(ctx)
}

func (m *Monitor) start(ctx context.Context) {
	m.runWG.Add(1)
	go m.loop(ctx)
}

func (m *Monitor) loop(ctx context.Context) {
	defer m.runWG.Done()
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

// Wait blocks until the monitor loop and any in-progress tick have stopped.
func (m *Monitor) Wait() { m.runWG.Wait() }

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

	if len(sessions) > 0 {
		activeSessionIDs, err := m.service.browser.ListActiveSessionIDs(ctx)
		if err != nil {
			m.logger.Error("list active browser units", zap.Error(err))
		} else {
			active := make(map[string]struct{}, len(activeSessionIDs))
			for _, sessionID := range activeSessionIDs {
				active[sessionID] = struct{}{}
			}

			now := m.service.now().UTC()
			refreshGenerations := make([]db.SessionGeneration, 0, len(sessions))
			for _, sessionRow := range sessions {
				if _, ok := active[sessionRow.ID]; !ok {
					activeAfterRecheck, err := m.revalidateAndFailInactiveSession(ctx, sessionRow.ID, sessionRow.StartedAt, now)
					if err != nil {
						m.logger.Error("revalidate inactive session", zap.String("sessionId", sessionRow.ID), zap.Error(err))
					}
					if activeAfterRecheck {
						refreshGenerations = append(refreshGenerations, db.SessionGeneration{ID: sessionRow.ID, StartedAt: sessionRow.StartedAt})
					}
					continue
				}

				if !isExpired(sessionRow.ExpiresAt, now) {
					refreshGenerations = append(refreshGenerations, db.SessionGeneration{ID: sessionRow.ID, StartedAt: sessionRow.StartedAt})
				}
			}

			refreshNow := m.service.now().UTC()
			refreshNowText := refreshNow.Format(time.RFC3339Nano)
			refreshExpiresAt := refreshNow.Add(time.Duration(m.service.cfg.SessionRetentionDays) * 24 * time.Hour).Format(time.RFC3339Nano)
			if err := m.service.repo.RefreshRunningSessionExpiries(ctx, refreshGenerations, refreshNowText, refreshExpiresAt); err != nil {
				m.logger.Error("refresh session leases", zap.Int("count", len(refreshGenerations)), zap.Error(err))
			}
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

func (m *Monitor) revalidateAndFailInactiveSession(ctx context.Context, sessionID string, startedAt *string, _ time.Time) (bool, error) {
	unlock := m.service.repo.LockSession(sessionID)
	defer unlock()

	sessionRow, err := m.service.repo.GetSessionByID(ctx, sessionID)
	if err != nil {
		return false, err
	}
	if sessionRow == nil || sessionRow.Status != db.SessionStatusRunning {
		return false, nil
	}
	if (sessionRow.StartedAt == nil) != (startedAt == nil) || (startedAt != nil && *sessionRow.StartedAt != *startedAt) {
		return false, nil
	}

	if err := m.service.markFailedRetainedLocked(ctx, sessionRow, "browser unit became inactive", nil); err != nil {
		return false, err
	}
	return false, nil
}

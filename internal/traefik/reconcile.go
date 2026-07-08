package traefik

import (
	"context"
	"fmt"

	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/db"
)

// Reconciler regenerates Traefik dynamic configuration from current state.
type Reconciler interface {
	Reconcile(ctx context.Context) error
}

// Service renders and writes Traefik dynamic configuration.
type Service struct {
	cfg  config.Config
	repo *db.Repository
}

// NewService constructs a Traefik reconciler.
func NewService(cfg config.Config, repo *db.Repository) *Service {
	return &Service{cfg: cfg, repo: repo}
}

// Reconcile regenerates dynamic Traefik routes for sessions that can wake through CDP.
func (s *Service) Reconcile(ctx context.Context) error {
	sessions, err := s.repo.ListSessionsByStatuses(ctx, []string{
		db.SessionStatusRunning,
		db.SessionStatusSuspended,
	})
	if err != nil {
		return fmt.Errorf("list cdp-routable sessions: %w", err)
	}

	content, err := RenderDynamicConfig(s.cfg, CDPRoutableSessionsFromDB(sessions))
	if err != nil {
		return err
	}
	if err := WriteAtomic(s.cfg.TraefikDynamicConfigPath, content); err != nil {
		return fmt.Errorf("%w: %w", ErrWrite, err)
	}
	return nil
}

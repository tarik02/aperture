package traefik

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/db"
	"github.com/aperture/aperture/internal/deploystate"
)

// Reconciler regenerates Traefik dynamic configuration from current state.
type Reconciler interface {
	Reconcile(ctx context.Context) error
}

// Service renders and writes Traefik dynamic configuration.
type Service struct {
	cfg    config.Config
	repo   *db.Repository
	deploy *deploystate.Service
}

// NewService constructs a Traefik reconciler.
func NewService(cfg config.Config, repo *db.Repository) *Service {
	return &Service{cfg: cfg, repo: repo, deploy: deploystate.New(cfg)}
}

// Reconcile regenerates dynamic Traefik routes for running sessions.
func (s *Service) Reconcile(ctx context.Context) error {
	state, err := s.loadState()
	if err != nil {
		return err
	}
	if deploystate.Role(state, s.cfg.DeployColor) != deploystate.RoleActive {
		return nil
	}

	sessions, err := s.repo.ListSessionsByStatus(ctx, db.SessionStatusRunning)
	if err != nil {
		return fmt.Errorf("list running sessions: %w", err)
	}

	running := RunningSessionsFromDB(sessions)
	if len(running) == 0 {
		if err := os.Remove(SessionsConfigPath(s.cfg)); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("%w: %w", ErrWrite, err)
		}
		return nil
	}

	content, err := RenderSessionsConfig(s.cfg, state, running)
	if err != nil {
		return err
	}
	if err := WriteAtomic(SessionsConfigPath(s.cfg), content); err != nil {
		return fmt.Errorf("%w: %w", ErrWrite, err)
	}
	return nil
}

// WriteEdgeConfig renders the API edge route into edge.yaml.
func WriteEdgeConfig(cfg config.Config, deploy *deploystate.Service) error {
	state, err := loadStateOrDefault(cfg, deploy)
	if err != nil {
		return err
	}
	content, err := RenderEdgeConfig(cfg, state)
	if err != nil {
		return err
	}
	if err := WriteAtomic(EdgeConfigPath(cfg), content); err != nil {
		return fmt.Errorf("%w: %w", ErrWrite, err)
	}
	return nil
}

// EdgeConfigPath returns the deploy-owned dynamic edge config path.
func EdgeConfigPath(cfg config.Config) string {
	return filepath.Join(cfg.TraefikDynamicConfigDir, "edge.yaml")
}

// SessionsConfigPath returns the active API-owned dynamic session config path.
func SessionsConfigPath(cfg config.Config) string {
	return filepath.Join(cfg.TraefikDynamicConfigDir, "sessions.yaml")
}

func (s *Service) loadState() (deploystate.State, error) {
	return loadStateOrDefault(s.cfg, s.deploy)
}

func loadStateOrDefault(cfg config.Config, deploy *deploystate.Service) (deploystate.State, error) {
	state, err := deploy.Load()
	if err == nil {
		return state, nil
	}
	if !os.IsNotExist(err) {
		return deploystate.State{}, err
	}
	return deploystate.State{
		ActiveColor:   cfg.DeployColor,
		BlueURL:       cfg.DeployBlueURL,
		GreenURL:      cfg.DeployGreenURL,
		ActiveVersion: cfg.DeployVersion,
		UpdatedAt:     "1970-01-01T00:00:00Z",
	}, nil
}

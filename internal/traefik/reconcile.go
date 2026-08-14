package traefik

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/db"
	"github.com/aperture/aperture/internal/deploystate"
)

// Reconciler regenerates Traefik dynamic configuration from current state.
type Reconciler interface {
	Reconcile(ctx context.Context) error
	ReconcileRequired(ctx context.Context) error
}

// Service renders and writes Traefik dynamic configuration.
type Service struct {
	cfg          config.Config
	repo         *db.Repository
	deploy       *deploystate.Service
	lifecycleCtx context.Context

	mu           sync.Mutex
	reconcileRun *reconcileRun
}

type reconcileRun struct {
	done                  chan struct{}
	pending               bool
	pendingBeforeSnapshot bool
	forceFollowup         bool
	snapshotStarted       bool
	snapshotDone          bool
	publicationDone       bool
	err                   error
}

// NewService constructs a Traefik reconciler.
func NewService(cfg config.Config, repo *db.Repository) *Service {
	return NewServiceWithContext(cfg, repo, context.Background())
}

// NewServiceWithContext constructs a reconciler bound to the service lifecycle.
func NewServiceWithContext(cfg config.Config, repo *db.Repository, lifecycleCtx context.Context) *Service {
	return &Service{cfg: cfg, repo: repo, deploy: deploystate.New(cfg), lifecycleCtx: lifecycleCtx}
}

// Reconcile regenerates dynamic Traefik routes for sessions that can wake through CDP.
func (s *Service) Reconcile(ctx context.Context) error {
	return s.reconcile(ctx, false)
}

// ReconcileRequired performs the bounded startup cleanup pass even when the
// normal service lifecycle has already been canceled.
func (s *Service) ReconcileRequired(ctx context.Context) error {
	return s.reconcile(ctx, true)
}

func (s *Service) reconcile(ctx context.Context, required bool) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !required {
		if err := s.lifecycleCtx.Err(); err != nil {
			return err
		}
	}
	passBase := s.lifecycleCtx
	if required {
		passBase = ctx
	}
	if err := passBase.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	if run := s.reconcileRun; run != nil {
		if !run.snapshotStarted {
			run.pending = true
			run.pendingBeforeSnapshot = true
		} else if !run.snapshotDone {
			// The in-flight snapshot is authoritative for callers queued before
			// it completes; keep them in this batch instead of forcing another
			// SQL pass.
			run.pending = true
			run.pendingBeforeSnapshot = true
		} else if !run.publicationDone {
			run.pending = true
			run.forceFollowup = true
		} else {
			// Publication has completed but the leader has not closed the run
			// yet. Such a caller may represent a later DB commit and must wake a
			// follow-up atomically with the run's final state transition.
			run.pending = true
			run.forceFollowup = true
		}
		done := run.done
		s.mu.Unlock()
		select {
		case <-done:
			return run.err
		case <-ctx.Done():
			return ctx.Err()
		}
	}

	run := &reconcileRun{done: make(chan struct{})}
	s.reconcileRun = run
	s.mu.Unlock()
	reconcileCtx, cancel := context.WithCancel(passBase)
	stopCaller := context.AfterFunc(ctx, cancel)
	defer func() {
		stopCaller()
		cancel()
	}()

	// Keep the leader's first error, but let queued callers observe the final follow-up result.
	var firstErr error
	for passCtx := reconcileCtx; ; {
		s.mu.Lock()
		run.snapshotStarted = false
		run.snapshotDone = false
		run.publicationDone = false
		s.mu.Unlock()
		err := s.reconcileOnce(passCtx)
		if err != nil && firstErr == nil {
			firstErr = err
		}

		s.mu.Lock()
		if run.pendingBeforeSnapshot && run.snapshotDone && run.publicationDone && !run.forceFollowup {
			run.pending = false
		}
		if !run.pending {
			run.err = err
			s.reconcileRun = nil
			close(run.done)
			s.mu.Unlock()
			if firstErr != nil {
				return firstErr
			}
			return err
		}
		run.pending = false
		run.pendingBeforeSnapshot = false
		run.forceFollowup = false
		run.snapshotStarted = false
		run.snapshotDone = false
		run.publicationDone = false
		s.mu.Unlock()
		// A queued caller represents a committed state change, but its context must
		// not control the shared retry. Use the service lifecycle context so shutdown
		// cancels the retry without allowing a detached mutation after shutdown.
		if err := passBase.Err(); err != nil {
			s.mu.Lock()
			run.err = firstErr
			if run.err == nil {
				run.err = err
			}
			s.reconcileRun = nil
			close(run.done)
			s.mu.Unlock()
			return firstErr
		}
		passCtx = s.lifecycleCtx
	}
}

func (s *Service) reconcileOnce(ctx context.Context) (resultErr error) {
	lock, err := deploystate.AcquireLock(ctx, s.cfg.DeployStatePath)
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, lock.Close()) }()

	state, err := s.loadState()
	if err != nil {
		return err
	}
	if deploystate.Role(state, s.cfg.DeployColor) != deploystate.RoleActive {
		return nil
	}

	s.mu.Lock()
	if s.reconcileRun != nil {
		s.reconcileRun.snapshotStarted = true
	}
	s.mu.Unlock()
	sessions, err := s.repo.ListSessionsByStatuses(ctx, []string{
		db.SessionStatusRunning,
		db.SessionStatusSuspended,
	})
	if err != nil {
		return fmt.Errorf("list cdp-routable sessions: %w", err)
	}
	s.mu.Lock()
	if s.reconcileRun != nil {
		s.reconcileRun.snapshotDone = true
	}
	s.mu.Unlock()

	running := RunningSessionsFromDB(sessions)
	if len(running) == 0 {
		owned, err := s.ownsActiveDeployment()
		if err != nil {
			return err
		}
		if !owned {
			s.markPublicationDone()
			return nil
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		s.markPublicationStarted()
		if err := os.Remove(SessionsConfigPath(s.cfg)); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("%w: %w", ErrWrite, err)
		}
		s.markPublicationDone()
		return nil
	}

	content, err := RenderSessionsConfig(s.cfg, state, running)
	if err != nil {
		return err
	}
	owned, err := s.ownsActiveDeployment()
	if err != nil {
		return err
	}
	if !owned {
		s.markPublicationDone()
		return nil
	}
	s.markPublicationStarted()
	if _, err := WriteAtomicIfChangedContext(ctx, SessionsConfigPath(s.cfg), content); err != nil {
		return fmt.Errorf("%w: %w", ErrWrite, err)
	}
	s.markPublicationDone()
	return nil
}

func (s *Service) markPublicationStarted() {
	s.mu.Lock()
	if s.reconcileRun != nil {
		s.reconcileRun.publicationDone = false
	}
	s.mu.Unlock()
}

func (s *Service) markPublicationDone() {
	s.mu.Lock()
	if s.reconcileRun != nil {
		s.reconcileRun.publicationDone = true
	}
	s.mu.Unlock()
}

func (s *Service) ownsActiveDeployment() (bool, error) {
	state, err := s.loadState()
	if err != nil {
		return false, err
	}
	return deploystate.Role(state, s.cfg.DeployColor) == deploystate.RoleActive, nil
}

// WriteEdgeConfig renders the API edge route into edge.yaml.
func WriteEdgeConfig(cfg config.Config, deploy *deploystate.Service) error {
	return WriteEdgeConfigContext(context.Background(), cfg, deploy)
}

// WriteEdgeConfigContext publishes the active deployment edge route.
func WriteEdgeConfigContext(ctx context.Context, cfg config.Config, deploy *deploystate.Service) (resultErr error) {
	lock, err := deploystate.AcquireLock(ctx, cfg.DeployStatePath)
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, lock.Close()) }()

	state, err := loadStateOrDefault(cfg, deploy)
	if err != nil {
		return err
	}
	if deploystate.Role(state, cfg.DeployColor) != deploystate.RoleActive {
		return nil
	}
	return writeEdgeConfig(ctx, state, cfg)
}

// WriteEdgeConfigForState renders the API edge route for an explicit state into edge.yaml.
func WriteEdgeConfigForState(cfg config.Config, state deploystate.State) error {
	return WriteEdgeConfigForStateContext(context.Background(), cfg, state)
}

// WriteEdgeConfigForStateContext publishes an explicit state while honoring cancellation.
func WriteEdgeConfigForStateContext(ctx context.Context, cfg config.Config, state deploystate.State) (resultErr error) {
	lock, err := deploystate.AcquireLock(ctx, cfg.DeployStatePath)
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, lock.Close()) }()

	current, err := loadStateOrDefault(cfg, deploystate.New(cfg))
	if err != nil {
		return err
	}
	if deploystate.Role(current, cfg.DeployColor) != deploystate.RoleActive ||
		state.ActiveColor != current.ActiveColor ||
		state.BlueURL != current.BlueURL ||
		state.GreenURL != current.GreenURL ||
		state.ActiveVersion != current.ActiveVersion {
		return nil
	}
	return writeEdgeConfig(ctx, current, cfg)
}

func writeEdgeConfig(ctx context.Context, state deploystate.State, cfg config.Config) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	content, err := RenderEdgeConfig(cfg, state)
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if _, err := WriteAtomicIfChangedContext(ctx, EdgeConfigPath(cfg), content); err != nil {
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

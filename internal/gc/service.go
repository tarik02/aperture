package gc

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/db"
	"github.com/aperture/aperture/internal/ids"
	"github.com/aperture/aperture/internal/overlay"
	"github.com/aperture/aperture/internal/paths"
	"github.com/aperture/aperture/internal/session"
	"github.com/aperture/aperture/internal/supervisor"
	"github.com/aperture/aperture/internal/traefik"
)

// OverlayClient unmounts session overlays during expiry.
type OverlayClient interface {
	Unmount(ctx context.Context, sessionID string) error
}

// Service runs garbage collection for sessions and snapshots.
type Service struct {
	cfg          config.Config
	repo         *db.Repository
	browser      *supervisor.Browser
	overlay      OverlayClient
	traefik      traefik.Reconciler
	mediaCleaner session.MediaSessionCleaner
	now          func() time.Time
}

// NewService constructs a GC service.
func NewService(
	cfg config.Config,
	repo *db.Repository,
	browserSupervisor *supervisor.Browser,
	overlayClient OverlayClient,
	traefikReconciler traefik.Reconciler,
) *Service {
	if traefikReconciler == nil {
		traefikReconciler = traefik.NoopReconciler{}
	}
	return &Service{
		cfg:     cfg,
		repo:    repo,
		browser: browserSupervisor,
		overlay: overlayClient,
		traefik: traefikReconciler,
		now:     time.Now,
	}
}

// RunResult summarizes a GC pass.
type RunResult struct {
	ExpiredSessions    int
	RemovedArtifacts   int
	CollectedSnapshots int
}

// Run expires sessions and snapshots past retention.
func (s *Service) Run(ctx context.Context) (*RunResult, error) {
	result := &RunResult{}
	now := s.now().UTC()
	nowText := now.Format(time.RFC3339Nano)

	expiring, err := s.repo.ListSessionsExpiringBefore(ctx, nowText)
	if err != nil {
		return nil, err
	}
	for _, sessionRow := range expiring {
		if err := s.expireSession(ctx, &sessionRow, now); err != nil {
			return nil, err
		}
		result.ExpiredSessions++
	}

	artifactsCutoff := now.Add(-time.Duration(s.cfg.SessionRetentionDays) * 24 * time.Hour).Format(time.RFC3339Nano)
	artifactSessions, err := s.repo.ListSessionsWithExpiredArtifacts(ctx, artifactsCutoff)
	if err != nil {
		return nil, err
	}
	for _, sessionRow := range artifactSessions {
		if err := s.removeSessionArtifacts(&sessionRow); err != nil {
			return nil, err
		}
		result.RemovedArtifacts++
	}

	snapshots, err := s.repo.ListSnapshotsEligibleForGC(ctx, nowText)
	if err != nil {
		return nil, err
	}
	for _, snapshotRow := range snapshots {
		collected, err := s.collectSnapshot(ctx, &snapshotRow, now)
		if err != nil {
			return nil, err
		}
		if collected {
			result.CollectedSnapshots++
		}
	}

	if err := s.traefik.Reconcile(ctx); err != nil {
		return nil, err
	}
	return result, nil
}

func (s *Service) expireSession(ctx context.Context, sessionRow *db.Session, now time.Time) error {
	if err := session.RemoveMediaTokenHash(s.cfg, sessionRow.ID); err != nil {
		return fmt.Errorf("remove media token hash for session %s: %w", sessionRow.ID, err)
	}
	if s.mediaCleaner != nil {
		s.mediaCleaner.CloseSessionMedia(sessionRow.ID)
	}
	if sessionRow.Status == db.SessionStatusRunning {
		if err := s.browser.Stop(ctx, sessionRow.ID); err != nil {
			return err
		}
	}
	if err := s.browser.RemoveRuntimeEnv(sessionRow.ID); err != nil {
		return err
	}
	if err := s.ensureOverlayUnmounted(ctx, sessionRow); err != nil {
		return err
	}
	if err := session.RemoveCDPTokenSeal(s.cfg, sessionRow.ID); err != nil {
		return fmt.Errorf("remove cdp token seal for session %s: %w", sessionRow.ID, err)
	}

	if err := s.removeSessionOverlayState(sessionRow); err != nil {
		return err
	}

	expiredAt := now.Format(time.RFC3339Nano)
	sessionRow.Status = db.SessionStatusExpired
	sessionRow.ExpiredAt = &expiredAt
	sessionRow.RuntimeEnvPath = nil
	sessionRow.CurrentCDPPort = nil
	sessionRow.StoppedAt = &expiredAt
	if err := s.repo.UpdateSession(ctx, sessionRow); err != nil {
		return err
	}
	if s.mediaCleaner != nil {
		s.mediaCleaner.CloseSessionMedia(sessionRow.ID)
	}
	return nil
}

func (s *Service) ensureOverlayUnmounted(ctx context.Context, sessionRow *db.Session) error {
	merged := sessionRow.MergedPath
	if merged == "" {
		layout, err := paths.Session(s.cfg, sessionRow.ID)
		if err != nil {
			return &SessionOverlayUnmountError{SessionID: sessionRow.ID, Err: err}
		}
		merged = layout.Merged
	}

	mounted, err := overlay.IsMergedMounted(merged)
	if err != nil {
		return &SessionOverlayUnmountError{SessionID: sessionRow.ID, Err: err}
	}
	if !mounted {
		return nil
	}

	if err := s.overlay.Unmount(ctx, sessionRow.ID); err != nil {
		return &SessionOverlayUnmountError{SessionID: sessionRow.ID, Err: err}
	}

	mounted, err = overlay.IsMergedMounted(merged)
	if err != nil {
		return &SessionOverlayUnmountError{SessionID: sessionRow.ID, Err: err}
	}
	if mounted {
		return &SessionOverlayUnmountError{
			SessionID: sessionRow.ID,
			Err:       fmt.Errorf("overlay still mounted at %s", merged),
		}
	}
	return nil
}

func (s *Service) removeSessionOverlayState(sessionRow *db.Session) error {
	dirs := []string{
		sessionRow.UpperPath,
		sessionRow.WorkPath,
		sessionRow.MergedPath,
		sessionRow.DownloadsPath,
		sessionRow.CachePath,
		sessionRow.OverlayPath,
	}
	if layout, err := paths.Session(s.cfg, sessionRow.ID); err == nil {
		dirs = append(dirs, layout.Metadata)
	}
	seen := make(map[string]struct{}, len(dirs))
	for _, dir := range dirs {
		if dir == "" {
			continue
		}
		if _, ok := seen[dir]; ok {
			continue
		}
		seen[dir] = struct{}{}
		if err := os.RemoveAll(dir); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove session path %s: %w", dir, err)
		}
	}
	return nil
}

func (s *Service) removeSessionArtifacts(sessionRow *db.Session) error {
	if sessionRow.ArtifactsPath == "" {
		return nil
	}
	if err := os.RemoveAll(sessionRow.ArtifactsPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove session artifacts: %w", err)
	}
	return nil
}

// SetMediaSessionCleaner configures cleanup for in-memory media state.
func (s *Service) SetMediaSessionCleaner(cleaner session.MediaSessionCleaner) {
	s.mediaCleaner = cleaner
}

func (s *Service) collectSnapshot(ctx context.Context, snapshotRow *db.Snapshot, now time.Time) (bool, error) {
	count, err := s.repo.CountRetainedSessionsReferencingSnapshot(ctx, snapshotRow.ID)
	if err != nil {
		return false, err
	}
	if count > 0 {
		return false, nil
	}

	if err := ids.ValidateUUIDv7(snapshotRow.ID); err != nil {
		return false, err
	}
	layout, err := paths.Snapshot(s.cfg, snapshotRow.ID)
	if err != nil {
		return false, err
	}
	if err := os.RemoveAll(layout.Root); err != nil && !os.IsNotExist(err) {
		return false, fmt.Errorf("remove snapshot files: %w", err)
	}

	completedAt := now.Format(time.RFC3339Nano)
	snapshotRow.GCCompletedAt = &completedAt
	if err := s.repo.UpdateSnapshot(ctx, snapshotRow); err != nil {
		return false, err
	}
	return true, nil
}

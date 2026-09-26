package gc

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/db"
	"github.com/aperture/aperture/internal/ids"
	"github.com/aperture/aperture/internal/overlay"
	"github.com/aperture/aperture/internal/paths"
	"github.com/aperture/aperture/internal/sessionfiles"
	"github.com/aperture/aperture/internal/supervisor"
	"github.com/aperture/aperture/internal/traefik"
)

// OverlayClient unmounts session overlays during expiry.
type OverlayClient interface {
	Unmount(ctx context.Context, sessionID string) error
}

// Service runs garbage collection for sessions and snapshots.
type Service struct {
	cfg     config.Config
	repo    *db.Repository
	browser *supervisor.Browser
	overlay OverlayClient
	traefik traefik.Reconciler
	now     func() time.Time
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
	// StagingSweepErrors lists sessions whose upload staging could not be swept.
	// They do not stop the rest of the run.
	StagingSweepErrors []error
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
		expired, err := s.expireSession(ctx, &sessionRow, now)
		if err != nil {
			return nil, err
		}
		if expired {
			result.ExpiredSessions++
		}
	}
	result.StagingSweepErrors = s.sweepUploadStaging()

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

func (s *Service) expireSession(ctx context.Context, sessionRow *db.Session, now time.Time) (bool, error) {
	unlock := s.repo.LockSession(sessionRow.ID)
	defer unlock()

	latest, err := s.repo.GetSessionByID(ctx, sessionRow.ID)
	if err != nil {
		return false, err
	}
	if latest == nil || latest.Status == db.SessionStatusExpired {
		return false, nil
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, latest.ExpiresAt)
	if err != nil {
		return false, fmt.Errorf("parse session expiry: %w", err)
	}
	if expiresAt.After(now) {
		return false, nil
	}
	sessionRow = latest

	if sessionRow.Status == db.SessionStatusRunning {
		if err := s.browser.Stop(ctx, sessionRow.ID); err != nil {
			return false, err
		}
	}
	if err := s.browser.RemoveRuntimeEnv(sessionRow.ID); err != nil {
		return false, err
	}
	if err := s.ensureOverlayUnmounted(ctx, sessionRow); err != nil {
		return false, err
	}
	if err := s.removeSessionOverlayState(sessionRow); err != nil {
		return false, err
	}

	expiredAt := now.Format(time.RFC3339Nano)
	sessionRow.Status = db.SessionStatusExpired
	sessionRow.ExpiredAt = &expiredAt
	sessionRow.RuntimeEnvPath = nil
	sessionRow.CurrentCDPPort = nil
	sessionRow.StoppedAt = &expiredAt
	sessionRow.SuspendedAt = nil
	if err := s.repo.UpdateSession(ctx, sessionRow); err != nil {
		return false, err
	}
	return true, nil
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

	if err := s.overlay.Unmount(ctx, sessionRow.ID); err != nil {
		return &SessionOverlayUnmountError{SessionID: sessionRow.ID, Err: err}
	}

	mounted, err := overlay.IsMergedMounted(merged)
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
		// The files root sits in its own session directory under cold_root, which
		// is the overlay root only when cold_root is store_root.
		dirs = append(dirs, layout.Metadata, filepath.Dir(layout.Files.Root))
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

// sweepUploadStaging removes upload staging files that a process stopped
// mid-upload left behind, on filesystems where uploads cannot stage unnamed files.
func (s *Service) sweepUploadStaging() []error {
	roots, err := filepath.Glob(filepath.Join(s.cfg.ColdRoot, "sessions", "*", "*", "*", "files"))
	if err != nil {
		return []error{fmt.Errorf("find upload staging: %w", err)}
	}
	var failures []error
	for _, root := range roots {
		if err := sessionfiles.SweepStaging(root, sessionfiles.StaleStagingAge); err != nil {
			failures = append(failures, fmt.Errorf("sweep upload staging in %s: %w", root, err))
		}
	}
	return failures
}

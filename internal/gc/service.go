package gc

import (
	"context"
	"errors"
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
	"github.com/aperture/aperture/internal/systemd"
	"github.com/aperture/aperture/internal/traefik"
)

const (
	gcCleanupTimeout = 30 * time.Second
	gcClaimLease     = 5 * time.Minute
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
		expired, err := s.expireSession(ctx, &sessionRow, now)
		if err != nil {
			return nil, err
		}
		if expired {
			result.ExpiredSessions++
		}
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
	originalStatus := sessionRow.Status
	originalStartedAt := sessionRow.StartedAt
	claimToken, err := ids.NewUUIDv7()
	if err != nil {
		return false, err
	}
	claimed, err := s.repo.ClaimSessionIncarnation(ctx, sessionRow.ID, originalStatus, originalStartedAt, claimToken)
	if err != nil {
		return false, err
	}
	if !claimed {
		return false, nil
	}
	sessionRow.Status = db.SessionStatusCreating
	sessionRow.ClaimToken = &claimToken
	claimExpiresAt := time.Now().UTC().Add(gcClaimLease).Format(time.RFC3339Nano)
	sessionRow.ClaimExpiresAt = &claimExpiresAt
	cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), gcCleanupTimeout)
	defer cleanupCancel()
	restoreClaim := func(cause error) error {
		finalizeCtx, finalizeCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer finalizeCancel()
		return errors.Join(cause, s.repo.RestoreSessionStatusIfClaimed(finalizeCtx, sessionRow.ID, claimToken, originalStatus, originalStartedAt))
	}

	cleanupErr := s.runClaimedCleanup(cleanupCtx, sessionRow, claimToken, originalStatus == db.SessionStatusRunning || originalStatus == db.SessionStatusCreating)
	if cleanupErr != nil {
		return false, restoreClaim(cleanupErr)
	}

	expiredAt := now.Format(time.RFC3339Nano)
	sessionRow.Status = db.SessionStatusExpired
	sessionRow.ExpiredAt = &expiredAt
	sessionRow.RuntimeEnvPath = nil
	sessionRow.CurrentCDPPort = nil
	sessionRow.StoppedAt = &expiredAt
	sessionRow.SuspendedAt = nil
	finalizeCtx, finalizeCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer finalizeCancel()
	expired, err := s.repo.FinalizeExpiredSessionIfClaimed(finalizeCtx, sessionRow, claimToken)
	if err != nil {
		return false, restoreClaim(err)
	}
	if !expired {
		return false, restoreClaim(fmt.Errorf("expire session: generation conflict"))
	}
	sessionRow.ClaimToken = nil
	sessionRow.ClaimExpiresAt = nil
	if s.mediaCleaner != nil {
		s.mediaCleaner.CloseSessionMedia(sessionRow.ID)
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

func (s *Service) reserveClaim(ctx context.Context, sessionID, claimToken, operation string) error {
	reserved, err := s.repo.ReserveSessionClaim(ctx, sessionID, claimToken)
	if err != nil {
		return fmt.Errorf("%s: reserve session claim: %w", operation, err)
	}
	if !reserved {
		return fmt.Errorf("%s: session claim is no longer owned", operation)
	}
	return nil
}

func (s *Service) runClaimedCleanup(ctx context.Context, sessionRow *db.Session, claimToken string, stopBrowser bool) error {
	var errs []error
	run := func(operation string, sideEffect func() error) bool {
		if err := s.reserveClaim(ctx, sessionRow.ID, claimToken, operation); err != nil {
			errs = append(errs, err)
			return false
		}
		if err := sideEffect(); err != nil {
			errs = append(errs, err)
		}
		return true
	}
	if s.mediaCleaner != nil {
		if !run("close media", func() error {
			s.mediaCleaner.CloseSessionMedia(sessionRow.ID)
			return nil
		}) {
			return errors.Join(errs...)
		}
		if len(errs) > 0 {
			return errors.Join(errs...)
		}
	}
	if stopBrowser && !run("stop browser", func() error {
		err := s.browser.Stop(ctx, sessionRow.ID)
		if isMissingBrowserUnit(err) {
			return nil
		}
		return err
	}) {
		return errors.Join(errs...)
	}
	if len(errs) > 0 {
		return errors.Join(errs...)
	}
	if !run("remove runtime environment", func() error { return s.browser.RemoveRuntimeEnv(sessionRow.ID) }) {
		return errors.Join(errs...)
	}
	if len(errs) > 0 {
		return errors.Join(errs...)
	}
	if err := s.reserveClaim(ctx, sessionRow.ID, claimToken, "unmount overlay"); err != nil {
		return errors.Join(append(errs, err)...)
	}
	if err := s.ensureOverlayUnmounted(ctx, sessionRow); err != nil {
		return errors.Join(append(errs, err)...)
	}
	if !run("remove session overlay state", func() error { return s.removeSessionOverlayState(sessionRow) }) {
		return errors.Join(errs...)
	}
	return errors.Join(errs...)
}

func isMissingBrowserUnit(err error) bool {
	var commandErr *systemd.CommandError
	return errors.As(err, &commandErr) && commandErr.ExitCode == 5
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

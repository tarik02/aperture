package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/aperture/aperture/internal/browser"
	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/db"
	"github.com/aperture/aperture/internal/ids"
	"github.com/aperture/aperture/internal/overlay"
	"github.com/aperture/aperture/internal/paths"
	"github.com/aperture/aperture/internal/supervisor"
	"github.com/aperture/aperture/internal/traefik"
)

const (
	defaultMonitorInterval = 15 * time.Second
)

// OverlayClient mounts and unmounts session overlays.
type OverlayClient interface {
	Mount(ctx context.Context, sessionID string, baseSnapshotID *string) error
	Unmount(ctx context.Context, sessionID string) error
}

// MediaSessionCleaner closes in-memory media resources for a session.
type MediaSessionCleaner interface {
	CloseSessionMedia(sessionID string)
}

// Service owns session lifecycle orchestration.
type Service struct {
	cfg          config.Config
	repo         *db.Repository
	overlay      OverlayClient
	browser      *supervisor.Browser
	channels     *browser.Registry
	traefik      traefik.Reconciler
	mediaCleaner MediaSessionCleaner
	now          func() time.Time
	mountLocal   func(ctx context.Context, sessionID string, baseSnapshotID *string) error
	unmountLocal func(ctx context.Context, sessionID string) error
}

// NewService constructs a session service.
func NewService(
	cfg config.Config,
	repo *db.Repository,
	overlayClient OverlayClient,
	browserSupervisor *supervisor.Browser,
	channels *browser.Registry,
	traefikReconciler traefik.Reconciler,
) *Service {
	if traefikReconciler == nil {
		traefikReconciler = traefik.NoopReconciler{}
	}
	return &Service{
		cfg:      cfg,
		repo:     repo,
		overlay:  overlayClient,
		browser:  browserSupervisor,
		channels: channels,
		traefik:  traefikReconciler,
		now:      time.Now,
	}
}

// CreateInput configures session creation.
type CreateInput struct {
	TenantID         string
	BaseSnapshotName *string
	BrowserChannel   string
	BrowserArgs      []string
	Tags             map[string]string
}

// SessionView is returned by session APIs.
type SessionView struct {
	Session          db.Session
	Tags             map[string]string
	BaseSnapshotName *string
	CDPURL           string
	CDPToken         string
	Media            SessionMediaView
}

// SessionMediaView describes the media transport capability for a session.
type SessionMediaView struct {
	Mode           string
	WebRTCProducer bool
}

// Create creates and starts a browser session.
func (s *Service) Create(ctx context.Context, input CreateInput) (*SessionView, error) {
	if err := browser.ValidateBrowserArgs(input.BrowserArgs); err != nil {
		return nil, err
	}

	channel, err := s.channels.Resolve(input.BrowserChannel)
	if err != nil {
		if errors.Is(err, browser.ErrInvalidChannel) || errors.Is(err, browser.ErrUnknownChannel) {
			return nil, ErrInvalidChannel
		}
		return nil, err
	}

	var baseSnapshotID *string
	var baseSnapshotName *string
	if input.BaseSnapshotName != nil && *input.BaseSnapshotName != "" {
		snapshot, err := s.repo.GetSnapshotByTenantAndName(ctx, input.TenantID, *input.BaseSnapshotName)
		if err != nil {
			return nil, err
		}
		if snapshot == nil {
			return nil, ErrSnapshotNotFound
		}
		if snapshot.DeletedAt != nil {
			return nil, ErrSnapshotDeleted
		}
		baseSnapshotID = &snapshot.ID
		nameCopy := snapshot.Name
		baseSnapshotName = &nameCopy
	}

	sessionID, err := ids.NewUUIDv7()
	if err != nil {
		return nil, err
	}

	layout, err := paths.Session(s.cfg, sessionID)
	if err != nil {
		return nil, err
	}

	now := s.now().UTC()
	expiresAt := now.Add(time.Duration(s.cfg.SessionRetentionDays) * 24 * time.Hour)

	argsJSON, err := json.Marshal(input.BrowserArgs)
	if err != nil {
		return nil, fmt.Errorf("marshal browser args: %w", err)
	}

	sessionRow := &db.Session{
		ID:              sessionID,
		TenantID:        input.TenantID,
		BaseSnapshotID:  baseSnapshotID,
		Status:          db.SessionStatusCreating,
		OverlayPath:     layout.Root,
		UpperPath:       layout.Upper,
		WorkPath:        layout.Work,
		MergedPath:      layout.Merged,
		DownloadsPath:   layout.Downloads,
		CachePath:       layout.Cache,
		ArtifactsPath:   layout.Artifacts,
		BrowserChannel:  channel.Name,
		BrowserArgsJSON: string(argsJSON),
		CreatedAt:       now.Format(time.RFC3339Nano),
		ExpiresAt:       expiresAt.Format(time.RFC3339Nano),
	}

	if err := s.repo.CreateSession(ctx, sessionRow); err != nil {
		return nil, err
	}

	rawCDP, hashCDP, err := GenerateCDPToken(sessionID)
	if err != nil {
		return nil, err
	}
	if err := s.repo.CreateSessionToken(ctx, &db.SessionToken{
		SessionID: sessionID,
		TenantID:  input.TenantID,
		TokenHash: hashCDP,
		CreatedAt: now.Format(time.RFC3339Nano),
	}); err != nil {
		return nil, err
	}
	if err := StoreCDPTokenSeal(s.cfg, sessionID, rawCDP); err != nil {
		return nil, err
	}

	if err := s.replaceTags(ctx, sessionID, input.Tags); err != nil {
		return nil, err
	}

	if err := s.mountOverlay(ctx, sessionID, baseSnapshotID); err != nil {
		_ = s.markFailed(ctx, sessionRow, "overlay mount failed", err)
		return nil, &OverlayMountError{SessionID: sessionID, Err: err}
	}

	port, err := AllocateCDPPort()
	if err != nil {
		_ = s.markFailed(ctx, sessionRow, "cdp port allocation failed", err)
		return nil, err
	}

	compositorEnabled := s.webrtcCompositorRuntimeEnabled()
	mediaProducerEnabled := s.webrtcMediaProducerRuntimeEnabled()

	var rawMediaToken string
	if mediaProducerEnabled {
		var mediaHash string
		rawMediaToken, mediaHash, err = GenerateMediaToken(sessionID)
		if err != nil {
			_ = s.markFailed(ctx, sessionRow, "media token generation failed", err)
			return nil, err
		}
		if err := StoreMediaTokenHash(s.cfg, sessionID, mediaHash); err != nil {
			_ = s.markFailed(ctx, sessionRow, "media token storage failed", err)
			return nil, err
		}
	}

	runtimeEnv := browser.RuntimeEnvValues{
		SessionID:                  sessionID,
		MergedUserDataDir:          layout.Merged,
		DownloadsDir:               layout.Downloads,
		CacheDir:                   layout.Cache,
		ArtifactsDir:               layout.Artifacts,
		CDPPort:                    port,
		BrowserExecutable:          channel.Executable,
		BrowserDefaultArgs:         channel.DefaultArgs,
		BrowserExtraArgs:           input.BrowserArgs,
		CaptureProofExtensionDir:   s.cfg.WebRTCCaptureProofExtensionDir,
		CompositorEnabled:          compositorEnabled,
		CompositorExecutable:       s.cfg.WebRTCCompositorExecutable,
		CompositorBackend:          s.cfg.WebRTCCompositorBackend,
		CompositorRenderer:         s.cfg.WebRTCCompositorRenderer,
		CompositorShell:            s.cfg.WebRTCCompositorShell,
		CompositorWidth:            s.cfg.WebRTCCompositorWidth,
		CompositorHeight:           s.cfg.WebRTCCompositorHeight,
		MediaProducerEnabled:       mediaProducerEnabled,
		MediaProducerExecutable:    s.cfg.WebRTCMediaProducerExecutable,
		MediaProducerGSTExecutable: s.cfg.WebRTCMediaProducerGSTExecutable,
		MediaProducerPluginPath:    s.cfg.WebRTCMediaProducerPluginPath,
		MediaProducerSignalURL:     mediaProducerSignalURL(s.cfg, sessionID),
		MediaProducerTarget:        s.cfg.WebRTCMediaProducerTarget,
		MediaProducerToken:         rawMediaToken,
	}
	if err := s.browser.PrepareRuntime(runtimeEnv); err != nil {
		_ = s.markFailed(ctx, sessionRow, "runtime preparation failed", err)
		return nil, err
	}

	runtimePath := layout.RuntimeEnv
	startedAt := now.Format(time.RFC3339Nano)
	sessionRow.Status = db.SessionStatusRunning
	sessionRow.StartedAt = &startedAt
	sessionRow.StoppedAt = nil
	sessionRow.DeletedAt = nil
	sessionRow.RuntimeEnvPath = &runtimePath
	sessionRow.CurrentCDPPort = &port

	if err := s.repo.UpdateSession(ctx, sessionRow); err != nil {
		_ = s.cleanupPreparedRuntime(ctx, sessionID)
		return nil, err
	}

	if err := s.browser.Start(ctx, sessionID); err != nil {
		sessionRow.StartedAt = nil
		_ = s.markFailed(ctx, sessionRow, "browser start failed", err)
		return nil, fmt.Errorf("%w: %v", ErrBrowserStart, err)
	}

	if err := s.traefik.Reconcile(ctx); err != nil {
		return nil, err
	}

	tags, err := s.repo.ListSessionTags(ctx, sessionID)
	if err != nil {
		return nil, err
	}

	return &SessionView{
		Session:          *sessionRow,
		Tags:             tags,
		BaseSnapshotName: baseSnapshotName,
		CDPURL:           s.cdpURL(sessionID),
		CDPToken:         rawCDP,
		Media:            s.sessionMediaView(*sessionRow),
	}, nil
}

// Delete tombstones a session and stops its browser.
func (s *Service) Delete(ctx context.Context, tenantID, sessionID string) (*SessionView, error) {
	sessionRow, err := s.requireTenantSession(ctx, tenantID, sessionID)
	if err != nil {
		return nil, err
	}
	if sessionRow.Status == db.SessionStatusExpired {
		return nil, ErrExpired
	}

	if err := s.retireMediaSession(sessionID); err != nil {
		return nil, err
	}
	if sessionRow.Status == db.SessionStatusRunning {
		if err := s.browser.Stop(ctx, sessionID); err != nil {
			return nil, err
		}
	}
	if err := s.browser.RemoveRuntimeEnv(sessionID); err != nil {
		return nil, err
	}
	if sessionRow.Status == db.SessionStatusRunning {
		if err := s.unmountOverlay(ctx, sessionID); err != nil {
			return nil, &OverlayMountError{SessionID: sessionID, Err: err}
		}
	}

	now := s.now().UTC()
	deletedAt := now.Format(time.RFC3339Nano)
	expiresAt := now.Add(time.Duration(s.cfg.SessionRetentionDays) * 24 * time.Hour).Format(time.RFC3339Nano)
	stoppedAt := deletedAt

	sessionRow.Status = db.SessionStatusDeleted
	sessionRow.DeletedAt = &deletedAt
	sessionRow.StoppedAt = &stoppedAt
	sessionRow.ExpiresAt = expiresAt
	sessionRow.RuntimeEnvPath = nil
	sessionRow.CurrentCDPPort = nil

	if err := s.repo.UpdateSession(ctx, sessionRow); err != nil {
		return nil, err
	}
	s.closeMediaSession(sessionID)
	if err := s.traefik.Reconcile(ctx); err != nil {
		return nil, err
	}

	tags, err := s.repo.ListSessionTags(ctx, sessionID)
	if err != nil {
		return nil, err
	}

	rawCDP, err := LoadCDPTokenSeal(s.cfg, sessionID)
	if err != nil {
		return nil, err
	}

	return &SessionView{
		Session:  *sessionRow,
		Tags:     tags,
		CDPURL:   s.cdpURL(sessionID),
		CDPToken: rawCDP,
		Media:    s.sessionMediaView(*sessionRow),
	}, nil
}

// Reopen restores a retained deleted or failed session.
func (s *Service) Reopen(ctx context.Context, tenantID, sessionID string) (*SessionView, error) {
	sessionRow, err := s.requireTenantSession(ctx, tenantID, sessionID)
	if err != nil {
		return nil, err
	}
	if sessionRow.Status == db.SessionStatusExpired {
		return nil, ErrExpired
	}
	if sessionRow.Status != db.SessionStatusDeleted && sessionRow.Status != db.SessionStatusFailed {
		return nil, ErrNotReopenable
	}
	if !s.overlayPresent(sessionRow) {
		return nil, ErrOverlayMissing
	}

	if err := s.retireMediaSession(sessionID); err != nil {
		return nil, err
	}
	if err := s.browser.Stop(ctx, sessionID); err != nil {
		return nil, err
	}
	if err := s.browser.RemoveRuntimeEnv(sessionID); err != nil {
		return nil, err
	}

	layout, err := paths.Session(s.cfg, sessionID)
	if err != nil {
		return nil, err
	}

	if err := s.mountOverlay(ctx, sessionID, sessionRow.BaseSnapshotID); err != nil {
		_ = s.markReopenFailedRetained(ctx, sessionRow, err)
		return nil, &OverlayMountError{SessionID: sessionID, Err: err}
	}

	channel, err := s.channels.Resolve(sessionRow.BrowserChannel)
	if err != nil {
		_ = s.markReopenFailedRetained(ctx, sessionRow, err)
		return nil, err
	}

	var browserArgs []string
	if err := json.Unmarshal([]byte(sessionRow.BrowserArgsJSON), &browserArgs); err != nil {
		_ = s.markReopenFailedRetained(ctx, sessionRow, err)
		return nil, fmt.Errorf("parse browser args: %w", err)
	}

	port, err := AllocateCDPPort()
	if err != nil {
		_ = s.markReopenFailedRetained(ctx, sessionRow, err)
		return nil, err
	}

	compositorEnabled := s.webrtcCompositorRuntimeEnabled()
	mediaProducerEnabled := s.webrtcMediaProducerRuntimeEnabled()

	var rawMediaToken string
	if mediaProducerEnabled {
		var mediaHash string
		rawMediaToken, mediaHash, err = GenerateMediaToken(sessionID)
		if err != nil {
			_ = s.markReopenFailedRetained(ctx, sessionRow, err)
			return nil, err
		}
		if err := StoreMediaTokenHash(s.cfg, sessionID, mediaHash); err != nil {
			_ = s.markReopenFailedRetained(ctx, sessionRow, err)
			return nil, err
		}
	}

	runtimeEnv := browser.RuntimeEnvValues{
		SessionID:                  sessionID,
		MergedUserDataDir:          layout.Merged,
		DownloadsDir:               layout.Downloads,
		CacheDir:                   layout.Cache,
		ArtifactsDir:               layout.Artifacts,
		CDPPort:                    port,
		BrowserExecutable:          channel.Executable,
		BrowserDefaultArgs:         channel.DefaultArgs,
		BrowserExtraArgs:           browserArgs,
		CaptureProofExtensionDir:   s.cfg.WebRTCCaptureProofExtensionDir,
		CompositorEnabled:          compositorEnabled,
		CompositorExecutable:       s.cfg.WebRTCCompositorExecutable,
		CompositorBackend:          s.cfg.WebRTCCompositorBackend,
		CompositorRenderer:         s.cfg.WebRTCCompositorRenderer,
		CompositorShell:            s.cfg.WebRTCCompositorShell,
		CompositorWidth:            s.cfg.WebRTCCompositorWidth,
		CompositorHeight:           s.cfg.WebRTCCompositorHeight,
		MediaProducerEnabled:       mediaProducerEnabled,
		MediaProducerExecutable:    s.cfg.WebRTCMediaProducerExecutable,
		MediaProducerGSTExecutable: s.cfg.WebRTCMediaProducerGSTExecutable,
		MediaProducerPluginPath:    s.cfg.WebRTCMediaProducerPluginPath,
		MediaProducerSignalURL:     mediaProducerSignalURL(s.cfg, sessionID),
		MediaProducerTarget:        s.cfg.WebRTCMediaProducerTarget,
		MediaProducerToken:         rawMediaToken,
	}
	if err := s.browser.PrepareRuntime(runtimeEnv); err != nil {
		_ = s.markReopenFailedRetained(ctx, sessionRow, err)
		return nil, err
	}

	now := s.now().UTC()
	startedAt := now.Format(time.RFC3339Nano)
	expiresAt := now.Add(time.Duration(s.cfg.SessionRetentionDays) * 24 * time.Hour).Format(time.RFC3339Nano)
	runtimePath := layout.RuntimeEnv

	sessionRow.Status = db.SessionStatusRunning
	sessionRow.DeletedAt = nil
	sessionRow.StoppedAt = nil
	sessionRow.StartedAt = &startedAt
	sessionRow.ExpiresAt = expiresAt
	sessionRow.RuntimeEnvPath = &runtimePath
	sessionRow.CurrentCDPPort = &port

	if err := s.repo.UpdateSession(ctx, sessionRow); err != nil {
		_ = s.cleanupPreparedRuntime(ctx, sessionID)
		return nil, err
	}

	if err := s.browser.Start(ctx, sessionID); err != nil {
		sessionRow.StartedAt = nil
		_ = s.markReopenFailedRetained(ctx, sessionRow, err)
		return nil, fmt.Errorf("%w: %v", ErrBrowserStart, err)
	}

	if err := s.traefik.Reconcile(ctx); err != nil {
		return nil, err
	}

	tags, err := s.repo.ListSessionTags(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	rawCDP, err := LoadCDPTokenSeal(s.cfg, sessionID)
	if err != nil {
		return nil, err
	}

	return &SessionView{
		Session:  *sessionRow,
		Tags:     tags,
		CDPURL:   s.cdpURL(sessionID),
		CDPToken: rawCDP,
		Media:    s.sessionMediaView(*sessionRow),
	}, nil
}

// RotateCDPToken replaces the session CDP token without restarting the browser.
func (s *Service) RotateCDPToken(ctx context.Context, tenantID, sessionID string) (*SessionView, error) {
	sessionRow, err := s.requireTenantSession(ctx, tenantID, sessionID)
	if err != nil {
		return nil, err
	}
	if !isRetainedOrRunning(sessionRow.Status) {
		return nil, ErrInvalidState
	}

	rawCDP, hashCDP, err := GenerateCDPToken(sessionID)
	if err != nil {
		return nil, err
	}

	now := s.now().UTC()
	if err := s.repo.ReplaceSessionToken(ctx, sessionID, hashCDP, now.Format(time.RFC3339Nano)); err != nil {
		return nil, err
	}
	if err := StoreCDPTokenSeal(s.cfg, sessionID, rawCDP); err != nil {
		return nil, err
	}

	sessionRow.ExpiresAt = now.Add(time.Duration(s.cfg.SessionRetentionDays) * 24 * time.Hour).Format(time.RFC3339Nano)
	if err := s.repo.UpdateSession(ctx, sessionRow); err != nil {
		return nil, err
	}

	tags, err := s.repo.ListSessionTags(ctx, sessionID)
	if err != nil {
		return nil, err
	}

	return &SessionView{
		Session:  *sessionRow,
		Tags:     tags,
		CDPURL:   s.cdpURL(sessionID),
		CDPToken: rawCDP,
		Media:    s.sessionMediaView(*sessionRow),
	}, nil
}

// ReplaceTags replaces the exact tag set for a tenant-owned session.
func (s *Service) ReplaceTags(ctx context.Context, tenantID, sessionID string, tags map[string]string) (*SessionView, error) {
	sessionRow, err := s.requireTenantSession(ctx, tenantID, sessionID)
	if err != nil {
		return nil, err
	}

	if err := s.replaceTags(ctx, sessionID, tags); err != nil {
		return nil, err
	}

	tagMap, err := s.repo.ListSessionTags(ctx, sessionID)
	if err != nil {
		return nil, err
	}

	var baseSnapshotName *string
	if sessionRow.BaseSnapshotID != nil {
		snapshotNames, err := s.repo.ListSnapshotNamesByIDs(ctx, []string{*sessionRow.BaseSnapshotID})
		if err != nil {
			return nil, err
		}
		if name, ok := snapshotNames[*sessionRow.BaseSnapshotID]; ok {
			nameCopy := name
			baseSnapshotName = &nameCopy
		}
	}

	view := SessionView{
		Session:          *sessionRow,
		Tags:             tagMap,
		BaseSnapshotName: baseSnapshotName,
		Media:            s.sessionMediaView(*sessionRow),
	}
	if sessionRow.Status == db.SessionStatusRunning && sessionRow.CurrentCDPPort != nil {
		view.CDPURL = s.cdpURL(sessionRow.ID)
	}
	return &view, nil
}

// ListFilter configures session listing.
type ListFilter struct {
	IncludeDeleted bool
	Status         *string
	Tags           []db.TagFilter
}

// List returns tenant sessions with cursor pagination.
func (s *Service) List(ctx context.Context, tenantID string, filter ListFilter, params db.PageParams) (db.PageResult[SessionView], error) {
	page, err := s.repo.ListSessionsPage(ctx, db.SessionFilter{
		TenantID:       tenantID,
		IncludeDeleted: filter.IncludeDeleted,
		Status:         filter.Status,
		Tags:           filter.Tags,
	}, params)
	if err != nil {
		return db.PageResult[SessionView]{}, err
	}
	if len(page.Items) == 0 {
		return db.PageResult[SessionView]{Meta: page.Meta}, nil
	}

	sessionIDs := make([]string, 0, len(page.Items))
	snapshotIDs := make([]string, 0)
	for _, sessionRow := range page.Items {
		sessionIDs = append(sessionIDs, sessionRow.ID)
		if sessionRow.BaseSnapshotID != nil {
			snapshotIDs = append(snapshotIDs, *sessionRow.BaseSnapshotID)
		}
	}

	tagsBySession, err := s.repo.ListSessionTagsForSessions(ctx, sessionIDs)
	if err != nil {
		return db.PageResult[SessionView]{}, err
	}
	snapshotNames, err := s.repo.ListSnapshotNamesByIDs(ctx, snapshotIDs)
	if err != nil {
		return db.PageResult[SessionView]{}, err
	}

	views := make([]SessionView, 0, len(page.Items))
	for _, sessionRow := range page.Items {
		var baseSnapshotName *string
		if sessionRow.BaseSnapshotID != nil {
			if name, ok := snapshotNames[*sessionRow.BaseSnapshotID]; ok {
				nameCopy := name
				baseSnapshotName = &nameCopy
			}
		}

		view := SessionView{
			Session:          sessionRow,
			Tags:             tagsBySession[sessionRow.ID],
			BaseSnapshotName: baseSnapshotName,
			Media:            s.sessionMediaView(sessionRow),
		}
		if sessionRow.Status == db.SessionStatusRunning && sessionRow.CurrentCDPPort != nil {
			view.CDPURL = s.cdpURL(sessionRow.ID)
		}
		views = append(views, view)
	}

	return db.PageResult[SessionView]{
		Items: views,
		Meta:  page.Meta,
	}, nil
}

// ReconcileStartup aligns DB session state with systemd and runtime files after restart.
func (s *Service) ReconcileStartup(ctx context.Context) error {
	sessions, err := s.repo.ListSessionsByStatus(ctx, db.SessionStatusRunning)
	if err != nil {
		return err
	}

	for _, sessionRow := range sessions {
		if isExpired(sessionRow.ExpiresAt, s.now().UTC()) {
			if err := s.markFailedRetained(ctx, &sessionRow, "startup reconciliation found expired lease on running session", nil); err != nil {
				return err
			}
			continue
		}

		active, err := s.browser.IsActive(ctx, sessionRow.ID)
		if err != nil {
			return err
		}
		envExists, err := s.browser.RuntimeEnvExists(sessionRow.ID)
		if err != nil {
			return err
		}

		switch {
		case active && !envExists:
			if err := s.markFailedRetained(ctx, &sessionRow, "startup reconciliation found running unit without runtime env", nil); err != nil {
				return err
			}
		case !active:
			if err := s.markFailedRetained(ctx, &sessionRow, "startup reconciliation found inactive browser unit", nil); err != nil {
				return err
			}
		}
	}

	if err := s.reconcileOrphanRuntimeUnits(ctx); err != nil {
		return err
	}
	if err := s.removeStaleRuntimeEnvFiles(ctx); err != nil {
		return err
	}

	return s.traefik.Reconcile(ctx)
}

func (s *Service) reconcileOrphanRuntimeUnits(ctx context.Context) error {
	activeIDs, err := s.browser.ListActiveSessionIDs(ctx)
	if err != nil {
		return err
	}

	for _, sessionID := range activeIDs {
		sessionRow, err := s.repo.GetSessionByID(ctx, sessionID)
		if err != nil {
			return err
		}
		if sessionRow != nil && sessionRow.Status == db.SessionStatusRunning && isExpired(sessionRow.ExpiresAt, s.now().UTC()) {
			if err := s.markFailedRetained(ctx, sessionRow, "startup reconciliation stopped expired running session unit", nil); err != nil {
				return err
			}
			continue
		}
		if sessionRow == nil || sessionRow.Status != db.SessionStatusRunning {
			_ = s.retireMediaSession(sessionID)
			_ = s.browser.Stop(ctx, sessionID)
			_ = s.browser.RemoveRuntimeEnv(sessionID)
		}
	}
	return nil
}

func (s *Service) removeStaleRuntimeEnvFiles(ctx context.Context) error {
	sessionsDir, err := paths.JoinUnderRoot(s.cfg.RuntimeRoot, "sessions")
	if err != nil {
		return err
	}
	entries, err := os.ReadDir(sessionsDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read runtime sessions dir: %w", err)
	}

	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".env") {
			continue
		}
		sessionID := strings.TrimSuffix(entry.Name(), ".env")
		if err := ids.ValidateUUIDv7(sessionID); err != nil {
			continue
		}

		sessionRow, err := s.repo.GetSessionByID(ctx, sessionID)
		if err != nil {
			return err
		}
		keep := sessionRow != nil &&
			sessionRow.Status == db.SessionStatusRunning &&
			!isExpired(sessionRow.ExpiresAt, s.now().UTC())
		if keep {
			continue
		}

		_ = s.retireMediaSession(sessionID)
		_ = s.browser.Stop(ctx, sessionID)
		_ = s.browser.RemoveRuntimeEnv(sessionID)
	}
	return nil
}

// MonitorInterval returns the running-session monitor interval.
func (s *Service) MonitorInterval() time.Duration {
	return defaultMonitorInterval
}

func (s *Service) mountOverlay(ctx context.Context, sessionID string, baseSnapshotID *string) error {
	if s.mountLocal != nil {
		return s.mountLocal(ctx, sessionID, baseSnapshotID)
	}
	return s.overlay.Mount(ctx, sessionID, baseSnapshotID)
}

func (s *Service) unmountOverlay(ctx context.Context, sessionID string) error {
	if s.unmountLocal != nil {
		return s.unmountLocal(ctx, sessionID)
	}
	return s.overlay.Unmount(ctx, sessionID)
}

func (s *Service) effectiveWebRTCMediaMode() string {
	switch strings.ToLower(strings.TrimSpace(s.cfg.WebRTCMediaMode)) {
	case config.WebRTCMediaModeCDP:
		return config.WebRTCMediaModeCDP
	default:
		return config.WebRTCMediaModeAuto
	}
}

func (s *Service) webrtcCompositorRuntimeEnabled() bool {
	return s.effectiveWebRTCMediaMode() == config.WebRTCMediaModeAuto && s.cfg.WebRTCCompositorEnabled
}

func (s *Service) webrtcMediaProducerRuntimeEnabled() bool {
	return s.webrtcCompositorRuntimeEnabled() && s.cfg.WebRTCMediaProducerEnabled
}

func (s *Service) sessionMediaView(sessionRow db.Session) SessionMediaView {
	view := SessionMediaView{Mode: s.effectiveWebRTCMediaMode()}
	if view.Mode != config.WebRTCMediaModeAuto ||
		sessionRow.Status != db.SessionStatusRunning ||
		sessionRow.RuntimeEnvPath == nil {
		return view
	}

	body, err := os.ReadFile(*sessionRow.RuntimeEnvPath)
	if err != nil {
		return view
	}
	values, err := browser.ParseRuntimeEnv(body)
	if err != nil {
		return view
	}
	if _, err := LoadMediaTokenHash(s.cfg, sessionRow.ID); err != nil {
		return view
	}
	view.WebRTCProducer = values.CompositorEnabled && values.MediaProducerEnabled
	return view
}

func mediaProducerSignalURL(cfg config.Config, sessionID string) string {
	host := strings.TrimSpace(cfg.ListenAddress)
	if splitHost, port, err := net.SplitHostPort(host); err == nil {
		switch splitHost {
		case "", "0.0.0.0", "::", "[::]":
			splitHost = "127.0.0.1"
		}
		host = net.JoinHostPort(splitHost, port)
	} else if strings.HasPrefix(host, ":") {
		host = "127.0.0.1" + host
	}

	return (&url.URL{
		Scheme:   "ws",
		Host:     host,
		Path:     "/api/webrtc/" + sessionID + "/signal",
		RawQuery: "role=producer",
	}).String()
}

func (s *Service) requireTenantSession(ctx context.Context, tenantID, sessionID string) (*db.Session, error) {
	sessionRow, err := s.repo.GetSessionByTenantAndID(ctx, tenantID, sessionID)
	if err != nil {
		return nil, err
	}
	if sessionRow == nil {
		return nil, ErrNotFound
	}
	if isExpired(sessionRow.ExpiresAt, s.now().UTC()) {
		return nil, ErrExpired
	}
	return sessionRow, nil
}

func (s *Service) replaceTags(ctx context.Context, sessionID string, tags map[string]string) error {
	rows := make([]db.SessionTag, 0, len(tags))
	for key, value := range tags {
		rows = append(rows, db.SessionTag{
			SessionID: sessionID,
			Key:       key,
			Value:     value,
		})
	}
	return s.repo.ReplaceSessionTags(ctx, sessionID, rows)
}

func (s *Service) retireMediaSession(sessionID string) error {
	if err := RemoveMediaTokenHash(s.cfg, sessionID); err != nil {
		return err
	}
	s.closeMediaSession(sessionID)
	return nil
}

func (s *Service) closeMediaSession(sessionID string) {
	if s.mediaCleaner != nil {
		s.mediaCleaner.CloseSessionMedia(sessionID)
	}
}

func (s *Service) cleanupPreparedRuntime(ctx context.Context, sessionID string) error {
	return errors.Join(
		s.retireMediaSession(sessionID),
		s.browser.RemoveRuntimeEnv(sessionID),
		s.unmountOverlay(ctx, sessionID),
	)
}

func (s *Service) markFailed(ctx context.Context, sessionRow *db.Session, message string, cause error) error {
	return s.markFailedRetained(ctx, sessionRow, message, cause)
}

func (s *Service) markFailedRetained(ctx context.Context, sessionRow *db.Session, message string, cause error) error {
	_ = s.retireMediaSession(sessionRow.ID)
	_ = s.browser.Stop(ctx, sessionRow.ID)
	_ = s.browser.RemoveRuntimeEnv(sessionRow.ID)
	_ = s.unmountOverlay(ctx, sessionRow.ID)

	now := s.now().UTC().Format(time.RFC3339Nano)
	sessionRow.Status = db.SessionStatusFailed
	sessionRow.StoppedAt = &now
	sessionRow.RuntimeEnvPath = nil
	sessionRow.CurrentCDPPort = nil
	if err := s.repo.UpdateSession(ctx, sessionRow); err != nil {
		return err
	}
	s.closeMediaSession(sessionRow.ID)

	if err := s.traefik.Reconcile(ctx); err != nil {
		return err
	}

	return s.appendEvent(ctx, sessionRow, "session.failed", message, cause)
}

func (s *Service) markReopenFailedRetained(ctx context.Context, sessionRow *db.Session, cause error) error {
	_ = s.retireMediaSession(sessionRow.ID)
	_ = s.browser.Stop(ctx, sessionRow.ID)
	_ = s.browser.RemoveRuntimeEnv(sessionRow.ID)
	_ = s.unmountOverlay(ctx, sessionRow.ID)

	now := s.now().UTC().Format(time.RFC3339Nano)
	sessionRow.Status = db.SessionStatusFailed
	sessionRow.StoppedAt = &now
	sessionRow.RuntimeEnvPath = nil
	sessionRow.CurrentCDPPort = nil
	if err := s.repo.UpdateSession(ctx, sessionRow); err != nil {
		return err
	}
	s.closeMediaSession(sessionRow.ID)
	return s.appendEvent(ctx, sessionRow, "session.reopen_failed", "session reopen failed", cause)
}

func (s *Service) appendEvent(ctx context.Context, sessionRow *db.Session, eventType, message string, cause error) error {
	eventID, err := ids.NewUUIDv7()
	if err != nil {
		return err
	}
	data := map[string]string{}
	if cause != nil {
		data["error"] = cause.Error()
	}
	dataJSON, err := json.Marshal(data)
	if err != nil {
		return err
	}
	return s.repo.CreateEvent(ctx, &db.Event{
		ID:           eventID,
		TenantID:     sessionRow.TenantID,
		ResourceType: "session",
		ResourceID:   sessionRow.ID,
		Type:         eventType,
		Message:      message,
		DataJSON:     string(dataJSON),
		CreatedAt:    s.now().UTC().Format(time.RFC3339Nano),
	})
}

func (s *Service) overlayPresent(sessionRow *db.Session) bool {
	if sessionRow.UpperPath == "" {
		return false
	}
	if _, err := os.Stat(sessionRow.UpperPath); err != nil {
		return false
	}
	return true
}

func (s *Service) cdpURL(sessionID string) string {
	base := strings.TrimRight(s.cfg.ExternalBaseURL+s.cfg.CdpRouteBasePath, "/")
	return fmt.Sprintf("%s/%s", base, sessionID)
}

func isExpired(expiresAt string, now time.Time) bool {
	parsed, err := time.Parse(time.RFC3339Nano, expiresAt)
	if err != nil {
		return true
	}
	return now.After(parsed)
}

func isRetainedOrRunning(status string) bool {
	switch status {
	case db.SessionStatusRunning, db.SessionStatusDeleted, db.SessionStatusFailed:
		return true
	default:
		return false
	}
}

// SetMediaSessionCleaner configures cleanup for in-memory media state.
func (s *Service) SetMediaSessionCleaner(cleaner MediaSessionCleaner) {
	s.mediaCleaner = cleaner
}

// SetDirectOverlayHooks configures in-process overlay mount hooks for tests.
func (s *Service) SetDirectOverlayHooks(
	mountFn func(ctx context.Context, sessionID string, baseSnapshotID *string) error,
	unmountFn func(ctx context.Context, sessionID string) error,
) {
	s.mountLocal = mountFn
	s.unmountLocal = unmountFn
}

// SetDirectOverlayHooksFromConfig uses sudo helpers in-process for integration tests.
func (s *Service) SetDirectOverlayHooksFromConfig() {
	s.mountLocal = func(ctx context.Context, sessionID string, baseSnapshotID *string) error {
		req := overlay.MountRequestFromIDs(sessionID, baseSnapshotID)
		return overlay.MountDirect(s.cfg, req)
	}
	s.unmountLocal = func(ctx context.Context, sessionID string) error {
		return overlay.UnmountDirect(s.cfg, sessionID)
	}
}

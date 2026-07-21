package session

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/aperture/aperture/internal/browser"
	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/db"
	"github.com/aperture/aperture/internal/paths"
)

const wakeTimeout = 30 * time.Second

type wakeCall struct {
	done chan struct{}
	err  error
}

// AcquireCDPPort wakes a tenant-owned session if needed and holds an activity inhibitor.
func (s *Service) AcquireCDPPort(ctx context.Context, tenantID, sessionID string) (int, func(), error) {
	sessionRow, err := s.requireTenantSession(ctx, tenantID, sessionID)
	if err != nil {
		return 0, nil, err
	}

	release := s.acquireInhibitor(sessionID)
	sessionRow, err = s.ensureSessionRunning(ctx, sessionRow)
	if err != nil {
		release()
		return 0, nil, err
	}
	if sessionRow.CurrentCDPPort == nil || *sessionRow.CurrentCDPPort <= 0 {
		release()
		return 0, nil, ErrNotRunning
	}
	if err := s.touchConnected(ctx, sessionRow); err != nil {
		release()
		return 0, nil, err
	}
	return *sessionRow.CurrentCDPPort, s.releaseInhibitor(sessionRow.ID, release), nil
}

// AcquireAuthorizedCDPPort wakes a session-token-authorized session if needed and holds an activity inhibitor.
func (s *Service) AcquireAuthorizedCDPPort(ctx context.Context, routeSessionID, authorization string) (int, func(), error) {
	sessionRow, err := s.authorizedSession(ctx, routeSessionID, authorization)
	if err != nil {
		return 0, nil, err
	}

	release := s.acquireInhibitor(sessionRow.ID)
	sessionRow, err = s.ensureSessionRunning(ctx, sessionRow)
	if err != nil {
		release()
		return 0, nil, err
	}
	if sessionRow.CurrentCDPPort == nil || *sessionRow.CurrentCDPPort <= 0 {
		release()
		return 0, nil, ErrNotRunning
	}
	if err := s.touchConnected(ctx, sessionRow); err != nil {
		release()
		return 0, nil, err
	}
	return *sessionRow.CurrentCDPPort, s.releaseInhibitor(sessionRow.ID, release), nil
}

// WakeAuthorizedSession validates a public session token and waits until a suspended session is ready.
func (s *Service) WakeAuthorizedSession(ctx context.Context, routeSessionID, authorization string) error {
	_, release, err := s.AcquireAuthorizedCDPPort(ctx, routeSessionID, authorization)
	if err != nil {
		return err
	}
	release()
	return nil
}

// AcquireWrapperPort wakes a tenant-owned session if needed and holds an activity inhibitor.
func (s *Service) AcquireWrapperPort(ctx context.Context, tenantID, sessionID string) (int, func(), error) {
	sessionRow, err := s.requireTenantSession(ctx, tenantID, sessionID)
	if err != nil {
		return 0, nil, err
	}

	release := s.acquireInhibitor(sessionID)
	sessionRow, err = s.ensureSessionRunning(ctx, sessionRow)
	if err != nil {
		release()
		return 0, nil, err
	}
	port, err := wrapperPort(sessionRow)
	if err != nil {
		release()
		return 0, nil, err
	}
	if err := s.touchConnected(ctx, sessionRow); err != nil {
		release()
		return 0, nil, err
	}
	return port, s.releaseInhibitor(sessionRow.ID, release), nil
}

// SuspendIdleSessions stops running sessions that have no recent connection activity.
func (s *Service) SuspendIdleSessions(ctx context.Context) (int, error) {
	cutoff := s.now().UTC().Add(-defaultSuspendAfter).Format(time.RFC3339Nano)
	sessions, err := s.repo.ListRunningSessionsIdleBefore(ctx, cutoff)
	if err != nil {
		return 0, err
	}

	suspended := 0
	for _, sessionRow := range sessions {
		if s.activeInhibitors(sessionRow.ID) > 0 {
			continue
		}
		didSuspend, err := s.suspendSession(ctx, &sessionRow, "session suspended after idle timeout")
		if err != nil {
			return suspended, err
		}
		if didSuspend {
			suspended++
		}
	}
	return suspended, nil
}

// Suspend stops a running tenant-owned session while retaining it for later wake.
func (s *Service) Suspend(ctx context.Context, tenantID, sessionID string) (*SessionView, error) {
	sessionRow, err := s.requireTenantSession(ctx, tenantID, sessionID)
	if err != nil {
		return nil, err
	}
	if sessionRow.Status != db.SessionStatusRunning {
		return nil, ErrInvalidState
	}

	didSuspend, err := s.suspendSession(ctx, sessionRow, "session manually suspended")
	if err != nil {
		return nil, err
	}
	if !didSuspend {
		return nil, ErrInvalidState
	}

	updated, err := s.repo.GetSessionByID(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	if updated == nil {
		return nil, ErrNotFound
	}

	tags, err := s.repo.ListSessionTags(ctx, sessionID)
	if err != nil {
		return nil, err
	}

	var baseSnapshotName *string
	if updated.BaseSnapshotID != nil {
		snapshotNames, err := s.repo.ListSnapshotNamesByIDs(ctx, []string{*updated.BaseSnapshotID})
		if err != nil {
			return nil, err
		}
		if name, ok := snapshotNames[*updated.BaseSnapshotID]; ok {
			nameCopy := name
			baseSnapshotName = &nameCopy
		}
	}

	view := SessionView{
		Session:          *updated,
		Tags:             tags,
		BaseSnapshotName: baseSnapshotName,
		Media:            s.sessionMediaView(*updated),
	}
	if err := s.populateSessionCredentials(ctx, &view); err != nil {
		return nil, err
	}
	return &view, nil
}

func (s *Service) acquireInhibitor(sessionID string) func() {
	s.mu.Lock()
	if s.inhibitors == nil {
		s.inhibitors = make(map[string]int)
	}
	s.inhibitors[sessionID]++
	s.mu.Unlock()

	return func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		next := s.inhibitors[sessionID] - 1
		if next <= 0 {
			delete(s.inhibitors, sessionID)
			return
		}
		s.inhibitors[sessionID] = next
	}
}

func (s *Service) releaseInhibitor(sessionID string, release func()) func() {
	return func() {
		_ = s.touchConnectedByID(context.Background(), sessionID)
		release()
	}
}

func (s *Service) activeInhibitors(sessionID string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.inhibitors[sessionID]
}

func (s *Service) ensureSessionRunning(ctx context.Context, sessionRow *db.Session) (*db.Session, error) {
	if sessionRow.Status == db.SessionStatusRunning {
		return sessionRow, nil
	}
	if sessionRow.Status != db.SessionStatusSuspended {
		return nil, ErrNotRunning
	}

	if err := s.runWake(ctx, sessionRow.ID, func() error {
		unlock := s.repo.LockSession(sessionRow.ID)
		defer unlock()

		latest, err := s.repo.GetSessionByID(ctx, sessionRow.ID)
		if err != nil {
			return err
		}
		if latest == nil {
			return ErrNotFound
		}
		if latest.Status == db.SessionStatusRunning {
			return nil
		}
		if latest.Status != db.SessionStatusSuspended {
			return ErrNotRunning
		}
		if isExpired(latest.ExpiresAt, s.now().UTC()) {
			return ErrExpired
		}
		return s.wakeSuspendedSession(ctx, latest)
	}); err != nil {
		return nil, err
	}

	latest, err := s.repo.GetSessionByID(ctx, sessionRow.ID)
	if err != nil {
		return nil, err
	}
	if latest == nil {
		return nil, ErrNotFound
	}
	if latest.Status != db.SessionStatusRunning {
		return nil, ErrNotRunning
	}
	return latest, nil
}

func (s *Service) runWake(ctx context.Context, sessionID string, wake func() error) error {
	s.mu.Lock()
	if s.wakes == nil {
		s.wakes = make(map[string]*wakeCall)
	}
	if call := s.wakes[sessionID]; call != nil {
		done := call.done
		s.mu.Unlock()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-done:
			return call.err
		}
	}
	call := &wakeCall{done: make(chan struct{})}
	s.wakes[sessionID] = call
	s.mu.Unlock()

	call.err = wake()
	close(call.done)

	s.mu.Lock()
	delete(s.wakes, sessionID)
	s.mu.Unlock()
	return call.err
}

func (s *Service) wakeSuspendedSession(ctx context.Context, sessionRow *db.Session) error {
	if !s.overlayPresent(sessionRow) {
		return ErrOverlayMissing
	}

	if err := s.mountOverlay(ctx, sessionRow.ID, sessionRow.BaseSnapshotID); err != nil {
		_ = s.markReopenFailedRetained(ctx, sessionRow, err)
		return &OverlayMountError{SessionID: sessionRow.ID, Err: err}
	}

	runtimeEnv, runtimePath, err := s.runtimeEnvForSession(ctx, sessionRow)
	if err != nil {
		_ = s.markReopenFailedRetained(ctx, sessionRow, err)
		return err
	}
	if err := s.browser.PrepareRuntime(runtimeEnv); err != nil {
		_ = s.markReopenFailedRetained(ctx, sessionRow, err)
		return err
	}

	now := s.now().UTC()
	startedAt := now.Format(time.RFC3339Nano)
	expiresAt := now.Add(time.Duration(s.cfg.SessionRetentionDays) * 24 * time.Hour).Format(time.RFC3339Nano)

	sessionRow.Status = db.SessionStatusRunning
	sessionRow.StartedAt = &startedAt
	sessionRow.StoppedAt = nil
	sessionRow.SuspendedAt = nil
	sessionRow.ExpiresAt = expiresAt
	sessionRow.RuntimeEnvPath = &runtimePath
	sessionRow.CurrentCDPPort = &runtimeEnv.CDPPort
	sessionRow.LastConnectedAt = &startedAt

	if err := s.repo.UpdateSession(ctx, sessionRow); err != nil {
		_ = s.cleanupPreparedRuntime(ctx, sessionRow.ID)
		return err
	}
	if err := s.browser.Start(ctx, sessionRow.ID); err != nil {
		sessionRow.StartedAt = nil
		_ = s.markReopenFailedRetained(ctx, sessionRow, err)
		return fmt.Errorf("%w: %v", ErrBrowserStart, err)
	}
	if err := s.waitForRuntimeReady(ctx, runtimeEnv.CDPPort, runtimeEnv.WrapperPort); err != nil {
		_ = s.markReopenFailedRetained(ctx, sessionRow, err)
		return fmt.Errorf("%w: %v", ErrBrowserStart, err)
	}
	if err := s.traefik.Reconcile(ctx); err != nil {
		return err
	}
	return s.appendEvent(ctx, sessionRow, "session.woke", "session woke from suspension", nil)
}

func (s *Service) suspendSession(ctx context.Context, sessionRow *db.Session, eventMessage string) (bool, error) {
	unlock := s.repo.LockSession(sessionRow.ID)
	defer unlock()

	latest, err := s.repo.GetSessionByID(ctx, sessionRow.ID)
	if err != nil {
		return false, err
	}
	if latest == nil || latest.Status != db.SessionStatusRunning {
		return false, nil
	}
	if s.activeInhibitors(latest.ID) > 0 {
		return false, nil
	}
	if isExpired(latest.ExpiresAt, s.now().UTC()) {
		return false, nil
	}

	_ = s.retireMediaSession(latest.ID)
	if err := s.browser.Stop(ctx, latest.ID); err != nil {
		return false, err
	}

	now := s.now().UTC()
	nowText := now.Format(time.RFC3339Nano)
	expiresAt := now.Add(time.Duration(s.cfg.SessionRetentionDays) * 24 * time.Hour).Format(time.RFC3339Nano)

	latest.Status = db.SessionStatusSuspended
	latest.StoppedAt = &nowText
	latest.SuspendedAt = &nowText
	latest.ExpiresAt = expiresAt

	if err := s.repo.UpdateSession(ctx, latest); err != nil {
		return false, err
	}
	s.closeMediaSession(latest.ID)
	if err := s.traefik.Reconcile(ctx); err != nil {
		return false, err
	}
	if err := s.appendEvent(ctx, latest, "session.suspended", eventMessage, nil); err != nil {
		return false, err
	}
	if err := s.unmountOverlay(ctx, latest.ID); err != nil {
		return false, &OverlayMountError{SessionID: latest.ID, Err: err}
	}
	return true, nil
}

func (s *Service) runtimeEnvForSession(ctx context.Context, sessionRow *db.Session) (browser.RuntimeEnvValues, string, error) {
	layout, err := paths.Session(s.cfg, sessionRow.ID)
	if err != nil {
		return browser.RuntimeEnvValues{}, "", err
	}
	channel, err := s.channels.Resolve(sessionRow.BrowserChannel)
	if err != nil {
		return browser.RuntimeEnvValues{}, "", err
	}
	var browserArgs []string
	if err := json.Unmarshal([]byte(sessionRow.BrowserArgsJSON), &browserArgs); err != nil {
		return browser.RuntimeEnvValues{}, "", fmt.Errorf("parse browser args: %w", err)
	}
	rawSessionToken, err := s.ensureSessionToken(ctx, sessionRow)
	if err != nil {
		return browser.RuntimeEnvValues{}, "", err
	}
	if sessionRow.CurrentCDPPort != nil && *sessionRow.CurrentCDPPort > 0 {
		port := *sessionRow.CurrentCDPPort
		wrapperPort, err := wrapperPortForSession(sessionRow, port)
		if err != nil {
			return browser.RuntimeEnvValues{}, "", err
		}
		return s.runtimeEnvValues(sessionRow, layout, channel, browserArgs, port, wrapperPort, rawSessionToken), layout.RuntimeEnv, nil
	}

	port, err := AllocateCDPPort()
	if err != nil {
		return browser.RuntimeEnvValues{}, "", err
	}
	wrapperPort, err := AllocateCDPPort(port)
	if err != nil {
		return browser.RuntimeEnvValues{}, "", err
	}

	return s.runtimeEnvValues(sessionRow, layout, channel, browserArgs, port, wrapperPort, rawSessionToken), layout.RuntimeEnv, nil
}

func (s *Service) runtimeEnvValues(
	sessionRow *db.Session,
	layout paths.SessionLayout,
	channel browser.Channel,
	browserArgs []string,
	port int,
	wrapperPort int,
	rawSessionToken string,
) browser.RuntimeEnvValues {
	compositorEnabled := s.webrtcCompositorRuntimeEnabled()
	mediaProducerEnabled := s.webrtcMediaProducerRuntimeEnabled()
	internalAPIURL := s.cfg.DeployBlueURL
	if strings.EqualFold(s.cfg.DeployColor, config.DeployColorGreen) {
		internalAPIURL = s.cfg.DeployGreenURL
	}

	return browser.RuntimeEnvValues{
		SessionID:        sessionRow.ID,
		ExternalBaseURL:  s.cfg.ExternalBaseURL,
		SessionToken:     rawSessionToken,
		SessionTokenPath: filepath.Join(layout.Metadata, "session-token"),
		InternalAPIURL:   internalAPIURL,

		MergedUserDataDir:          layout.Merged,
		UpperDir:                   layout.Upper,
		DownloadsDir:               layout.Downloads,
		RecordingsDir:              layout.Recordings,
		CacheDir:                   layout.Cache,
		ArtifactsDir:               layout.Artifacts,
		SessionUploadMaxFileBytes:  s.cfg.SessionUploadMaxFileBytes,
		SessionStorageQuotaBytes:   s.cfg.SessionStorageQuotaBytes,
		CDPPort:                    port,
		WrapperPort:                wrapperPort,
		BrowserExecutable:          channel.Executable,
		BrowserDefaultArgs:         channel.DefaultArgs,
		BrowserExtraArgs:           browserArgs,
		CaptureProofExtensionDir:   s.cfg.WebRTCCaptureProofExtensionDir,
		GPUMode:                    s.cfg.GPUMode,
		CompositorEnabled:          compositorEnabled,
		CompositorExecutable:       s.cfg.WebRTCCompositorExecutable,
		CompositorBackend:          s.cfg.WebRTCCompositorBackend,
		CompositorRenderer:         s.cfg.WebRTCCompositorRenderer,
		CompositorShell:            s.cfg.WebRTCCompositorShell,
		CompositorWidth:            s.cfg.WebRTCCompositorWidth,
		CompositorHeight:           s.cfg.WebRTCCompositorHeight,
		MediaProducerEnabled:       mediaProducerEnabled,
		MediaProducerGSTExecutable: s.cfg.WebRTCMediaProducerGSTExecutable,
		MediaProducerPluginPath:    s.cfg.WebRTCMediaProducerPluginPath,
		MediaProducerTarget:        s.cfg.WebRTCMediaProducerTarget,
		MediaProducerICEServers:    mediaProducerICEServers(s.cfg),
		MediaProducerCodec:         s.cfg.WebRTCMediaProducerCodec,
		MediaProducerFPS:           s.cfg.WebRTCMediaProducerFPS,
		MediaProducerBitrateKbps:   s.cfg.WebRTCMediaProducerBitrateKbps,
		MediaProducerKeyframe:      s.cfg.WebRTCMediaProducerKeyframe,
	}
}

func wrapperPortForSession(sessionRow *db.Session, cdpPort int) (int, error) {
	if sessionRow.RuntimeEnvPath != nil {
		body, err := os.ReadFile(*sessionRow.RuntimeEnvPath)
		if err == nil {
			values, err := browser.ParseRuntimeEnv(body)
			if err == nil && values.WrapperPort > 0 {
				return values.WrapperPort, nil
			}
		}
	}
	return AllocateCDPPort(cdpPort)
}

func wrapperPort(sessionRow *db.Session) (int, error) {
	if sessionRow.Status != db.SessionStatusRunning || sessionRow.RuntimeEnvPath == nil {
		return 0, ErrNotRunning
	}
	body, err := os.ReadFile(*sessionRow.RuntimeEnvPath)
	if err != nil {
		return 0, err
	}
	values, err := browser.ParseRuntimeEnv(body)
	if err != nil {
		return 0, err
	}
	if values.WrapperPort <= 0 {
		return 0, ErrNotRunning
	}
	return values.WrapperPort, nil
}

func (s *Service) touchConnected(ctx context.Context, sessionRow *db.Session) error {
	now := s.now().UTC()
	nowText := now.Format(time.RFC3339Nano)
	sessionRow.LastConnectedAt = &nowText
	sessionRow.ExpiresAt = now.Add(time.Duration(s.cfg.SessionRetentionDays) * 24 * time.Hour).Format(time.RFC3339Nano)
	return s.repo.UpdateSession(ctx, sessionRow)
}

func (s *Service) touchConnectedByID(ctx context.Context, sessionID string) error {
	sessionRow, err := s.repo.GetSessionByID(ctx, sessionID)
	if err != nil {
		return err
	}
	if sessionRow == nil || !retainedSessionAvailable(sessionRow.Status) {
		return nil
	}
	return s.touchConnected(ctx, sessionRow)
}

func (s *Service) waitForRuntimeReady(ctx context.Context, cdpPort, wrapperPort int) error {
	ctx, cancel := context.WithTimeout(ctx, wakeTimeout)
	defer cancel()
	if err := waitForHTTP(ctx, fmt.Sprintf("http://127.0.0.1:%d/json/version", cdpPort)); err != nil {
		return fmt.Errorf("wait for cdp: %w", err)
	}
	if err := waitForHTTP(ctx, fmt.Sprintf("http://127.0.0.1:%d/health", wrapperPort)); err != nil {
		return fmt.Errorf("wait for wrapper: %w", err)
	}
	return nil
}

func waitForHTTP(ctx context.Context, url string) error {
	client := &http.Client{Timeout: time.Second}
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()

	var lastErr error
	for {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return err
		}
		resp, err := client.Do(req)
		if err == nil {
			if resp.StatusCode >= http.StatusOK && resp.StatusCode < http.StatusMultipleChoices {
				_ = resp.Body.Close()
				return nil
			}
			lastErr = fmt.Errorf("status %s", resp.Status)
			_ = resp.Body.Close()
		} else {
			lastErr = err
		}

		select {
		case <-ctx.Done():
			if lastErr != nil {
				return lastErr
			}
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func mediaViewAvailable(status string) bool {
	return status == db.SessionStatusRunning || status == db.SessionStatusSuspended
}

func retainedSessionAvailable(status string) bool {
	return status == db.SessionStatusRunning || status == db.SessionStatusSuspended
}

func retainedActionable(status string) bool {
	switch status {
	case db.SessionStatusRunning, db.SessionStatusSuspended, db.SessionStatusDeleted, db.SessionStatusFailed:
		return true
	default:
		return false
	}
}

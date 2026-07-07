package gc

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/aperture/aperture/internal/browser"
	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/db"
	"github.com/aperture/aperture/internal/paths"
	"github.com/aperture/aperture/internal/sudo"
	"github.com/aperture/aperture/internal/supervisor"
	"github.com/aperture/aperture/internal/systemd"
	"github.com/aperture/aperture/internal/traefik"
)

type gcFakeOverlay struct {
	cfg     config.Config
	mu      sync.Mutex
	mounted map[string]bool
}

func (f *gcFakeOverlay) Mount(_ context.Context, sessionID string, _ *string) error {
	layout, err := paths.Session(f.cfg, sessionID)
	if err != nil {
		return err
	}
	for _, dir := range []string{layout.Upper, layout.Work, layout.Merged, layout.Downloads, layout.Cache, layout.Metadata} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.mounted == nil {
		f.mounted = make(map[string]bool)
	}
	f.mounted[sessionID] = true
	return nil
}

func (f *gcFakeOverlay) Unmount(_ context.Context, sessionID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.mounted, sessionID)
	return nil
}

type gcFakeRunner struct {
	active map[string]bool
}

func (f *gcFakeRunner) Run(_ context.Context, _ string, args ...string) ([]byte, error) {
	if len(args) >= 3 && args[0] == "--user" && args[1] == "stop" {
		delete(f.active, extractGCInstance(args[2]))
	}
	if len(args) >= 3 && args[0] == "--user" && args[1] == "is-active" {
		if f.active[extractGCInstance(args[2])] {
			return []byte("active\n"), nil
		}
		return nil, &systemd.CommandError{ExitCode: 3}
	}
	return []byte("inactive\n"), nil
}

func extractGCInstance(unit string) string {
	at := -1
	for i, r := range unit {
		if r == '@' {
			at = i
		}
	}
	if at < 0 {
		return unit
	}
	end := len(unit)
	if end > 8 && unit[end-8:] == ".service" {
		end -= 8
	}
	return unit[at+1 : end]
}

func newGCTestService(t *testing.T) (*Service, config.Config, *db.Repository, *gcFakeOverlay) {
	t.Helper()

	ctx := context.Background()
	root := t.TempDir()
	cfg := config.Config{
		StoreRoot:               filepath.Join(root, "store"),
		RuntimeRoot:             filepath.Join(root, "runtime"),
		ArtifactRoot:            filepath.Join(root, "artifacts"),
		DatabasePath:            filepath.Join(root, "store", "aperture.db"),
		TraefikDynamicConfigDir: filepath.Join(root, "runtime", "traefik", "dynamic"),
		ListenAddress:           "127.0.0.1:8080",
		SystemdBrowserUnitName:  "browser-session@.service",
		SessionRetentionDays:    7,
		SnapshotRetentionDays:   7,
		ChannelRegistry: map[string]config.ChannelConfig{
			"chromium": {Executable: "/usr/bin/chromium"},
		},
		ExternalBaseURL:  "https://browser.example.test",
		CdpRouteBasePath: "/cdp",
		LogLevel:         "info",
	}

	database, err := db.Open(ctx, cfg.DatabasePath)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := database.Migrate(ctx); err != nil {
		t.Fatalf("migrate database: %v", err)
	}

	repo := db.NewRepository(database)
	channels, err := browser.NewRegistry(cfg)
	if err != nil {
		t.Fatalf("registry: %v", err)
	}
	_ = channels

	runner := &gcFakeRunner{active: make(map[string]bool)}
	browserSupervisor, err := supervisor.NewBrowser(cfg, runner)
	if err != nil {
		t.Fatalf("browser supervisor: %v", err)
	}

	overlay := &gcFakeOverlay{cfg: cfg}
	service := NewService(cfg, repo, browserSupervisor, overlay, traefik.NoopReconciler{})
	fixed := time.Date(2026, 7, 10, 12, 0, 0, 0, time.UTC)
	service.now = func() time.Time { return fixed }
	return service, cfg, repo, overlay
}

func TestGCExpiresDeletedSessionAndRemovesOverlay(t *testing.T) {
	t.Parallel()

	service, cfg, repo, overlay := newGCTestService(t)
	ctx := context.Background()

	tenantID := "018f1234-0000-7000-8000-000000000099"
	if err := repo.CreateTenant(ctx, &db.Tenant{
		ID:          tenantID,
		DisplayName: "acme",
		CreatedAt:   db.NowUTC(),
	}); err != nil {
		t.Fatalf("create tenant: %v", err)
	}

	sessionID := "018f1234-0000-7000-8000-000000000001"
	layout, err := paths.Session(cfg, sessionID)
	if err != nil {
		t.Fatalf("session layout: %v", err)
	}
	if err := overlay.Mount(ctx, sessionID, nil); err != nil {
		t.Fatalf("mount overlay: %v", err)
	}
	if err := os.MkdirAll(layout.Artifacts, 0o755); err != nil {
		t.Fatalf("mkdir artifacts: %v", err)
	}

	expiresAt := time.Date(2026, 7, 9, 12, 0, 0, 0, time.UTC).Format(time.RFC3339Nano)
	deletedAt := expiresAt
	if err := repo.CreateSession(ctx, &db.Session{
		ID:              sessionID,
		TenantID:        tenantID,
		Status:          db.SessionStatusDeleted,
		OverlayPath:     layout.Root,
		UpperPath:       layout.Upper,
		WorkPath:        layout.Work,
		MergedPath:      layout.Merged,
		DownloadsPath:   layout.Downloads,
		CachePath:       layout.Cache,
		ArtifactsPath:   layout.Artifacts,
		BrowserChannel:  "chromium",
		BrowserArgsJSON: "[]",
		CreatedAt:       db.NowUTC(),
		DeletedAt:       &deletedAt,
		ExpiresAt:       expiresAt,
	}); err != nil {
		t.Fatalf("create session: %v", err)
	}

	result, err := service.Run(ctx)
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if result.ExpiredSessions != 1 {
		t.Fatalf("ExpiredSessions = %d, want 1", result.ExpiredSessions)
	}

	sessionRow, err := repo.GetSessionByID(ctx, sessionID)
	if err != nil || sessionRow == nil {
		t.Fatalf("load session: %v", err)
	}
	if sessionRow.Status != db.SessionStatusExpired {
		t.Fatalf("status = %q, want expired", sessionRow.Status)
	}
	if sessionRow.ExpiredAt == nil {
		t.Fatal("expected expired_at to be set")
	}
	if _, err := os.Stat(layout.Upper); !os.IsNotExist(err) {
		t.Fatalf("upper dir still present: %v", err)
	}
	if _, err := os.Stat(layout.Artifacts); err != nil {
		t.Fatalf("artifacts should be retained after session expiry: %v", err)
	}
}

func TestGCCollectsUnreferencedTombstonedSnapshot(t *testing.T) {
	t.Parallel()

	service, cfg, repo, _ := newGCTestService(t)
	ctx := context.Background()

	tenantID := "018f1234-0000-7000-8000-000000000099"
	if err := repo.CreateTenant(ctx, &db.Tenant{
		ID:          tenantID,
		DisplayName: "acme",
		CreatedAt:   db.NowUTC(),
	}); err != nil {
		t.Fatalf("create tenant: %v", err)
	}

	snapshotID := "018f1234-0000-7000-8000-000000000002"
	layout, err := paths.Snapshot(cfg, snapshotID)
	if err != nil {
		t.Fatalf("snapshot layout: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(layout.Profile, "Default"), 0o755); err != nil {
		t.Fatalf("mkdir snapshot profile: %v", err)
	}

	deletedAt := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC).Format(time.RFC3339Nano)
	expiresAt := time.Date(2026, 7, 9, 12, 0, 0, 0, time.UTC).Format(time.RFC3339Nano)
	if err := repo.CreateSnapshot(ctx, &db.Snapshot{
		ID:        snapshotID,
		TenantID:  tenantID,
		Name:      "old-snapshot",
		Path:      layout.Root,
		CreatedAt: db.NowUTC(),
		DeletedAt: &deletedAt,
		ExpiresAt: &expiresAt,
	}); err != nil {
		t.Fatalf("create snapshot: %v", err)
	}

	result, err := service.Run(ctx)
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if result.CollectedSnapshots != 1 {
		t.Fatalf("CollectedSnapshots = %d, want 1", result.CollectedSnapshots)
	}

	snapshotRow, err := repo.GetSnapshotByID(ctx, snapshotID)
	if err != nil || snapshotRow == nil {
		t.Fatalf("load snapshot: %v", err)
	}
	if snapshotRow.GCCompletedAt == nil {
		t.Fatal("expected gc_completed_at to be set")
	}
	if _, err := os.Stat(layout.Root); !os.IsNotExist(err) {
		t.Fatalf("snapshot root still present: %v", err)
	}
}

func TestGCSkipsSnapshotReferencedByRetainedSession(t *testing.T) {
	t.Parallel()

	service, cfg, repo, _ := newGCTestService(t)
	ctx := context.Background()

	tenantID := "018f1234-0000-7000-8000-000000000099"
	if err := repo.CreateTenant(ctx, &db.Tenant{
		ID:          tenantID,
		DisplayName: "acme",
		CreatedAt:   db.NowUTC(),
	}); err != nil {
		t.Fatalf("create tenant: %v", err)
	}

	snapshotID := "018f1234-0000-7000-8000-000000000003"
	layout, err := paths.Snapshot(cfg, snapshotID)
	if err != nil {
		t.Fatalf("snapshot layout: %v", err)
	}
	if err := os.MkdirAll(layout.Profile, 0o755); err != nil {
		t.Fatalf("mkdir snapshot profile: %v", err)
	}

	deletedAt := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC).Format(time.RFC3339Nano)
	expiresAt := time.Date(2026, 7, 9, 12, 0, 0, 0, time.UTC).Format(time.RFC3339Nano)
	if err := repo.CreateSnapshot(ctx, &db.Snapshot{
		ID:        snapshotID,
		TenantID:  tenantID,
		Name:      "referenced",
		Path:      layout.Root,
		CreatedAt: db.NowUTC(),
		DeletedAt: &deletedAt,
		ExpiresAt: &expiresAt,
	}); err != nil {
		t.Fatalf("create snapshot: %v", err)
	}

	sessionID := "018f1234-0000-7000-8000-000000000004"
	sessionLayout, err := paths.Session(cfg, sessionID)
	if err != nil {
		t.Fatalf("session layout: %v", err)
	}
	retainedExpires := time.Date(2026, 7, 11, 12, 0, 0, 0, time.UTC).Format(time.RFC3339Nano)
	if err := repo.CreateSession(ctx, &db.Session{
		ID:              sessionID,
		TenantID:        tenantID,
		BaseSnapshotID:  &snapshotID,
		Status:          db.SessionStatusDeleted,
		OverlayPath:     sessionLayout.Root,
		UpperPath:       sessionLayout.Upper,
		WorkPath:        sessionLayout.Work,
		MergedPath:      sessionLayout.Merged,
		DownloadsPath:   sessionLayout.Downloads,
		CachePath:       sessionLayout.Cache,
		ArtifactsPath:   sessionLayout.Artifacts,
		BrowserChannel:  "chromium",
		BrowserArgsJSON: "[]",
		CreatedAt:       db.NowUTC(),
		ExpiresAt:       retainedExpires,
	}); err != nil {
		t.Fatalf("create session: %v", err)
	}

	result, err := service.Run(ctx)
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if result.CollectedSnapshots != 0 {
		t.Fatalf("CollectedSnapshots = %d, want 0", result.CollectedSnapshots)
	}
	if _, err := os.Stat(layout.Root); err != nil {
		t.Fatalf("snapshot should remain while referenced: %v", err)
	}
}

type gcUnmountFailOverlay struct {
	*gcFakeOverlay
}

func (gcUnmountFailOverlay) Unmount(context.Context, string) error {
	return errors.New("simulated unmount failure")
}

func TestGCAbortExpireWhenOverlayUnmountFails(t *testing.T) {
	if os.Geteuid() != 0 && os.Getenv("APERTURE_RUN_OVERLAY_TESTS") == "" {
		t.Skip("overlay gc test requires root or APERTURE_RUN_OVERLAY_TESTS=1")
	}

	service, cfg, repo, overlay := newGCTestService(t)
	ctx := context.Background()

	tenantID := "018f1234-0000-7000-8000-000000000099"
	if err := repo.CreateTenant(ctx, &db.Tenant{
		ID:          tenantID,
		DisplayName: "acme",
		CreatedAt:   db.NowUTC(),
	}); err != nil {
		t.Fatalf("create tenant: %v", err)
	}

	sessionID := "018f1234-0000-7000-8000-000000000005"
	layout, err := paths.Session(cfg, sessionID)
	if err != nil {
		t.Fatalf("session layout: %v", err)
	}
	emptyLower, err := paths.EmptyLowerDir(cfg)
	if err != nil {
		t.Fatalf("empty lower: %v", err)
	}
	if err := os.MkdirAll(emptyLower, 0o755); err != nil {
		t.Fatalf("mkdir empty lower: %v", err)
	}
	if err := overlay.Mount(ctx, sessionID, nil); err != nil {
		t.Fatalf("prepare overlay dirs: %v", err)
	}
	if err := sudo.MountSession(ctx, cfg, sudo.MountRequest{SessionID: sessionID, Empty: true}); err != nil {
		t.Fatalf("mount overlay: %v", err)
	}
	t.Cleanup(func() { _ = sudo.UnmountSession(context.Background(), cfg, sessionID) })

	expiresAt := time.Date(2026, 7, 9, 12, 0, 0, 0, time.UTC).Format(time.RFC3339Nano)
	if err := repo.CreateSession(ctx, &db.Session{
		ID:              sessionID,
		TenantID:        tenantID,
		Status:          db.SessionStatusDeleted,
		OverlayPath:     layout.Root,
		UpperPath:       layout.Upper,
		WorkPath:        layout.Work,
		MergedPath:      layout.Merged,
		DownloadsPath:   layout.Downloads,
		CachePath:       layout.Cache,
		ArtifactsPath:   layout.Artifacts,
		BrowserChannel:  "chromium",
		BrowserArgsJSON: "[]",
		CreatedAt:       db.NowUTC(),
		ExpiresAt:       expiresAt,
	}); err != nil {
		t.Fatalf("create session: %v", err)
	}

	failService := NewService(cfg, repo, service.browser, gcUnmountFailOverlay{gcFakeOverlay: overlay}, traefik.NoopReconciler{})
	failService.now = service.now

	_, err = failService.Run(ctx)
	if err == nil {
		t.Fatal("expected gc to fail when overlay unmount fails")
	}
	var unmountErr *SessionOverlayUnmountError
	if !errors.As(err, &unmountErr) {
		t.Fatalf("error = %v, want SessionOverlayUnmountError", err)
	}

	sessionRow, err := repo.GetSessionByID(ctx, sessionID)
	if err != nil || sessionRow == nil {
		t.Fatalf("load session: %v", err)
	}
	if sessionRow.Status == db.SessionStatusExpired {
		t.Fatal("session should not be marked expired when unmount fails")
	}
}

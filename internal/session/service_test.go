package session

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aperture/aperture/internal/browser"
	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/db"
	"github.com/aperture/aperture/internal/gc"
	"github.com/aperture/aperture/internal/paths"
	"github.com/aperture/aperture/internal/supervisor"
	"github.com/aperture/aperture/internal/systemd"
	"github.com/aperture/aperture/internal/traefik"
)

type fakeOverlay struct {
	cfg     config.Config
	mu      sync.Mutex
	mounted map[string]bool
}

func (f *fakeOverlay) Mount(_ context.Context, sessionID string, _ *string) error {
	layout, err := paths.Session(f.cfg, sessionID)
	if err != nil {
		return err
	}
	for _, dir := range []string{layout.Upper, layout.Work, layout.Merged, layout.Files.Downloads, layout.Cache} {
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

func (f *fakeOverlay) Unmount(_ context.Context, sessionID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.mounted, sessionID)
	return nil
}

type fakeRunner struct {
	active          map[string]bool
	failNextStart   bool
	failNextStop    bool
	beforeListUnits func()
}

func (f *fakeRunner) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	if len(args) >= 3 && args[0] == "--user" && args[1] == "start" {
		sessionID := extractInstance(args[2])
		if f.failNextStart {
			f.failNextStart = false
			return nil, &systemd.CommandError{Operation: "start", ExitCode: 1, Err: errors.New("simulated browser start failure")}
		}
		f.active[sessionID] = true
	}
	if len(args) >= 3 && args[0] == "--user" && args[1] == "stop" {
		sessionID := extractInstance(args[2])
		if f.failNextStop {
			f.failNextStop = false
			return nil, &systemd.CommandError{Operation: "stop", ExitCode: 1, Err: errors.New("simulated browser stop failure")}
		}
		delete(f.active, sessionID)
	}
	if len(args) >= 3 && args[0] == "--user" && args[1] == "is-active" {
		sessionID := extractInstance(args[2])
		if f.active[sessionID] {
			return []byte("active\n"), nil
		}
		return nil, &systemd.CommandError{ExitCode: 3}
	}
	if len(args) >= 4 && args[0] == "--user" && args[1] == "list-units" {
		if f.beforeListUnits != nil {
			beforeList := f.beforeListUnits
			f.beforeListUnits = nil
			beforeList()
		}
		return f.listUnitsOutput(), nil
	}
	return []byte("inactive\n"), nil
}

func (f *fakeRunner) listUnitsOutput() []byte {
	lines := make([]string, 0, len(f.active))
	for sessionID := range f.active {
		lines = append(lines, fmt.Sprintf("browser-session@%s.service loaded active running", sessionID))
	}
	return []byte(strings.Join(lines, "\n") + "\n")
}

func (f *fakeOverlay) IsMounted(sessionID string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.mounted[sessionID]
}

func extractInstance(unit string) string {
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

func newTestService(t *testing.T) (*Service, config.Config, *db.Repository, *fakeRunner, *fakeOverlay) {
	t.Helper()

	ctx := context.Background()
	root := t.TempDir()
	cfg := config.Config{
		StoreRoot:               filepath.Join(root, "store"),
		ColdRoot:                filepath.Join(root, "cold"),
		RuntimeRoot:             filepath.Join(root, "runtime"),
		ArtifactRoot:            filepath.Join(root, "artifacts"),
		DatabasePath:            filepath.Join(root, "store", "aperture.db"),
		TraefikDynamicConfigDir: filepath.Join(root, "runtime", "traefik", "dynamic"),
		ListenAddress:           "127.0.0.1:8080",
		BrowserSupervisor:       config.BrowserSupervisorSystemd,
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
	runner := &fakeRunner{active: make(map[string]bool)}
	browserSupervisor, err := supervisor.NewBrowser(cfg, runner)
	if err != nil {
		t.Fatalf("browser supervisor: %v", err)
	}

	overlay := &fakeOverlay{cfg: cfg}
	service := NewService(cfg, repo, overlay, browserSupervisor, channels, traefik.NoopReconciler{})
	service.SetCDPReadyWaiter(func(context.Context, int) error { return nil })
	service.now = func() time.Time {
		return time.Date(2026, 7, 3, 12, 0, 0, 0, time.UTC)
	}
	return service, cfg, repo, runner, overlay
}

func createTenant(t *testing.T, repo *db.Repository) string {
	t.Helper()
	tenantID := "018f1234-0000-7000-8000-000000000099"
	if err := repo.CreateTenant(context.Background(), &db.Tenant{
		ID:          tenantID,
		DisplayName: "acme",
		CreatedAt:   db.NowUTC(),
	}); err != nil {
		t.Fatalf("create tenant: %v", err)
	}
	return tenantID
}

func TestDeleteSessionReclaimsStorage(t *testing.T) {
	t.Parallel()

	service, cfg, repo, runner, overlay := newTestService(t)
	tenantID := createTenant(t, repo)
	ctx := context.Background()

	created, err := service.Create(ctx, CreateInput{
		TenantID:       tenantID,
		BrowserChannel: "chromium",
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if created.Session.Status != db.SessionStatusRunning {
		t.Fatalf("status = %q, want running", created.Session.Status)
	}
	if created.SessionToken == "" {
		t.Fatal("expected session token")
	}

	layout, err := paths.Session(cfg, created.Session.ID)
	if err != nil {
		t.Fatalf("derive session paths: %v", err)
	}
	for _, dir := range []string{layout.Upper, layout.Work, layout.Merged, layout.Cache, layout.Metadata,
		layout.Files.Downloads, layout.Files.Uploads, layout.Files.Recordings, layout.Files.Outputs, layout.Logs, layout.CrashDumps} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "data"), []byte("session data"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	deleted, err := service.Delete(ctx, tenantID, created.Session.ID)
	if err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	if deleted.Session.Status != db.SessionStatusExpired || deleted.Session.DeletedAt == nil || deleted.Session.ExpiredAt == nil {
		t.Fatalf("deleted session = %#v, want deleted and expired metadata", deleted.Session)
	}
	if deleted.Session.ExpiresAt != service.now().UTC().Format(time.RFC3339Nano) {
		t.Fatalf("expiry = %q, want immediate expiry", deleted.Session.ExpiresAt)
	}
	if deleted.SessionToken != "" || deleted.CDPURL != "" {
		t.Fatal("deleted session returned access credentials")
	}
	if runner.active[created.Session.ID] || overlay.IsMounted(created.Session.ID) {
		t.Fatal("deleted session remains active or mounted")
	}
	for _, path := range []string{layout.Root, filepath.Dir(layout.Files.Root), layout.Artifacts, layout.RuntimeEnv} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("session path %s remains: %v", path, err)
		}
	}
	if _, err := service.Reopen(ctx, tenantID, created.Session.ID); !errors.Is(err, ErrExpired) {
		t.Fatalf("Reopen() error = %v, want expired", err)
	}
	if _, err := service.RotateSessionToken(ctx, tenantID, created.Session.ID); !errors.Is(err, ErrExpired) {
		t.Fatalf("RotateSessionToken() error = %v, want expired", err)
	}
	if _, err := service.Delete(ctx, tenantID, created.Session.ID); err != nil {
		t.Fatalf("repeat Delete() error = %v", err)
	}
}

func TestDeleteSessionInRetainedAndExpiredStates(t *testing.T) {
	for _, status := range []string{db.SessionStatusSuspended, db.SessionStatusFailed, db.SessionStatusDeleted, db.SessionStatusExpired} {
		t.Run(status, func(t *testing.T) {
			t.Parallel()
			service, cfg, repo, runner, overlay := newTestService(t)
			tenantID := createTenant(t, repo)
			ctx := context.Background()
			created, err := service.Create(ctx, CreateInput{TenantID: tenantID, BrowserChannel: "chromium"})
			if err != nil {
				t.Fatal(err)
			}
			row := created.Session
			row.Status = status
			if status == db.SessionStatusExpired {
				row.ExpiresAt = service.now().Add(-time.Hour).Format(time.RFC3339Nano)
			}
			if err := repo.UpdateSession(ctx, &row); err != nil {
				t.Fatal(err)
			}
			if _, err := service.Delete(ctx, tenantID, row.ID); err != nil {
				t.Fatalf("Delete() error = %v", err)
			}
			layout, err := paths.Session(cfg, row.ID)
			if err != nil {
				t.Fatal(err)
			}
			if runner.active[row.ID] || overlay.IsMounted(row.ID) {
				t.Fatal("non-running lifecycle status left its browser or overlay active")
			}
			for _, path := range []string{layout.Root, filepath.Dir(layout.Files.Root), layout.Artifacts} {
				if _, err := os.Stat(path); !os.IsNotExist(err) {
					t.Fatalf("session path %s remains: %v", path, err)
				}
			}
		})
	}
}

func TestDeleteFailureIsClosedAndRetriedByGC(t *testing.T) {
	for _, operation := range []string{"stop", "unmount"} {
		t.Run(operation, func(t *testing.T) {
			t.Parallel()
			service, cfg, repo, runner, overlay := newTestService(t)
			tenantID := createTenant(t, repo)
			ctx := context.Background()
			created, err := service.Create(ctx, CreateInput{TenantID: tenantID, BrowserChannel: "chromium"})
			if err != nil {
				t.Fatal(err)
			}
			layout, err := paths.Session(cfg, created.Session.ID)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.MkdirAll(layout.Logs, 0o755); err != nil {
				t.Fatal(err)
			}
			if operation == "stop" {
				runner.failNextStop = true
			} else {
				service.unmountLocal = func(context.Context, string) error {
					return errors.New("simulated unmount failure")
				}
			}
			if _, err := service.Delete(ctx, tenantID, created.Session.ID); err == nil {
				t.Fatal("Delete() succeeded despite cleanup failure")
			}
			row, err := repo.GetSessionByID(ctx, created.Session.ID)
			if err != nil {
				t.Fatal(err)
			}
			if row.Status != db.SessionStatusDeleted || row.ExpiresAt != service.now().Format(time.RFC3339Nano) {
				t.Fatalf("failed deletion = %#v, want immediately eligible GC retry", row)
			}
			if _, err := os.Stat(layout.Upper); err != nil {
				t.Fatalf("storage removed before safe shutdown: %v", err)
			}
			if _, err := service.Reopen(ctx, tenantID, row.ID); !errors.Is(err, ErrExpired) {
				t.Fatalf("Reopen() error = %v, want expired", err)
			}
			collector := gc.NewService(cfg, repo, service.browser, overlay, traefik.NoopReconciler{})
			if _, err := collector.Run(ctx); err != nil {
				t.Fatalf("GC retry: %v", err)
			}
			for _, path := range []string{layout.Root, filepath.Dir(layout.Files.Root), layout.Artifacts, layout.RuntimeEnv} {
				if _, err := os.Stat(path); !os.IsNotExist(err) {
					t.Fatalf("GC retry left %s: %v", path, err)
				}
			}
			if runner.active[row.ID] {
				t.Fatal("GC retry left deleted browser running")
			}
		})
	}
}

func TestReopenFailedSessionRetries(t *testing.T) {
	t.Parallel()

	service, _, repo, _, _ := newTestService(t)
	tenantID := createTenant(t, repo)
	ctx := context.Background()

	created, err := service.Create(ctx, CreateInput{
		TenantID:       tenantID,
		BrowserChannel: "chromium",
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	sessionRow, err := repo.GetSessionByID(ctx, created.Session.ID)
	if err != nil || sessionRow == nil {
		t.Fatalf("load session: %v", err)
	}
	if err := service.markFailedRetained(ctx, sessionRow, "simulated failure", errors.New("boom")); err != nil {
		t.Fatalf("mark failed: %v", err)
	}

	reopened, err := service.Reopen(ctx, tenantID, created.Session.ID)
	if err != nil {
		t.Fatalf("Reopen() error = %v", err)
	}
	if reopened.Session.Status != db.SessionStatusRunning {
		t.Fatalf("status = %q, want running", reopened.Session.Status)
	}
	tokenRow, err := repo.GetSessionToken(ctx, created.Session.ID)
	if err != nil {
		t.Fatalf("load session token: %v", err)
	}
	if tokenRow == nil || tokenRow.RawToken == nil || *tokenRow.RawToken == "" {
		t.Fatal("session token missing")
	}
}

func TestReconcileStartupMarksInactiveRunningSessionsFailed(t *testing.T) {
	t.Parallel()

	service, _, repo, runner, _ := newTestService(t)
	tenantID := createTenant(t, repo)
	ctx := context.Background()

	created, err := service.Create(ctx, CreateInput{
		TenantID:       tenantID,
		BrowserChannel: "chromium",
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	delete(runner.active, created.Session.ID)

	if err := service.ReconcileStartup(ctx); err != nil {
		t.Fatalf("ReconcileStartup() error = %v", err)
	}

	sessionRow, err := repo.GetSessionByID(ctx, created.Session.ID)
	if err != nil || sessionRow == nil {
		t.Fatalf("load session: %v", err)
	}
	if sessionRow.Status != db.SessionStatusFailed {
		t.Fatalf("status = %q, want failed", sessionRow.Status)
	}
}

func TestReopenFailureAfterMountCleansUpAndRetainsFailedSession(t *testing.T) {
	t.Parallel()

	service, cfg, repo, runner, overlay := newTestService(t)
	tenantID := createTenant(t, repo)
	ctx := context.Background()

	created, err := service.Create(ctx, CreateInput{
		TenantID:       tenantID,
		BrowserChannel: "chromium",
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	if err := service.markFailedRetained(ctx, &created.Session, "simulated failure", errors.New("boom")); err != nil {
		t.Fatalf("mark failed: %v", err)
	}

	runner.failNextStart = true
	_, err = service.Reopen(ctx, tenantID, created.Session.ID)
	if err == nil {
		t.Fatal("expected reopen failure")
	}

	sessionRow, err := repo.GetSessionByID(ctx, created.Session.ID)
	if err != nil || sessionRow == nil {
		t.Fatalf("load session: %v", err)
	}
	if sessionRow.Status != db.SessionStatusFailed {
		t.Fatalf("status = %q, want failed", sessionRow.Status)
	}
	if sessionRow.RuntimeEnvPath != nil {
		t.Fatalf("runtime env path = %#v, want nil", sessionRow.RuntimeEnvPath)
	}
	if overlay.IsMounted(created.Session.ID) {
		t.Fatal("expected overlay to be unmounted after reopen failure")
	}

	layout, err := paths.Session(cfg, created.Session.ID)
	if err != nil {
		t.Fatalf("derive session paths: %v", err)
	}
	if _, err := os.Stat(layout.RuntimeEnv); !os.IsNotExist(err) {
		t.Fatalf("runtime env file still present: %v", err)
	}

	events, err := repo.ListEventsForResource(ctx, "session", created.Session.ID)
	if err != nil {
		t.Fatalf("list events: %v", err)
	}
	if len(events) == 0 || events[len(events)-1].Type != "session.reopen_failed" {
		t.Fatalf("events = %#v, want session.reopen_failed", events)
	}
}

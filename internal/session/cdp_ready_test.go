package session

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aperture/aperture/internal/browser"
	"github.com/aperture/aperture/internal/db"
	"github.com/aperture/aperture/internal/paths"
)

func testServerPort(t *testing.T, server *httptest.Server) int {
	t.Helper()

	parsed, err := url.Parse(server.URL)
	if err != nil {
		t.Fatalf("parse test server url: %v", err)
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil {
		t.Fatalf("parse test server port: %v", err)
	}
	return port
}

func TestWaitForCDPEndpointWaitsForWrapperDiscovery(t *testing.T) {
	t.Parallel()

	var attempts atomic.Int32
	var role atomic.Value
	var probedPath atomic.Value
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		probedPath.Store(req.URL.Path)
		role.Store(req.Header.Get("X-Aperture-Collaboration-Role"))
		if attempts.Add(1) < 3 {
			// What the wrapper serves while the browser is still starting.
			http.NotFound(w, req)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"Browser":"Chrome/151.0.0.0"}`))
	}))
	defer server.Close()

	if err := waitForCDPEndpoint(context.Background(), testServerPort(t, server)); err != nil {
		t.Fatalf("waitForCDPEndpoint() error = %v", err)
	}
	if got := attempts.Load(); got < 3 {
		t.Fatalf("attempts = %d, want the probe to keep polling until the endpoint answered", got)
	}
	if got := probedPath.Load(); got != "/json/version" {
		t.Fatalf("probed path = %v, want /json/version", got)
	}
	if got := role.Load(); got != "owner" {
		t.Fatalf("collaboration role header = %v, want owner", got)
	}
}

func TestWaitForCDPEndpointFailsWhenEndpointNeverAnswers(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(http.NotFound))
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 1200*time.Millisecond)
	defer cancel()

	err := waitForCDPEndpoint(ctx, testServerPort(t, server))
	if err == nil {
		t.Fatal("waitForCDPEndpoint() error = nil, want a bounded failure")
	}
	if !strings.Contains(err.Error(), "404") {
		t.Fatalf("error = %v, want the last probe failure reported", err)
	}
}

func TestCreateReportsRunningOnlyAfterCDPReady(t *testing.T) {
	t.Parallel()

	service, cfg, repo, _, _ := newTestService(t)
	tenantID := createTenant(t, repo)
	ctx := context.Background()

	var probedPort int
	var probed bool
	service.SetCDPReadyWaiter(func(probeCtx context.Context, wrapperPort int) error {
		probed = true
		probedPort = wrapperPort

		running, err := repo.ListSessionsByStatus(probeCtx, db.SessionStatusRunning)
		if err != nil {
			return err
		}
		if len(running) != 0 {
			t.Errorf("session reported running while its cdp endpoint was still being probed")
		}
		creating, err := repo.ListSessionsByStatus(probeCtx, db.SessionStatusCreating)
		if err != nil {
			return err
		}
		if len(creating) != 1 {
			t.Errorf("creating sessions = %d, want 1 while the cdp endpoint is probed", len(creating))
		}
		return nil
	})

	created, err := service.Create(ctx, CreateInput{TenantID: tenantID, BrowserChannel: "chromium"})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if !probed {
		t.Fatal("Create() did not probe the cdp endpoint")
	}
	if created.Session.Status != db.SessionStatusRunning {
		t.Fatalf("status = %q, want running", created.Session.Status)
	}

	layout, err := paths.Session(cfg, created.Session.ID)
	if err != nil {
		t.Fatalf("session paths: %v", err)
	}
	body, err := os.ReadFile(layout.RuntimeEnv)
	if err != nil {
		t.Fatalf("read runtime env: %v", err)
	}
	values, err := browser.ParseRuntimeEnv(body)
	if err != nil {
		t.Fatalf("parse runtime env: %v", err)
	}
	if probedPort != values.WrapperPort {
		t.Fatalf("probed port = %d, want the session wrapper port %d", probedPort, values.WrapperPort)
	}
}

func TestCreateMarksSessionFailedWhenCDPNeverReady(t *testing.T) {
	t.Parallel()

	service, _, repo, runner, _ := newTestService(t)
	tenantID := createTenant(t, repo)
	ctx := context.Background()

	service.SetCDPReadyWaiter(func(context.Context, int) error {
		return errors.New("wait for cdp endpoint: context deadline exceeded")
	})

	_, err := service.Create(ctx, CreateInput{TenantID: tenantID, BrowserChannel: "chromium"})
	if !errors.Is(err, ErrBrowserStart) {
		t.Fatalf("Create() error = %v, want %v", err, ErrBrowserStart)
	}

	sessions, err := repo.ListSessionsByStatus(ctx, db.SessionStatusFailed)
	if err != nil {
		t.Fatalf("list failed sessions: %v", err)
	}
	if len(sessions) != 1 {
		t.Fatalf("failed sessions = %d, want 1", len(sessions))
	}
	failed := sessions[0]
	if failed.RuntimeEnvPath != nil || failed.CurrentCDPPort != nil {
		t.Fatal("failed session kept its runtime handles")
	}
	if len(runner.active) != 0 {
		t.Fatal("failed session left its browser unit running")
	}

	events, err := repo.ListEventsForResourceType(ctx, "session", failed.ID, "session.failed")
	if err != nil {
		t.Fatalf("list session events: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("session.failed events = %d, want 1", len(events))
	}
	if !strings.Contains(events[0].Message, "cdp endpoint") {
		t.Fatalf("event message = %q, want it to name the cdp readiness failure", events[0].Message)
	}
}

func TestCreateMarksSessionFailedWhenClientCancelsDuringProbe(t *testing.T) {
	t.Parallel()

	service, _, repo, _, _ := newTestService(t)
	tenantID := createTenant(t, repo)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	service.SetCDPReadyWaiter(func(probeCtx context.Context, _ int) error {
		cancel()
		<-probeCtx.Done()
		return probeCtx.Err()
	})

	if _, err := service.Create(ctx, CreateInput{TenantID: tenantID, BrowserChannel: "chromium"}); err == nil {
		t.Fatal("Create() error = nil, want the cancelled readiness wait to fail")
	}

	creating, err := repo.ListSessionsByStatus(context.Background(), db.SessionStatusCreating)
	if err != nil {
		t.Fatalf("list creating sessions: %v", err)
	}
	if len(creating) != 0 {
		t.Fatal("a cancelled create left its session stuck in creating")
	}
	failed, err := repo.ListSessionsByStatus(context.Background(), db.SessionStatusFailed)
	if err != nil {
		t.Fatalf("list failed sessions: %v", err)
	}
	if len(failed) != 1 {
		t.Fatalf("failed sessions = %d, want 1", len(failed))
	}
}

func TestReopenReportsRunningOnlyAfterCDPReady(t *testing.T) {
	t.Parallel()

	service, _, repo, _, _ := newTestService(t)
	tenantID := createTenant(t, repo)
	ctx := context.Background()

	created, err := service.Create(ctx, CreateInput{TenantID: tenantID, BrowserChannel: "chromium"})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, err := service.Delete(ctx, tenantID, created.Session.ID); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}

	var probed bool
	service.SetCDPReadyWaiter(func(probeCtx context.Context, _ int) error {
		probed = true
		sessionRow, err := repo.GetSessionByID(probeCtx, created.Session.ID)
		if err != nil {
			return err
		}
		if sessionRow.Status != db.SessionStatusCreating {
			t.Errorf("status during reopen probe = %q, want creating", sessionRow.Status)
		}
		return nil
	})

	reopened, err := service.Reopen(ctx, tenantID, created.Session.ID)
	if err != nil {
		t.Fatalf("Reopen() error = %v", err)
	}
	if !probed {
		t.Fatal("Reopen() did not probe the cdp endpoint")
	}
	if reopened.Session.Status != db.SessionStatusRunning {
		t.Fatalf("status = %q, want running", reopened.Session.Status)
	}
}

func TestReopenMarksSessionFailedWhenCDPNeverReady(t *testing.T) {
	t.Parallel()

	service, _, repo, runner, _ := newTestService(t)
	tenantID := createTenant(t, repo)
	ctx := context.Background()

	created, err := service.Create(ctx, CreateInput{TenantID: tenantID, BrowserChannel: "chromium"})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, err := service.Delete(ctx, tenantID, created.Session.ID); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}

	service.SetCDPReadyWaiter(func(context.Context, int) error {
		return errors.New("wait for cdp endpoint: context deadline exceeded")
	})

	if _, err := service.Reopen(ctx, tenantID, created.Session.ID); !errors.Is(err, ErrBrowserStart) {
		t.Fatalf("Reopen() error = %v, want %v", err, ErrBrowserStart)
	}

	sessionRow, err := repo.GetSessionByID(ctx, created.Session.ID)
	if err != nil {
		t.Fatalf("load session: %v", err)
	}
	if sessionRow.Status != db.SessionStatusFailed {
		t.Fatalf("status = %q, want failed", sessionRow.Status)
	}
	if len(runner.active) != 0 {
		t.Fatal("failed reopen left its browser unit running")
	}
}

func TestWakeReportsRunningOnlyAfterCDPReady(t *testing.T) {
	t.Parallel()

	service, _, repo, _, _ := newTestService(t)
	tenantID := createTenant(t, repo)
	ctx := context.Background()

	created, err := service.Create(ctx, CreateInput{TenantID: tenantID, BrowserChannel: "chromium"})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, err := service.Suspend(ctx, tenantID, created.Session.ID); err != nil {
		t.Fatalf("Suspend() error = %v", err)
	}

	var probed bool
	service.SetCDPReadyWaiter(func(probeCtx context.Context, _ int) error {
		probed = true
		sessionRow, err := repo.GetSessionByID(probeCtx, created.Session.ID)
		if err != nil {
			return err
		}
		if sessionRow.Status == db.SessionStatusRunning {
			t.Error("session reported running while its cdp endpoint was still being probed")
		}
		return nil
	})

	_, release, err := service.AcquireCDPPort(ctx, tenantID, created.Session.ID)
	if err != nil {
		t.Fatalf("AcquireCDPPort() error = %v", err)
	}
	release()
	if !probed {
		t.Fatal("waking the session did not probe the cdp endpoint")
	}

	sessionRow, err := repo.GetSessionByID(ctx, created.Session.ID)
	if err != nil {
		t.Fatalf("load session: %v", err)
	}
	if sessionRow.Status != db.SessionStatusRunning {
		t.Fatalf("status = %q, want running", sessionRow.Status)
	}
}

func TestWakeMarksSessionFailedWhenCDPNeverReady(t *testing.T) {
	t.Parallel()

	service, _, repo, runner, _ := newTestService(t)
	tenantID := createTenant(t, repo)
	ctx := context.Background()

	created, err := service.Create(ctx, CreateInput{TenantID: tenantID, BrowserChannel: "chromium"})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, err := service.Suspend(ctx, tenantID, created.Session.ID); err != nil {
		t.Fatalf("Suspend() error = %v", err)
	}

	service.SetCDPReadyWaiter(func(context.Context, int) error {
		return errors.New("wait for cdp endpoint: context deadline exceeded")
	})

	if _, _, err := service.AcquireCDPPort(ctx, tenantID, created.Session.ID); !errors.Is(err, ErrBrowserStart) {
		t.Fatalf("AcquireCDPPort() error = %v, want %v", err, ErrBrowserStart)
	}

	sessionRow, err := repo.GetSessionByID(ctx, created.Session.ID)
	if err != nil {
		t.Fatalf("load session: %v", err)
	}
	if sessionRow.Status != db.SessionStatusFailed {
		t.Fatalf("status = %q, want failed", sessionRow.Status)
	}
	if len(runner.active) != 0 {
		t.Fatal("failed wake left its browser unit running")
	}
}

func TestReconcileStartupMarksCreatingSessionFailed(t *testing.T) {
	t.Parallel()

	service, _, repo, _, _ := newTestService(t)
	tenantID := createTenant(t, repo)
	ctx := context.Background()

	sessionID := "018f1234-0000-7000-8000-0000000000c1"
	now := service.now().UTC()
	if err := repo.CreateSession(ctx, &db.Session{
		ID:              sessionID,
		TenantID:        tenantID,
		Status:          db.SessionStatusCreating,
		BrowserChannel:  "chromium",
		BrowserArgsJSON: "[]",
		CreatedAt:       now.Format(time.RFC3339Nano),
		ExpiresAt:       now.Add(24 * time.Hour).Format(time.RFC3339Nano),
	}); err != nil {
		t.Fatalf("create session: %v", err)
	}

	if err := service.ReconcileStartup(ctx); err != nil {
		t.Fatalf("ReconcileStartup() error = %v", err)
	}

	sessionRow, err := repo.GetSessionByID(ctx, sessionID)
	if err != nil {
		t.Fatalf("load session: %v", err)
	}
	if sessionRow.Status != db.SessionStatusFailed {
		t.Fatalf("status = %q, want failed", sessionRow.Status)
	}
}

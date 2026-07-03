package session

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/aperture/aperture/internal/db"
	"github.com/aperture/aperture/internal/paths"
)

func TestReconcileStartupMarksExpiredRunningSessionFailed(t *testing.T) {
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

	past := service.now().UTC().Add(-time.Hour).Format(time.RFC3339Nano)
	sessionRow, err := repo.GetSessionByID(ctx, created.Session.ID)
	if err != nil || sessionRow == nil {
		t.Fatalf("load session: %v", err)
	}
	sessionRow.ExpiresAt = past
	if err := repo.UpdateSession(ctx, sessionRow); err != nil {
		t.Fatalf("backdate lease: %v", err)
	}
	runner.active[created.Session.ID] = true

	if err := service.ReconcileStartup(ctx); err != nil {
		t.Fatalf("ReconcileStartup() error = %v", err)
	}

	sessionRow, err = repo.GetSessionByID(ctx, created.Session.ID)
	if err != nil || sessionRow == nil {
		t.Fatalf("load session: %v", err)
	}
	if sessionRow.Status != db.SessionStatusFailed {
		t.Fatalf("status = %q, want failed", sessionRow.Status)
	}
	if runner.active[created.Session.ID] {
		t.Fatal("expected expired running unit to be stopped")
	}
}

func TestReconcileStartupStopsOrphanActiveUnit(t *testing.T) {
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

	if _, err := service.Delete(ctx, tenantID, created.Session.ID); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}

	runner.active[created.Session.ID] = true

	if err := service.ReconcileStartup(ctx); err != nil {
		t.Fatalf("ReconcileStartup() error = %v", err)
	}
	if runner.active[created.Session.ID] {
		t.Fatal("expected orphan active unit to be stopped")
	}
}

func TestReconcileStartupRemovesStaleRuntimeEnv(t *testing.T) {
	t.Parallel()

	service, cfg, repo, _, _ := newTestService(t)
	tenantID := createTenant(t, repo)
	ctx := context.Background()

	created, err := service.Create(ctx, CreateInput{
		TenantID:       tenantID,
		BrowserChannel: "chromium",
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	if _, err := service.Delete(ctx, tenantID, created.Session.ID); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}

	layout, err := paths.Session(cfg, created.Session.ID)
	if err != nil {
		t.Fatalf("session layout: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(layout.RuntimeEnv), 0o700); err != nil {
		t.Fatalf("mkdir runtime sessions: %v", err)
	}
	if err := os.WriteFile(layout.RuntimeEnv, []byte("STALE=1\n"), 0o600); err != nil {
		t.Fatalf("write stale runtime env: %v", err)
	}

	if err := service.ReconcileStartup(ctx); err != nil {
		t.Fatalf("ReconcileStartup() error = %v", err)
	}
	if _, err := os.Stat(layout.RuntimeEnv); !os.IsNotExist(err) {
		t.Fatalf("stale runtime env still present: %v", err)
	}
}

func TestReconcileStartupMarksRunningWithoutRuntimeEnvFailed(t *testing.T) {
	t.Parallel()

	service, cfg, repo, runner, _ := newTestService(t)
	tenantID := createTenant(t, repo)
	ctx := context.Background()

	created, err := service.Create(ctx, CreateInput{
		TenantID:       tenantID,
		BrowserChannel: "chromium",
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	layout, err := paths.Session(cfg, created.Session.ID)
	if err != nil {
		t.Fatalf("session layout: %v", err)
	}
	_ = os.Remove(layout.RuntimeEnv)
	runner.active[created.Session.ID] = true

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

package session

import (
	"context"
	"testing"
	"time"

	"github.com/aperture/aperture/internal/db"
	"go.uber.org/zap"
)

func TestMonitorRefreshesActiveRunningSessionLease(t *testing.T) {
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

	before := created.Session.ExpiresAt
	service.now = func() time.Time {
		return time.Date(2026, 7, 10, 12, 0, 0, 0, time.UTC)
	}

	monitor := NewMonitor(service, zap.NewNop())
	monitor.tick(ctx)

	updated, err := repo.GetSessionByID(ctx, created.Session.ID)
	if err != nil || updated == nil {
		t.Fatalf("load session: %v", err)
	}
	if updated.ExpiresAt == before {
		t.Fatalf("expires_at was not refreshed")
	}
	if updated.Status != db.SessionStatusRunning {
		t.Fatalf("status = %q, want running", updated.Status)
	}
}

package traefik_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/db"
	"github.com/aperture/aperture/internal/traefik"
)

func TestReconcileWritesRunningSessionRoutes(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	root := t.TempDir()
	cfg := config.Config{
		StoreRoot:                filepath.Join(root, "store"),
		RuntimeRoot:              filepath.Join(root, "runtime"),
		TraefikDynamicConfigPath: filepath.Join(root, "runtime", "traefik", "dynamic.yaml"),
		ListenAddress:            "127.0.0.1:8080",
		CdpRouteBasePath:         "/sessions",
	}

	database, err := db.Open(ctx, filepath.Join(root, "store", "aperture.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := database.Migrate(ctx); err != nil {
		t.Fatalf("migrate database: %v", err)
	}

	repo := db.NewRepository(database)
	tenantID := "018f1234-0000-7000-8000-000000000099"
	if err := repo.CreateTenant(ctx, &db.Tenant{
		ID:          tenantID,
		DisplayName: "acme",
		CreatedAt:   db.NowUTC(),
	}); err != nil {
		t.Fatalf("create tenant: %v", err)
	}

	port := 9333
	sessionID := "018f1234-0000-7000-8000-000000000001"
	if err := repo.CreateSession(ctx, &db.Session{
		ID:              sessionID,
		TenantID:        tenantID,
		Status:          db.SessionStatusRunning,
		OverlayPath:     "/tmp/overlay",
		UpperPath:       "/tmp/upper",
		WorkPath:        "/tmp/work",
		MergedPath:      "/tmp/merged",
		DownloadsPath:   "/tmp/downloads",
		CachePath:       "/tmp/cache",
		ArtifactsPath:   "/tmp/artifacts",
		BrowserChannel:  "chromium",
		BrowserArgsJSON: "[]",
		CreatedAt:       db.NowUTC(),
		ExpiresAt:       db.NowUTC(),
		CurrentCDPPort:  &port,
	}); err != nil {
		t.Fatalf("create session: %v", err)
	}

	service := traefik.NewService(cfg, repo)
	if err := service.Reconcile(ctx); err != nil {
		t.Fatalf("Reconcile() error = %v", err)
	}

	body, err := os.ReadFile(cfg.TraefikDynamicConfigPath)
	if err != nil {
		t.Fatalf("read dynamic config: %v", err)
	}
	if !containsAll(string(body),
		"aperture-cdp-018f1234000070008000000000000001",
		"http://127.0.0.1:9333",
		"/internal/forward-auth/cdp/018f1234-0000-7000-8000-000000000001",
	) {
		t.Fatalf("dynamic config missing expected CDP route:\n%s", body)
	}
}

func containsAll(haystack string, needles ...string) bool {
	for _, needle := range needles {
		if !strings.Contains(haystack, needle) {
			return false
		}
	}
	return true
}

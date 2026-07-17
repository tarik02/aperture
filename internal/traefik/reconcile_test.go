package traefik_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aperture/aperture/internal/browser"
	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/db"
	"github.com/aperture/aperture/internal/deploystate"
	"github.com/aperture/aperture/internal/paths"
	"github.com/aperture/aperture/internal/traefik"
)

func TestReconcileWritesCDPRoutableSessionRoutes(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	root := t.TempDir()
	cfg := config.Config{
		StoreRoot:               filepath.Join(root, "store"),
		RuntimeRoot:             filepath.Join(root, "runtime"),
		ArtifactRoot:            filepath.Join(root, "artifacts"),
		TraefikDynamicConfigDir: filepath.Join(root, "runtime", "traefik", "dynamic"),
		DeployColor:             config.DeployColorBlue,
		DeployStatePath:         filepath.Join(root, "store", "deployment-state.json"),
		DeployBlueURL:           "http://127.0.0.1:28080",
		DeployGreenURL:          "http://127.0.0.1:28082",
		ListenAddress:           "127.0.0.1:8080",
		CdpRouteBasePath:        "/cdp",
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

	sessionID := "018f1234-0000-7000-8000-000000000001"
	now := db.NowUTC()
	cdpPort := 9222
	layout, err := paths.Session(cfg, sessionID)
	if err != nil {
		t.Fatalf("session layout: %v", err)
	}
	if err := browser.WriteRuntimeEnv(layout.RuntimeEnv, browser.RuntimeEnvValues{
		SessionID:         sessionID,
		MergedUserDataDir: "/tmp/merged",
		DownloadsDir:      "/tmp/downloads",
		RecordingsDir:     "/tmp/recordings",
		CacheDir:          "/tmp/cache",
		ArtifactsDir:      "/tmp/artifacts",
		CDPPort:           cdpPort,
		WrapperPort:       9333,
		BrowserExecutable: "/usr/bin/chromium",
	}); err != nil {
		t.Fatalf("write runtime env: %v", err)
	}
	if err := repo.CreateSession(ctx, &db.Session{
		ID:              sessionID,
		TenantID:        tenantID,
		Status:          db.SessionStatusSuspended,
		OverlayPath:     "/tmp/overlay",
		UpperPath:       "/tmp/upper",
		WorkPath:        "/tmp/work",
		MergedPath:      "/tmp/merged",
		DownloadsPath:   "/tmp/downloads",
		CachePath:       "/tmp/cache",
		ArtifactsPath:   "/tmp/artifacts",
		BrowserChannel:  "chromium",
		BrowserArgsJSON: "[]",
		CreatedAt:       now,
		ExpiresAt:       now,
		RuntimeEnvPath:  &layout.RuntimeEnv,
		CurrentCDPPort:  &cdpPort,
		SuspendedAt:     &now,
	}); err != nil {
		t.Fatalf("create session: %v", err)
	}

	service := traefik.NewService(cfg, repo)
	if err := service.Reconcile(ctx); err != nil {
		t.Fatalf("Reconcile() error = %v", err)
	}

	body, err := os.ReadFile(traefik.SessionsConfigPath(cfg))
	if err != nil {
		t.Fatalf("read sessions config: %v", err)
	}
	if !containsAll(string(body),
		"aperture-cdp-018f1234000070008000000000000001",
		"service: aperture-cdp-018f1234000070008000000000000001",
		"url: \"http://127.0.0.1:9333\"",
		"http://127.0.0.1:28080/internal/forward-auth/cdp/018f1234-0000-7000-8000-000000000001",
	) {
		t.Fatalf("dynamic config missing expected CDP route:\n%s", body)
	}
}

func TestReconcileInactiveColorDoesNotOverwriteSessionsConfig(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	root := t.TempDir()
	cfg := config.Config{
		StoreRoot:               filepath.Join(root, "store"),
		RuntimeRoot:             filepath.Join(root, "runtime"),
		ArtifactRoot:            filepath.Join(root, "artifacts"),
		TraefikDynamicConfigDir: filepath.Join(root, "runtime", "traefik", "dynamic"),
		DeployColor:             config.DeployColorGreen,
		DeployStatePath:         filepath.Join(root, "store", "deployment-state.json"),
		DeployBlueURL:           "http://127.0.0.1:28080",
		DeployGreenURL:          "http://127.0.0.1:28082",
		ListenAddress:           "127.0.0.1:8080",
		CdpRouteBasePath:        "/cdp",
	}

	database, err := db.Open(ctx, filepath.Join(root, "store", "aperture.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := database.Migrate(ctx); err != nil {
		t.Fatalf("migrate database: %v", err)
	}

	if _, err := deploystate.New(cfg).MarkActive(config.DeployColorBlue, "68fd220"); err != nil {
		t.Fatalf("mark active: %v", err)
	}
	if err := traefik.WriteAtomic(traefik.SessionsConfigPath(cfg), []byte("active sessions\n")); err != nil {
		t.Fatalf("seed sessions config: %v", err)
	}

	service := traefik.NewService(cfg, db.NewRepository(database))
	if err := service.Reconcile(ctx); err != nil {
		t.Fatalf("Reconcile() error = %v", err)
	}

	body, err := os.ReadFile(traefik.SessionsConfigPath(cfg))
	if err != nil {
		t.Fatalf("read sessions config: %v", err)
	}
	if string(body) != "active sessions\n" {
		t.Fatalf("inactive reconcile overwrote sessions config:\n%s", body)
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

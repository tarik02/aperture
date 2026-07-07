package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"path/filepath"
	"testing"

	"github.com/aperture/aperture/internal/auth"
	"github.com/aperture/aperture/internal/browser"
	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/db"
	"github.com/aperture/aperture/internal/ids"
	"github.com/aperture/aperture/internal/session"
	"github.com/aperture/aperture/internal/snapshot"
	"github.com/aperture/aperture/internal/supervisor"
	"github.com/aperture/aperture/internal/traefik"
	"go.uber.org/zap"
)

func newSnapshotHandlerTestEnv(t *testing.T) (*testEnv, *snapshot.PromotionService) {
	t.Helper()

	env := newTestEnv(t)
	root := t.TempDir()
	cfg := config.Config{
		StoreRoot:               filepath.Join(root, "store"),
		RuntimeRoot:             filepath.Join(root, "runtime"),
		ArtifactRoot:            filepath.Join(root, "artifacts"),
		DatabasePath:            filepath.Join(root, "unused.db"),
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

	channels, err := browser.NewRegistry(cfg)
	if err != nil {
		t.Fatalf("registry: %v", err)
	}
	runner := &sessionHandlerFakeRunner{active: make(map[string]bool)}
	browserSupervisor, err := supervisor.NewBrowser(cfg, runner)
	if err != nil {
		t.Fatalf("browser supervisor: %v", err)
	}
	sessions := session.NewService(cfg, env.repo, &sessionHandlerFakeOverlay{cfg: cfg}, browserSupervisor, channels, traefik.NoopReconciler{})
	sessions.SetCDPReadyWaiter(func(context.Context, int) error { return nil })
	snapshots := snapshot.NewService(cfg, env.repo)
	promotion := snapshot.NewPromotionService(cfg, env.repo, browserSupervisor, snapshots)

	server := &Server{
		Auth:      env.service,
		Sessions:  sessions,
		Snapshots: snapshots,
		Promotion: promotion,
		Channels:  channels,
	}
	env.router = NewRouter(zap.NewNop(), server, nil, "")
	return env, promotion
}

func TestSnapshotDeleteRestoreHandlers(t *testing.T) {
	t.Parallel()

	env, _ := newSnapshotHandlerTestEnv(t)
	ctx := context.Background()

	token, err := env.service.CreateToken(ctx, auth.CreateTokenInput{
		AuthorityType: auth.AuthorityTenant,
		TenantID:      &env.tenantID,
		Name:          "snapshot-operator",
		Scopes:        []string{auth.ScopeSnapshotsWrite},
	})
	if err != nil {
		t.Fatalf("create token: %v", err)
	}

	snapshotID, err := ids.NewUUIDv7()
	if err != nil {
		t.Fatalf("snapshot id: %v", err)
	}
	if err := env.repo.CreateSnapshot(ctx, &db.Snapshot{
		ID:        snapshotID,
		TenantID:  env.tenantID,
		Name:      "restore-me",
		Path:      filepath.Join(t.TempDir(), "snapshot"),
		CreatedAt: db.NowUTC(),
	}); err != nil {
		t.Fatalf("insert snapshot: %v", err)
	}

	deleteRec := env.do(t, http.MethodDelete, "/api/snapshots/restore-me", token.Raw, "", nil)
	if deleteRec.Code != http.StatusOK {
		t.Fatalf("delete status = %d, body = %s", deleteRec.Code, deleteRec.Body.String())
	}

	restoreRec := env.do(t, http.MethodPost, "/api/snapshots/restore-me/restore", token.Raw, "", nil)
	if restoreRec.Code != http.StatusOK {
		t.Fatalf("restore status = %d, body = %s", restoreRec.Code, restoreRec.Body.String())
	}

	var restored snapshotMutationResponse
	if err := json.Unmarshal(restoreRec.Body.Bytes(), &restored); err != nil {
		t.Fatalf("decode restore: %v", err)
	}
	if restored.Snapshot.DeletedAt != nil {
		t.Fatal("expected active snapshot")
	}
}

func TestPromoteSessionHandler(t *testing.T) {
	t.Parallel()

	env, _ := newSnapshotHandlerTestEnv(t)
	ctx := context.Background()

	token, err := env.service.CreateToken(ctx, auth.CreateTokenInput{
		AuthorityType: auth.AuthorityTenant,
		TenantID:      &env.tenantID,
		Name:          "promoter",
		Scopes:        []string{auth.ScopeSessionsWrite, auth.ScopeSnapshotsWrite},
	})
	if err != nil {
		t.Fatalf("create token: %v", err)
	}

	sessionsToken, err := env.service.CreateToken(ctx, auth.CreateTokenInput{
		AuthorityType: auth.AuthorityTenant,
		TenantID:      &env.tenantID,
		Name:          "session-creator",
		Scopes:        []string{auth.ScopeSessionsWrite},
	})
	if err != nil {
		t.Fatalf("create sessions token: %v", err)
	}

	createRec := env.do(t, http.MethodPost, "/api/sessions", sessionsToken.Raw, "", map[string]any{
		"browser": map[string]any{"channel": "chromium", "args": []string{}},
	})
	if createRec.Code != http.StatusCreated {
		t.Fatalf("create session status = %d, body = %s", createRec.Code, createRec.Body.String())
	}
	var created createSessionResponse
	if err := json.Unmarshal(createRec.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode create: %v", err)
	}

	deleteRec := env.do(t, http.MethodDelete, "/api/sessions/"+created.Session.ID, sessionsToken.Raw, "", nil)
	if deleteRec.Code != http.StatusOK {
		t.Fatalf("delete session status = %d, body = %s", deleteRec.Code, deleteRec.Body.String())
	}

	promoteRec := env.do(t, http.MethodPost, "/api/sessions/"+created.Session.ID+"/promote", token.Raw, "", map[string]any{
		"name": "from-session",
		"tags": map[string]string{"source": "http-test"},
	})
	if promoteRec.Code != http.StatusOK {
		t.Fatalf("promote status = %d, body = %s", promoteRec.Code, promoteRec.Body.String())
	}

	var promoted promoteSessionResponse
	if err := json.Unmarshal(promoteRec.Body.Bytes(), &promoted); err != nil {
		t.Fatalf("decode promote: %v", err)
	}
	if promoted.Snapshot.Name != "from-session" {
		t.Fatalf("snapshot name = %q", promoted.Snapshot.Name)
	}
}

func TestPromoteRequiresBothScopes(t *testing.T) {
	t.Parallel()

	env, _ := newSnapshotHandlerTestEnv(t)
	ctx := context.Background()

	token, err := env.service.CreateToken(ctx, auth.CreateTokenInput{
		AuthorityType: auth.AuthorityTenant,
		TenantID:      &env.tenantID,
		Name:          "sessions-only",
		Scopes:        []string{auth.ScopeSessionsWrite},
	})
	if err != nil {
		t.Fatalf("create token: %v", err)
	}

	rec := env.do(t, http.MethodPost, "/api/sessions/018f1234-5678-79ab-8cde-f123456789ab/promote", token.Raw, "", map[string]any{
		"name": "blocked",
	})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
}

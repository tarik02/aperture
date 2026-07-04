package traefik_test

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/db"
	"github.com/aperture/aperture/internal/httpapi"
	"github.com/aperture/aperture/internal/session"
	"github.com/aperture/aperture/internal/traefik"
	"go.uber.org/zap"
)

func TestLiveTraefikCDPWebSocketSmoke(t *testing.T) {
	if os.Getenv("APERTURE_LIVE_TRAEFIK") != "1" {
		t.Skip("set APERTURE_LIVE_TRAEFIK=1 to run live Traefik WebSocket/CDP smoke test")
	}
	if _, err := exec.LookPath("traefik"); err != nil {
		t.Skip("traefik executable not found in PATH")
	}

	ctx := context.Background()
	root := t.TempDir()
	cfg := config.Config{
		StoreRoot:                filepath.Join(root, "store"),
		RuntimeRoot:              filepath.Join(root, "runtime"),
		ArtifactRoot:             filepath.Join(root, "artifacts"),
		DatabasePath:             filepath.Join(root, "store", "aperture.db"),
		TraefikDynamicConfigPath: filepath.Join(root, "runtime", "traefik", "dynamic.yaml"),
		ListenAddress:            "127.0.0.1:0",
		SystemdBrowserUnitName:   "browser-session@.service",
		SessionRetentionDays:     7,
		SnapshotRetentionDays:    7,
		ChannelRegistry: map[string]config.ChannelConfig{
			"chromium": {Executable: "/usr/bin/chromium"},
		},
		ExternalBaseURL:  "http://127.0.0.1",
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

	tenantID := "018f1234-0000-7000-8000-000000000099"
	if err := repo.CreateTenant(ctx, &db.Tenant{
		ID:          tenantID,
		DisplayName: "live",
		CreatedAt:   db.NowUTC(),
	}); err != nil {
		t.Fatalf("create tenant: %v", err)
	}

	sessionID := "018f1234-0000-7000-8000-000000000001"
	rawToken, hashToken, err := session.GenerateCDPToken(sessionID)
	if err != nil {
		t.Fatalf("generate cdp token: %v", err)
	}

	cdpBackend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"Browser":"live-smoke","Protocol-Version":"1.3"}`)
	}))
	t.Cleanup(cdpBackend.Close)

	backendURL, err := url.Parse(cdpBackend.URL)
	if err != nil {
		t.Fatalf("parse cdp backend url: %v", err)
	}
	backendPort, err := strconv.Atoi(backendURL.Port())
	if err != nil {
		t.Fatalf("parse cdp backend port: %v", err)
	}
	expiresAt := time.Now().UTC().Add(24 * time.Hour).Format(time.RFC3339Nano)

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
		ExpiresAt:       expiresAt,
		CurrentCDPPort:  &backendPort,
	}); err != nil {
		t.Fatalf("create session: %v", err)
	}
	if err := repo.CreateSessionToken(ctx, &db.SessionToken{
		SessionID: sessionID,
		TenantID:  tenantID,
		TokenHash: hashToken,
		CreatedAt: db.NowUTC(),
	}); err != nil {
		t.Fatalf("create session token: %v", err)
	}

	apertureListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen aperture: %v", err)
	}
	cfg.ListenAddress = apertureListener.Addr().String()
	t.Cleanup(func() { _ = apertureListener.Close() })

	sessions := session.NewService(cfg, repo, nil, nil, nil, traefik.NewService(cfg, repo))
	server := &httpapi.Server{Sessions: sessions}
	router := httpapi.NewRouter(zap.NewNop(), server, nil, cfg.CdpRouteBasePath)
	apertureServer := &http.Server{Handler: router}
	go func() {
		_ = apertureServer.Serve(apertureListener)
	}()
	t.Cleanup(func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = apertureServer.Shutdown(shutdownCtx)
	})

	if err := traefik.NewService(cfg, repo).Reconcile(ctx); err != nil {
		t.Fatalf("reconcile traefik config: %v", err)
	}

	traefikAddr, err := reserveTCPAddr()
	if err != nil {
		t.Fatalf("reserve traefik addr: %v", err)
	}

	staticPath := filepath.Join(root, "traefik-static.yaml")
	staticConfig, err := traefik.RenderStaticConfig(traefikAddr, cfg.TraefikDynamicConfigPath)
	if err != nil {
		t.Fatalf("render static config: %v", err)
	}
	if err := os.WriteFile(staticPath, staticConfig, 0o600); err != nil {
		t.Fatalf("write static config: %v", err)
	}

	cmd := exec.Command("traefik", "--configfile", staticPath)
	if err := cmd.Start(); err != nil {
		t.Fatalf("start traefik: %v", err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
	})

	routeURL := "http://" + traefikAddr + "/cdp/" + sessionID + "/json/version"
	deadline := time.Now().Add(10 * time.Second)
	var lastStatus int
	var lastBody string
	for time.Now().Before(deadline) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, routeURL, nil)
		if err != nil {
			t.Fatalf("new request: %v", err)
		}
		req.Header.Set("Authorization", "Bearer "+rawToken)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			time.Sleep(200 * time.Millisecond)
			continue
		}
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		lastStatus = resp.StatusCode
		lastBody = string(body)
		if resp.StatusCode == http.StatusOK {
			var payload map[string]string
			if err := json.Unmarshal(body, &payload); err != nil {
				t.Fatalf("decode cdp response: %v", err)
			}
			if payload["Browser"] != "live-smoke" {
				t.Fatalf("unexpected cdp payload: %s", body)
			}
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatalf("cdp request through traefik never succeeded: status=%d body=%s", lastStatus, lastBody)
}

func reserveTCPAddr() (string, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	addr := listener.Addr().String()
	if err := listener.Close(); err != nil {
		return "", err
	}
	return addr, nil
}

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
	"strings"
	"testing"
	"time"

	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/db"
	"github.com/aperture/aperture/internal/deploystate"
	"github.com/aperture/aperture/internal/httpapi"
	"github.com/aperture/aperture/internal/session"
	"github.com/aperture/aperture/internal/traefik"
	"github.com/coder/websocket"
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
		StoreRoot:               filepath.Join(root, "store"),
		RuntimeRoot:             filepath.Join(root, "runtime"),
		ArtifactRoot:            filepath.Join(root, "artifacts"),
		DatabasePath:            filepath.Join(root, "store", "aperture.db"),
		TraefikDynamicConfigDir: filepath.Join(root, "runtime", "traefik", "dynamic"),
		DeployColor:             config.DeployColorBlue,
		DeployStatePath:         filepath.Join(root, "store", "deployment-state.json"),
		DeployGreenURL:          "http://127.0.0.1:28082",
		ListenAddress:           "127.0.0.1:0",
		BrowserSupervisor:       config.BrowserSupervisorSystemd,
		SystemdBrowserUnitName:  "browser-session@.service",
		SessionRetentionDays:    7,
		SnapshotRetentionDays:   7,
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
	rawToken, hashToken, err := session.GenerateSessionToken(sessionID)
	if err != nil {
		t.Fatalf("generate session token: %v", err)
	}

	webSocketQueries := make(chan string, 1)
	cdpBackend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/json/version" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"Browser":"live-smoke","Protocol-Version":"1.3","webSocketDebuggerUrl":"ws://127.0.0.1:1/devtools/browser/live-smoke"}`)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/devtools/browser/") {
			webSocketQueries <- r.URL.RawQuery
			conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
			if err != nil {
				return
			}
			_ = conn.Close(websocket.StatusNormalClosure, "")
			return
		}
		http.NotFound(w, r)
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
	cfg.DeployBlueURL = "http://" + cfg.ListenAddress
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

	deployState := deploystate.New(cfg)
	if _, err := deployState.MarkActive(config.DeployColorBlue, "live-smoke"); err != nil {
		t.Fatalf("mark active: %v", err)
	}
	if err := traefik.WriteEdgeConfig(cfg, deployState); err != nil {
		t.Fatalf("write edge config: %v", err)
	}
	if err := traefik.NewService(cfg, repo).Reconcile(ctx); err != nil {
		t.Fatalf("reconcile traefik config: %v", err)
	}

	traefikAddr, err := reserveTCPAddr()
	if err != nil {
		t.Fatalf("reserve traefik addr: %v", err)
	}

	staticPath := filepath.Join(root, "traefik-static.yaml")
	staticConfig, err := traefik.RenderStaticConfig(traefikAddr, cfg.TraefikDynamicConfigDir)
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

	routeURL := "http://" + traefikAddr + "/sessions/" + sessionID + "/cdp/" + url.PathEscape(rawToken) + "/json/version"
	deadline := time.Now().Add(10 * time.Second)
	var lastStatus int
	var lastBody string
	var payload map[string]string
	for time.Now().Before(deadline) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, routeURL, nil)
		if err != nil {
			t.Fatalf("new request: %v", err)
		}
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
			if err := json.Unmarshal(body, &payload); err != nil {
				t.Fatalf("decode cdp response: %v", err)
			}
			if payload["Browser"] != "live-smoke" {
				t.Fatalf("unexpected cdp payload: %s", body)
			}
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if payload == nil {
		t.Fatalf("cdp request through traefik never succeeded: status=%d body=%s", lastStatus, lastBody)
	}

	webSocketURL, err := url.Parse(payload["webSocketDebuggerUrl"])
	if err != nil {
		t.Fatalf("parse websocket url: %v", err)
	}
	if webSocketURL.Query().Get("token") != "" {
		t.Fatalf("websocket url leaked token query: %s", webSocketURL.String())
	}
	token := webSocketURL.Query().Get("token")
	if token != "" {
		t.Fatalf("websocket url query token = %q, want empty", token)
	}
	if webSocketURL.Fragment != "" {
		t.Fatalf("websocket url fragment = %q, want empty", webSocketURL.Fragment)
	}
	if !strings.Contains(webSocketURL.Path, "/cdp/"+rawToken+"/devtools/") {
		t.Fatalf("websocket url path = %q, want token path", webSocketURL.Path)
	}

	conn, _, err := websocket.Dial(ctx, webSocketURL.String(), nil)
	if err != nil {
		t.Fatalf("dial cdp websocket through traefik: %v", err)
	}
	_ = conn.Close(websocket.StatusNormalClosure, "")

	select {
	case query := <-webSocketQueries:
		if strings.Contains(query, "token=") {
			t.Fatalf("cdp websocket backend received token query: %q", query)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cdp websocket backend was not reached")
	}
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

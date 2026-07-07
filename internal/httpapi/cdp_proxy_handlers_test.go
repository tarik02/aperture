package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/aperture/aperture/internal/auth"
	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/db"
	"github.com/aperture/aperture/internal/session"
	"github.com/aperture/aperture/internal/traefik"
	"go.uber.org/zap"
)

func TestLiveCDPDiscoveryAllowsQueryTokenAndStripsTokenBeforeBackend(t *testing.T) {
	t.Parallel()

	env, sessionID, rawCDPToken, backendQueries := newCDPDiscoveryTestEnv(t)
	status, body := doCDPDiscoveryRequest(
		t,
		env,
		http.MethodGet,
		"/sessions/"+sessionID+"/cdp/json/version?token="+url.QueryEscape(rawCDPToken)+"&keep=1",
		nil,
	)
	if status != http.StatusOK {
		t.Fatalf("status = %d, want %d, body = %s", status, http.StatusOK, body)
	}
	if query := <-backendQueries; query != "keep=1" {
		t.Fatalf("backend query = %q, want keep=1", query)
	}

	webSocketURL := decodedWebSocketDebuggerURL(t, body)
	if webSocketURL.Query().Get("token") != "" {
		t.Fatalf("websocket url leaked token query: %s", webSocketURL.String())
	}
	if got := webSocketURL.Query().Get("backend"); got != "1" {
		t.Fatalf("websocket url backend query = %q, want 1", got)
	}
	if got := webSocketURL.Fragment; got != "token="+url.QueryEscape(rawCDPToken) {
		t.Fatalf("websocket url fragment = %q, want token fragment", got)
	}
	if want := "/sessions/" + sessionID + "/cdp/devtools/browser/test"; webSocketURL.Path != want {
		t.Fatalf("websocket url path = %q, want %q", webSocketURL.Path, want)
	}
}

func TestLiveCDPDiscoveryPreservesAppBearerAccess(t *testing.T) {
	t.Parallel()

	env, sessionID, rawCDPToken, backendQueries := newCDPDiscoveryTestEnv(t)
	apiToken, err := env.service.CreateToken(context.Background(), auth.CreateTokenInput{
		AuthorityType: auth.AuthorityTenant,
		TenantID:      &env.tenantID,
		Name:          "cdp-discovery",
		Scopes:        []string{auth.ScopeSessionsWrite},
	})
	if err != nil {
		t.Fatalf("create api token: %v", err)
	}

	status, body := doCDPDiscoveryRequest(t, env, http.MethodGet, "/sessions/"+sessionID+"/cdp/json/version", map[string]string{
		"Authorization": "Bearer " + apiToken.Raw,
	})
	if status != http.StatusOK {
		t.Fatalf("status = %d, want %d, body = %s", status, http.StatusOK, body)
	}
	if query := <-backendQueries; query != "" {
		t.Fatalf("backend query = %q, want empty", query)
	}

	webSocketURL := decodedWebSocketDebuggerURL(t, body)
	if webSocketURL.Query().Get("token") != "" {
		t.Fatalf("websocket url leaked token query: %s", webSocketURL.String())
	}
	if got := webSocketURL.Fragment; got != "token="+url.QueryEscape(rawCDPToken) {
		t.Fatalf("websocket url fragment = %q, want token fragment", got)
	}
}

func newCDPDiscoveryTestEnv(t *testing.T) (*testEnv, string, string, <-chan string) {
	t.Helper()

	env := newTestEnv(t)
	backendQueries := make(chan string, 1)
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		backendQueries <- r.URL.RawQuery
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"Browser":"test","webSocketDebuggerUrl":"ws://127.0.0.1:1/devtools/browser/test?backend=1&token=backend"}`)
	}))
	t.Cleanup(backend.Close)

	backendURL, err := url.Parse(backend.URL)
	if err != nil {
		t.Fatalf("parse backend url: %v", err)
	}
	backendPort, err := strconv.Atoi(backendURL.Port())
	if err != nil {
		t.Fatalf("parse backend port: %v", err)
	}

	root := t.TempDir()
	cfg := config.Config{
		RuntimeRoot:             filepath.Join(root, "runtime"),
		StoreRoot:               filepath.Join(root, "store"),
		TraefikDynamicConfigDir: filepath.Join(root, "runtime", "traefik", "dynamic"),
		ExternalBaseURL:         "https://browser.example.test",
		CdpRouteBasePath:        "/cdp",
		SessionRetentionDays:    7,
	}

	sessionID := "018f1234-0000-7000-8000-000000000001"
	rawCDPToken, hashCDPToken, err := session.GenerateCDPToken(sessionID)
	if err != nil {
		t.Fatalf("generate cdp token: %v", err)
	}
	if err := session.StoreCDPTokenSeal(cfg, sessionID, rawCDPToken); err != nil {
		t.Fatalf("store cdp token seal: %v", err)
	}

	expiresAt := time.Now().UTC().Add(24 * time.Hour).Format(time.RFC3339Nano)
	if err := env.repo.CreateSession(context.Background(), &db.Session{
		ID:              sessionID,
		TenantID:        env.tenantID,
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
	if err := env.repo.CreateSessionToken(context.Background(), &db.SessionToken{
		SessionID: sessionID,
		TenantID:  env.tenantID,
		TokenHash: hashCDPToken,
		CreatedAt: db.NowUTC(),
	}); err != nil {
		t.Fatalf("create session token: %v", err)
	}

	sessions := session.NewService(cfg, env.repo, nil, nil, nil, traefik.NoopReconciler{})
	env.router = NewRouter(zap.NewNop(), &Server{Auth: env.service, Sessions: sessions}, nil, cfg.CdpRouteBasePath)
	return env, sessionID, rawCDPToken, backendQueries
}

func doCDPDiscoveryRequest(t *testing.T, env *testEnv, method, path string, headers map[string]string) (int, []byte) {
	t.Helper()

	server := httptest.NewServer(env.router)
	t.Cleanup(server.Close)

	req, err := http.NewRequest(method, server.URL+path, nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do request: %v", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read response: %v", err)
	}
	return resp.StatusCode, body
}

func decodedWebSocketDebuggerURL(t *testing.T, body []byte) *url.URL {
	t.Helper()

	var payload struct {
		WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("decode cdp response: %v", err)
	}
	parsed, err := url.Parse(payload.WebSocketDebuggerURL)
	if err != nil {
		t.Fatalf("parse websocket url: %v", err)
	}
	return parsed
}

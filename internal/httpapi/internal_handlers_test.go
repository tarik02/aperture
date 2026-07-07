package httpapi

import (
	"bytes"
	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/gc"
	"github.com/aperture/aperture/internal/supervisor"
	"github.com/aperture/aperture/internal/traefik"
	"go.uber.org/zap"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

func newInternalJobTestEnv(t *testing.T, jobToken string) *testEnv {
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

	runner := &sessionHandlerFakeRunner{active: make(map[string]bool)}
	browserSupervisor, err := supervisor.NewBrowser(cfg, runner)
	if err != nil {
		t.Fatalf("browser supervisor: %v", err)
	}

	gcService := gc.NewService(cfg, env.repo, browserSupervisor, sessionHandlerFakeOverlay{cfg: cfg}, traefik.NoopReconciler{})
	server := &Server{Auth: env.service, GC: gcService}
	server.SetJobToken(jobToken)
	env.router = NewRouter(zap.NewNop(), server, nil, "")
	return env
}

func postGCJob(t *testing.T, router http.Handler, token, remoteAddr string) *httptest.ResponseRecorder {
	t.Helper()

	req := httptest.NewRequest(http.MethodPost, "/internal/jobs/gc", nil)
	req.RemoteAddr = remoteAddr
	if token != "" {
		req.Header.Set(jobTokenHeader, token)
	}

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func TestInternalGCJobRejectsMissingToken(t *testing.T) {
	t.Parallel()

	env := newInternalJobTestEnv(t, "secret-token")
	rec := postGCJob(t, env.router, "", "127.0.0.1:12345")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestInternalGCJobRejectsInvalidToken(t *testing.T) {
	t.Parallel()

	env := newInternalJobTestEnv(t, "secret-token")
	rec := postGCJob(t, env.router, "wrong-token", "127.0.0.1:12345")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestInternalGCJobRejectsNonLoopback(t *testing.T) {
	t.Parallel()

	env := newInternalJobTestEnv(t, "secret-token")
	rec := postGCJob(t, env.router, "secret-token", "10.0.0.1:12345")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

func TestInternalGCJobAcceptsLoopbackAndValidToken(t *testing.T) {
	t.Parallel()

	env := newInternalJobTestEnv(t, "secret-token")
	rec := postGCJob(t, env.router, "secret-token", "127.0.0.1:12345")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d, body = %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte(`"expiredSessions"`)) {
		t.Fatalf("body = %s, want gc summary", rec.Body.String())
	}
}

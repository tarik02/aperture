//go:build linux

package app_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aperture/aperture/internal/app"
	"github.com/aperture/aperture/internal/auth"
	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/db"
	"github.com/aperture/aperture/internal/jobtoken"
	"github.com/aperture/aperture/internal/paths"
)

func TestLiveE2EDesktopSmoke(t *testing.T) {
	if os.Getenv("APERTURE_LIVE_E2E") != "1" {
		t.Skip("set APERTURE_LIVE_E2E=1 to run live end-to-end desktop smoke test")
	}
	if os.Getenv("DBUS_SESSION_BUS_ADDRESS") == "" {
		t.Skip("DBUS_SESSION_BUS_ADDRESS not set; requires a logged-in user systemd session")
	}
	runtimeBase := os.Getenv("XDG_RUNTIME_DIR")
	if runtimeBase == "" {
		t.Skip("XDG_RUNTIME_DIR not set; requires a logged-in desktop session")
	}
	if err := exec.Command("systemctl", "--user", "is-system-running").Run(); err != nil {
		t.Skipf("user systemd is not available: %v", err)
	}

	chromiumPath := lookupChromium(t)
	if _, err := exec.LookPath("bwrap"); err != nil {
		t.Skip("bwrap executable not found in PATH")
	}
	if _, err := exec.LookPath("browser-session-wrapper"); err != nil {
		t.Skip("browser-session-wrapper not found in PATH; install the aperture package or add result/bin to PATH")
	}
	if _, err := exec.LookPath("aperture-mount-session"); err != nil {
		t.Skip("aperture-mount-session not found in PATH")
	}
	if _, err := exec.LookPath("aperture-unmount-session"); err != nil {
		t.Skip("aperture-unmount-session not found in PATH")
	}
	if _, err := exec.LookPath("systemctl"); err != nil {
		t.Skip("systemctl not found in PATH")
	}

	ctx := context.Background()
	root, err := filepath.Abs(t.TempDir())
	if err != nil {
		t.Fatalf("abs temp dir: %v", err)
	}

	configHome := filepath.Join(root, "config")
	if err := os.MkdirAll(configHome, 0o700); err != nil {
		t.Fatalf("mkdir config home: %v", err)
	}
	t.Setenv("XDG_CONFIG_HOME", configHome)

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := listener.Addr().String()
	_ = listener.Close()

	storeRoot := filepath.Join(root, "store")
	runtimeRoot := filepath.Join(runtimeBase, "aperture-e2e", filepath.Base(root))
	cfg := config.Config{
		StoreRoot:               storeRoot,
		RuntimeRoot:             runtimeRoot,
		ArtifactRoot:            filepath.Join(storeRoot, "artifacts"),
		DatabasePath:            filepath.Join(storeRoot, "aperture.db"),
		TraefikDynamicConfigDir: filepath.Join(runtimeRoot, "traefik", "dynamic"),
		DeployColor:             config.DeployColorBlue,
		DeployStatePath:         filepath.Join(storeRoot, "deployment-state.json"),
		DeployBlueURL:           "http://" + addr,
		DeployGreenURL:          "http://127.0.0.1:28082",
		ListenAddress:           addr,
		BrowserSupervisor:       config.BrowserSupervisorSystemd,
		SystemdBrowserUnitName:  "browser-session@.service",
		SessionRetentionDays:    7,
		SnapshotRetentionDays:   7,
		ChannelRegistry: map[string]config.ChannelConfig{
			"chromium": {
				Executable:  chromiumPath,
				DefaultArgs: []string{"--headless=new", "--disable-gpu"},
			},
		},
		ExternalBaseURL:  "http://127.0.0.1",
		CdpRouteBasePath: "/cdp",
		LogLevel:         "info",
	}

	installTrustedHelperConfig(t, cfg)
	installBrowserSessionUnit(t, cfg)

	application, err := app.New(ctx, cfg)
	if err != nil {
		t.Fatalf("init app: %v", err)
	}
	t.Cleanup(func() { _ = application.Close() })

	if err := application.Migrate(ctx); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	if _, err := application.Auth.Bootstrap(ctx, auth.BootstrapInput{Name: "e2e-admin"}); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	tenantRow, err := application.Auth.CreateTenant(ctx, auth.CreateTenantInput{DisplayName: "e2e"})
	if err != nil {
		t.Fatalf("create tenant: %v", err)
	}
	tenantToken, err := application.Auth.CreateToken(ctx, auth.CreateTokenInput{
		AuthorityType: auth.AuthorityTenant,
		TenantID:      &tenantRow.ID,
		Name:          "e2e-operator",
		Scopes: []string{
			auth.ScopeSessionsRead,
			auth.ScopeSessionsWrite,
			auth.ScopeSnapshotsRead,
			auth.ScopeSnapshotsWrite,
		},
	})
	if err != nil {
		t.Fatalf("create tenant token: %v", err)
	}

	serveCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	serveErr := make(chan error, 1)
	go func() {
		serveErr <- application.Serve(serveCtx)
	}()

	baseURL := "http://" + addr
	waitForHTTP(t, baseURL+"/api/health", http.StatusOK)

	client := &http.Client{Timeout: 45 * time.Second}

	createResp := postJSON(t, client, baseURL+"/api/sessions", tenantToken.Raw, "", map[string]any{
		"browser": map[string]any{"channel": "chromium", "args": []string{}},
	})
	if createResp.StatusCode != http.StatusCreated {
		t.Fatalf("create session status = %d body = %s", createResp.StatusCode, readBody(createResp))
	}
	var created struct {
		Session      db.Session `json:"session"`
		SessionToken string     `json:"sessionToken"`
	}
	decodeJSON(t, createResp, &created)
	sessionID := created.Session.ID

	waitForBrowserUnitActive(t, sessionID)
	cdpPort := waitForSessionCDPPort(t, application.Repository, sessionID)
	waitForCDPVersion(t, cdpPort)

	faReq, _ := http.NewRequest(http.MethodGet, baseURL+"/internal/forward-auth/cdp/"+sessionID, nil)
	faReq.Header.Set("Authorization", "Bearer "+created.SessionToken)
	faResp, err := client.Do(faReq)
	if err != nil {
		t.Fatalf("forward auth: %v", err)
	}
	if faResp.StatusCode != http.StatusOK {
		t.Fatalf("forward auth status = %d", faResp.StatusCode)
	}
	_ = faResp.Body.Close()

	deleteResp := doJSON(t, client, http.MethodDelete, baseURL+"/api/sessions/"+sessionID, tenantToken.Raw, "", nil)
	if deleteResp.StatusCode != http.StatusOK {
		t.Fatalf("delete session status = %d body = %s", deleteResp.StatusCode, readBody(deleteResp))
	}

	reopenResp := postJSON(t, client, baseURL+"/api/sessions/"+sessionID+"/reopen", tenantToken.Raw, "", nil)
	if reopenResp.StatusCode != http.StatusOK {
		t.Fatalf("reopen session status = %d body = %s", reopenResp.StatusCode, readBody(reopenResp))
	}
	waitForBrowserUnitActive(t, sessionID)

	stopResp := doJSON(t, client, http.MethodDelete, baseURL+"/api/sessions/"+sessionID, tenantToken.Raw, "", nil)
	if stopResp.StatusCode != http.StatusOK {
		t.Fatalf("delete for promote status = %d", stopResp.StatusCode)
	}
	waitForBrowserUnitInactive(t, sessionID)

	layout, err := paths.Session(cfg, sessionID)
	if err != nil {
		t.Fatalf("session layout: %v", err)
	}
	if err := os.WriteFile(filepath.Join(layout.Upper, "e2e-marker.txt"), []byte("promoted"), 0o644); err != nil {
		t.Fatalf("write upper marker: %v", err)
	}

	promoteResp := postJSON(t, client, baseURL+"/api/sessions/"+sessionID+"/promote", tenantToken.Raw, "", map[string]any{
		"name":  "e2e-snapshot",
		"force": false,
		"tags":  map[string]string{"source": "e2e"},
	})
	if promoteResp.StatusCode != http.StatusOK {
		t.Fatalf("promote status = %d body = %s", promoteResp.StatusCode, readBody(promoteResp))
	}

	deleteSnapResp := doJSON(t, client, http.MethodDelete, baseURL+"/api/snapshots/e2e-snapshot", tenantToken.Raw, "", nil)
	if deleteSnapResp.StatusCode != http.StatusOK {
		t.Fatalf("delete snapshot status = %d", deleteSnapResp.StatusCode)
	}

	restoreResp := postJSON(t, client, baseURL+"/api/snapshots/e2e-snapshot/restore", tenantToken.Raw, "", nil)
	if restoreResp.StatusCode != http.StatusOK {
		t.Fatalf("restore snapshot status = %d", restoreResp.StatusCode)
	}

	sessionRow, err := application.Repository.GetSessionByID(ctx, sessionID)
	if err != nil || sessionRow == nil {
		t.Fatalf("load session: %v", err)
	}
	past := time.Now().UTC().Add(-time.Hour).Format(time.RFC3339Nano)
	sessionRow.ExpiresAt = past
	if err := application.Repository.UpdateSession(ctx, sessionRow); err != nil {
		t.Fatalf("backdate session lease: %v", err)
	}

	jobToken, err := jobtoken.Load(cfg)
	if err != nil {
		t.Fatalf("load job token: %v", err)
	}
	gcReq, _ := http.NewRequest(http.MethodPost, baseURL+"/internal/jobs/gc", nil)
	gcReq.Header.Set("X-Aperture-Job-Token", jobToken)
	gcResp, err := client.Do(gcReq)
	if err != nil {
		t.Fatalf("gc job: %v", err)
	}
	if gcResp.StatusCode != http.StatusOK {
		t.Fatalf("gc job status = %d body = %s", gcResp.StatusCode, readBody(gcResp))
	}
	_ = gcResp.Body.Close()

	sessionRow, err = application.Repository.GetSessionByID(ctx, sessionID)
	if err != nil || sessionRow == nil {
		t.Fatalf("load session after gc: %v", err)
	}
	if sessionRow.Status != db.SessionStatusExpired {
		t.Fatalf("status after gc = %q, want expired", sessionRow.Status)
	}

	runSystemctlUser(t, "start", fmt.Sprintf("browser-session@%s.service", sessionID))
	waitForBrowserUnitActive(t, sessionID)

	cancel()
	select {
	case err := <-serveErr:
		if err != nil && err != context.Canceled {
			t.Fatalf("serve stopped: %v", err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("timed out waiting for serve shutdown")
	}

	application2, err := app.New(ctx, cfg)
	if err != nil {
		t.Fatalf("init app for restart reconcile: %v", err)
	}
	t.Cleanup(func() { _ = application2.Close() })

	restartCtx, restartCancel := context.WithCancel(ctx)
	defer restartCancel()
	go func() { _ = application2.Serve(restartCtx) }()
	waitForHTTP(t, baseURL+"/api/health", http.StatusOK)

	waitForBrowserUnitInactive(t, sessionID)
	t.Cleanup(func() {
		_ = exec.Command("systemctl", "--user", "stop", fmt.Sprintf("browser-session@%s.service", sessionID)).Run()
		_ = os.RemoveAll(runtimeRoot)
		_, _ = exec.Command("sudo", "rm", "-rf", storeRoot).CombinedOutput()
	})
}

func installBrowserSessionUnit(t *testing.T, cfg config.Config) {
	t.Helper()

	wrapperPath, err := exec.LookPath("browser-session-wrapper")
	if err != nil {
		t.Fatalf("locate browser-session-wrapper: %v", err)
	}

	unitDir := filepath.Join(os.Getenv("XDG_CONFIG_HOME"), "systemd", "user")
	if err := os.MkdirAll(unitDir, 0o755); err != nil {
		t.Fatalf("mkdir systemd user dir: %v", err)
	}

	unitPath := filepath.Join(unitDir, "browser-session@.service")
	content := fmt.Sprintf(`[Unit]
Description=Browser session %%i
After=graphical-session.target
PartOf=graphical-session.target

[Service]
Type=simple
EnvironmentFile=%s/sessions/%%i.env
ExecStart=%s
Restart=no
KillMode=mixed
TimeoutStopSec=20

[Install]
WantedBy=default.target
`, filepath.Join(cfg.RuntimeRoot, "sessions"), wrapperPath)

	if err := os.WriteFile(unitPath, []byte(content), 0o644); err != nil {
		t.Fatalf("write browser unit: %v", err)
	}
	runSystemctlUser(t, "daemon-reload")
}

func installTrustedHelperConfig(t *testing.T, cfg config.Config) {
	t.Helper()

	chromium := cfg.ChannelRegistry["chromium"].Executable
	configBody := fmt.Sprintf(`store_root = %q
runtime_root = %q
artifact_root = %q
external_base_url = %q
listen_address = %q

[channels.chromium]
executable = %q
default_args = ["--headless=new", "--disable-gpu"]
`, cfg.StoreRoot, cfg.RuntimeRoot, cfg.ArtifactRoot, cfg.ExternalBaseURL, cfg.ListenAddress, chromium)

	localConfig := filepath.Join(filepath.Dir(cfg.StoreRoot), "aperture.toml")
	if err := os.WriteFile(localConfig, []byte(configBody), 0o644); err != nil {
		t.Fatalf("write helper config: %v", err)
	}

	for _, args := range [][]string{
		{"mkdir", "-p", "/etc/aperture"},
		{"cp", localConfig, "/etc/aperture/aperture.toml"},
		{"chown", "root:root", "/etc/aperture/aperture.toml"},
		{"chmod", "0644", "/etc/aperture/aperture.toml"},
	} {
		if out, err := exec.Command("sudo", args...).CombinedOutput(); err != nil {
			t.Fatalf("sudo %v: %v: %s", args, err, strings.TrimSpace(string(out)))
		}
	}

	t.Cleanup(func() {
		_, _ = exec.Command("sudo", "rm", "-f", "/etc/aperture/aperture.toml").CombinedOutput()
	})
}

func runSystemctlUser(t *testing.T, args ...string) {
	t.Helper()
	cmd := exec.Command("systemctl", append([]string{"--user"}, args...)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("systemctl --user %s: %v: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
}

func waitForHTTP(t *testing.T, url string, wantStatus int) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	client := &http.Client{Timeout: 2 * time.Second}
	for time.Now().Before(deadline) {
		resp, err := client.Get(url)
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode == wantStatus {
				return
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s status %d", url, wantStatus)
}

func waitForBrowserUnitActive(t *testing.T, sessionID string) {
	t.Helper()
	deadline := time.Now().Add(45 * time.Second)
	unit := fmt.Sprintf("browser-session@%s.service", sessionID)
	for time.Now().Before(deadline) {
		cmd := exec.Command("systemctl", "--user", "is-active", unit)
		if err := cmd.Run(); err == nil {
			return
		}
		time.Sleep(500 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for active %s", unit)
}

func waitForBrowserUnitInactive(t *testing.T, sessionID string) {
	t.Helper()
	deadline := time.Now().Add(45 * time.Second)
	unit := fmt.Sprintf("browser-session@%s.service", sessionID)
	for time.Now().Before(deadline) {
		cmd := exec.Command("systemctl", "--user", "is-active", unit)
		if err := cmd.Run(); err != nil {
			return
		}
		time.Sleep(500 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for inactive %s", unit)
}

func waitForSessionCDPPort(t *testing.T, repo *db.Repository, sessionID string) int {
	t.Helper()
	deadline := time.Now().Add(45 * time.Second)
	for time.Now().Before(deadline) {
		row, err := repo.GetSessionByID(context.Background(), sessionID)
		if err == nil && row != nil && row.CurrentCDPPort != nil && *row.CurrentCDPPort > 0 {
			return *row.CurrentCDPPort
		}
		time.Sleep(500 * time.Millisecond)
	}
	t.Fatal("timed out waiting for session CDP port")
	return 0
}

func waitForCDPVersion(t *testing.T, port int) {
	t.Helper()
	url := fmt.Sprintf("http://127.0.0.1:%d/json/version", port)
	deadline := time.Now().Add(45 * time.Second)
	client := &http.Client{Timeout: 2 * time.Second}
	for time.Now().Before(deadline) {
		resp, err := client.Get(url)
		if err == nil && resp.StatusCode == http.StatusOK {
			_ = resp.Body.Close()
			return
		}
		if resp != nil {
			_ = resp.Body.Close()
		}
		time.Sleep(500 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for CDP endpoint %s", url)
}

func lookupChromium(t *testing.T) string {
	t.Helper()
	for _, name := range []string{"chromium", "chromium-browser"} {
		if path, err := exec.LookPath(name); err == nil {
			return path
		}
	}
	t.Skip("chromium not found in PATH")
	return ""
}

func postJSON(t *testing.T, client *http.Client, url, token, tenant string, body any) *http.Response {
	t.Helper()
	return doJSON(t, client, http.MethodPost, url, token, tenant, body)
}

func doJSON(t *testing.T, client *http.Client, method, url, token, tenant string, body any) *http.Response {
	t.Helper()
	var payload []byte
	if body != nil {
		var err error
		payload, err = json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
	}
	req, err := http.NewRequest(method, url, bytes.NewReader(payload))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if tenant != "" {
		req.Header.Set(auth.TenantHeader, tenant)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	return resp
}

func decodeJSON(t *testing.T, resp *http.Response, dst any) {
	t.Helper()
	defer resp.Body.Close()
	if err := json.NewDecoder(resp.Body).Decode(dst); err != nil {
		t.Fatalf("decode: %v", err)
	}
}

func readBody(resp *http.Response) string {
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return string(body)
}

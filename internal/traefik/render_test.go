package traefik_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/deploystate"
	"github.com/aperture/aperture/internal/traefik"
)

func testConfig() config.Config {
	return config.Config{
		ListenAddress:    "127.0.0.1:8080",
		DeployColor:      config.DeployColorBlue,
		DeployVersion:    "68fd220",
		DeployBlueURL:    "http://127.0.0.1:28080",
		DeployGreenURL:   "http://127.0.0.1:28082",
		CdpRouteBasePath: "/cdp",
	}
}

func testState() deploystate.State {
	return deploystate.State{
		ActiveColor:   config.DeployColorBlue,
		BlueURL:       "http://127.0.0.1:28080",
		GreenURL:      "http://127.0.0.1:28082",
		ActiveVersion: "68fd220",
		UpdatedAt:     "2026-01-01T00:00:00Z",
	}
}

func TestRenderEdgeConfigGolden(t *testing.T) {
	t.Parallel()

	got, err := traefik.RenderEdgeConfig(testConfig(), testState())
	if err != nil {
		t.Fatalf("RenderEdgeConfig() error = %v", err)
	}

	want := `# active color: blue
# active version: 68fd220
http:
  routers:
    aperture-api:
      rule: "PathPrefix(` + "`" + `/` + "`" + `) && !PathPrefix(` + "`" + `/internal` + "`" + `) && !PathPrefix(` + "`" + `/cdp` + "`" + `)"
      service: aperture-api-blue-68fd220
      priority: 1
      entryPoints:
        - web
  services:
    aperture-api-blue-68fd220:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:28080"
`
	if string(got) != want {
		t.Fatalf("rendered config mismatch\n--- got ---\n%s--- want ---\n%s", got, want)
	}
}

func TestRenderSessionsConfigGoldenNoSessions(t *testing.T) {
	t.Parallel()

	got, err := traefik.RenderSessionsConfig(testConfig(), testState(), nil)
	if err != nil {
		t.Fatalf("RenderSessionsConfig() error = %v", err)
	}

	want := readGolden(t, "dynamic_no_sessions.golden.yaml")
	if string(got) != want {
		t.Fatalf("rendered config mismatch\n--- got ---\n%s--- want ---\n%s", got, want)
	}
}

func TestRenderSessionsConfigIncludesCustomCDPBase(t *testing.T) {
	t.Parallel()

	cfg := testConfig()
	cfg.CdpRouteBasePath = "/browser"

	got, err := traefik.RenderSessionsConfig(cfg, testState(), []traefik.RunningSession{{
		ID:          "018f1234-0000-7000-8000-000000000001",
		CDPPort:     9222,
		WrapperPort: 9333,
	}})
	if err != nil {
		t.Fatalf("RenderSessionsConfig() error = %v", err)
	}
	rendered := string(got)

	if !strings.Contains(rendered, "PathPrefix(`/sessions/018f1234-0000-7000-8000-000000000001/cdp/cdp_`)") {
		t.Fatalf("cdp router rule mismatch:\n%s", rendered)
	}
	if strings.Contains(rendered, "/browser/018f1234-0000-7000-8000-000000000001") {
		t.Fatalf("cdp router must use live session path, not configured legacy base:\n%s", rendered)
	}
	if strings.Contains(rendered, "cdp-token/rotate") {
		t.Fatalf("cdp router must not match rotate API path:\n%s", rendered)
	}
}

func TestRenderSessionsConfigGoldenOneSession(t *testing.T) {
	t.Parallel()

	got, err := traefik.RenderSessionsConfig(testConfig(), testState(), []traefik.RunningSession{{
		ID:          "018f1234-0000-7000-8000-000000000001",
		CDPPort:     9222,
		WrapperPort: 9333,
	}})
	if err != nil {
		t.Fatalf("RenderSessionsConfig() error = %v", err)
	}

	want := readGolden(t, "dynamic_one_session.golden.yaml")
	if string(got) != want {
		t.Fatalf("rendered config mismatch\n--- got ---\n%s--- want ---\n%s", got, want)
	}
}

func TestRenderStaticConfig(t *testing.T) {
	t.Parallel()

	got, err := traefik.RenderStaticConfig(":8443", "/run/user/1000/aperture/traefik/dynamic")
	if err != nil {
		t.Fatalf("RenderStaticConfig() error = %v", err)
	}

	for _, want := range []string{
		"entryPoints:",
		"address: :8443",
		"directory: /run/user/1000/aperture/traefik/dynamic",
		"watch: true",
	} {
		if !strings.Contains(string(got), want) {
			t.Fatalf("static config missing %q:\n%s", want, got)
		}
	}
}

func TestWriteAtomicPersistsRenderedConfig(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	path := filepath.Join(dir, "traefik", "dynamic", "sessions.yaml")
	content, err := traefik.RenderSessionsConfig(testConfig(), testState(), nil)
	if err != nil {
		t.Fatalf("RenderSessionsConfig() error = %v", err)
	}
	if err := traefik.WriteAtomic(path, content); err != nil {
		t.Fatalf("WriteAtomic() error = %v", err)
	}

	written, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	if string(written) != string(content) {
		t.Fatalf("written config mismatch")
	}
}

func readGolden(t *testing.T, name string) string {
	t.Helper()
	path := filepath.Join("testdata", name)
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read golden %s: %v", name, err)
	}
	return string(body)
}

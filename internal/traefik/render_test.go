package traefik_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/traefik"
)

func testConfig() config.Config {
	return config.Config{
		ListenAddress:    "127.0.0.1:8080",
		CdpRouteBasePath: "/sessions",
	}
}

func TestRenderDynamicConfigGoldenNoSessions(t *testing.T) {
	t.Parallel()

	got, err := traefik.RenderDynamicConfig(testConfig(), nil)
	if err != nil {
		t.Fatalf("RenderDynamicConfig() error = %v", err)
	}

	want := readGolden(t, "dynamic_no_sessions.golden.yaml")
	if string(got) != want {
		t.Fatalf("rendered config mismatch\n--- got ---\n%s--- want ---\n%s", got, want)
	}
}

func TestRenderDynamicConfigIncludesSessionsAPIWithCustomCDPBase(t *testing.T) {
	t.Parallel()

	cfg := testConfig()
	cfg.CdpRouteBasePath = "/browser"

	got, err := traefik.RenderDynamicConfig(cfg, []traefik.RunningSession{{
		ID:      "018f1234-0000-7000-8000-000000000001",
		CDPPort: 9222,
	}})
	if err != nil {
		t.Fatalf("RenderDynamicConfig() error = %v", err)
	}
	rendered := string(got)

	if !strings.Contains(rendered, "PathPrefix(`/api/sessions`)") {
		t.Fatalf("api router missing /api/sessions prefix:\n%s", rendered)
	}
	if !strings.Contains(rendered, "PathPrefix(`/browser`)") {
		t.Fatalf("api router missing custom cdp base:\n%s", rendered)
	}
	if !strings.Contains(rendered, "Path(`/browser/018f1234-0000-7000-8000-000000000001/cdp`) || PathPrefix(`/browser/018f1234-0000-7000-8000-000000000001/cdp/`)") {
		t.Fatalf("cdp router rule mismatch:\n%s", rendered)
	}
	if strings.Contains(rendered, "cdp-token/rotate") {
		t.Fatalf("cdp router must not match rotate API path:\n%s", rendered)
	}
}

func TestRenderDynamicConfigGoldenOneSession(t *testing.T) {
	t.Parallel()

	got, err := traefik.RenderDynamicConfig(testConfig(), []traefik.RunningSession{{
		ID:      "018f1234-0000-7000-8000-000000000001",
		CDPPort: 9222,
	}})
	if err != nil {
		t.Fatalf("RenderDynamicConfig() error = %v", err)
	}

	want := readGolden(t, "dynamic_one_session.golden.yaml")
	if string(got) != want {
		t.Fatalf("rendered config mismatch\n--- got ---\n%s--- want ---\n%s", got, want)
	}
}

func TestRenderStaticConfig(t *testing.T) {
	t.Parallel()

	got, err := traefik.RenderStaticConfig(":8443", "/run/user/1000/aperture/traefik/dynamic.yaml")
	if err != nil {
		t.Fatalf("RenderStaticConfig() error = %v", err)
	}

	for _, want := range []string{
		"entryPoints:",
		"address: :8443",
		"filename: /run/user/1000/aperture/traefik/dynamic.yaml",
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
	path := filepath.Join(dir, "traefik", "dynamic.yaml")
	content, err := traefik.RenderDynamicConfig(testConfig(), nil)
	if err != nil {
		t.Fatalf("RenderDynamicConfig() error = %v", err)
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

package browser

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRenderRuntimeEnv(t *testing.T) {
	t.Parallel()

	values := RuntimeEnvValues{
		SessionID:          "018f1234-0000-7000-8000-000000000001",
		MergedUserDataDir:  "/store/sessions/01/8f/id/merged",
		DownloadsDir:       "/store/sessions/01/8f/id/downloads",
		CacheDir:           "/store/sessions/01/8f/id/cache",
		ArtifactsDir:       "/artifacts/01/8f/id",
		CDPPort:            9222,
		WrapperPort:        9223,
		BrowserExecutable:  "/usr/bin/chromium",
		BrowserDefaultArgs: []string{"--no-first-run"},
		BrowserExtraArgs:   []string{"--disable-sync"},
	}

	body, err := RenderRuntimeEnv(values)
	if err != nil {
		t.Fatalf("RenderRuntimeEnv() error = %v", err)
	}

	parsed, err := ParseRuntimeEnv(body)
	if err != nil {
		t.Fatalf("ParseRuntimeEnv() error = %v", err)
	}

	if parsed.SessionID != values.SessionID {
		t.Fatalf("session id = %q, want %q", parsed.SessionID, values.SessionID)
	}
	if parsed.CDPPort != values.CDPPort {
		t.Fatalf("cdp port = %d, want %d", parsed.CDPPort, values.CDPPort)
	}
	if parsed.BrowserExecutable != values.BrowserExecutable {
		t.Fatalf("executable = %q", parsed.BrowserExecutable)
	}
	if len(parsed.BrowserDefaultArgs) != len(values.BrowserDefaultArgs) {
		t.Fatalf("default args = %#v", parsed.BrowserDefaultArgs)
	}
	if len(parsed.BrowserExtraArgs) != len(values.BrowserExtraArgs) {
		t.Fatalf("extra args = %#v", parsed.BrowserExtraArgs)
	}
}

func TestRenderRuntimeEnvEncodesComplexArgVectors(t *testing.T) {
	t.Parallel()

	values := RuntimeEnvValues{
		SessionID:         "018f1234-0000-7000-8000-000000000005",
		MergedUserDataDir: "/store/merged",
		DownloadsDir:      "/store/downloads",
		CacheDir:          "/store/cache",
		ArtifactsDir:      "/artifacts",
		CDPPort:           9555,
		WrapperPort:       9556,
		BrowserExecutable: "/usr/bin/chromium",
		BrowserDefaultArgs: []string{
			"--flag with spaces",
			`--quoted="value"`,
			`--backslash=\path`,
		},
		BrowserExtraArgs: []string{
			"--extra",
			`--foo='bar baz'`,
		},
	}

	body, err := RenderRuntimeEnv(values)
	if err != nil {
		t.Fatalf("RenderRuntimeEnv() error = %v", err)
	}

	parsed, err := ParseRuntimeEnv(body)
	if err != nil {
		t.Fatalf("ParseRuntimeEnv() error = %v", err)
	}

	assertStringSliceEqual(t, "default args", parsed.BrowserDefaultArgs, values.BrowserDefaultArgs)
	assertStringSliceEqual(t, "extra args", parsed.BrowserExtraArgs, values.BrowserExtraArgs)

	bodyStr := string(body)
	if strings.Contains(bodyStr, "\x1f") {
		t.Fatalf("env body must not contain unit separator: %q", bodyStr)
	}
}

func assertStringSliceEqual(t *testing.T, name string, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s length = %d, want %d (%#v)", name, len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("%s[%d] = %q, want %q", name, i, got[i], want[i])
		}
	}
}

func TestRenderRuntimeEnvQuotesSpecialCharacters(t *testing.T) {
	t.Parallel()

	values := RuntimeEnvValues{
		SessionID:         "018f1234-0000-7000-8000-000000000002",
		MergedUserDataDir: "/store/with space/merged",
		DownloadsDir:      "/store/downloads",
		CacheDir:          "/store/cache",
		ArtifactsDir:      "/artifacts",
		CDPPort:           9333,
		WrapperPort:       9334,
		BrowserExecutable: "/usr/bin/chromium",
		BrowserExtraArgs:  []string{`--foo="bar"`},
	}

	body, err := RenderRuntimeEnv(values)
	if err != nil {
		t.Fatalf("RenderRuntimeEnv() error = %v", err)
	}

	parsed, err := ParseRuntimeEnv(body)
	if err != nil {
		t.Fatalf("ParseRuntimeEnv() error = %v", err)
	}
	if parsed.BrowserExtraArgs[0] != `--foo="bar"` {
		t.Fatalf("extra args = %#v", parsed.BrowserExtraArgs)
	}
}

func TestWriteRuntimeEnvAtomic(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	path := filepath.Join(dir, "sessions", "018f1234-0000-7000-8000-000000000003.env")

	values := RuntimeEnvValues{
		SessionID:         "018f1234-0000-7000-8000-000000000003",
		MergedUserDataDir: filepath.Join(dir, "merged"),
		DownloadsDir:      filepath.Join(dir, "downloads"),
		CacheDir:          filepath.Join(dir, "cache"),
		ArtifactsDir:      filepath.Join(dir, "artifacts"),
		CDPPort:           9444,
		WrapperPort:       9445,
		BrowserExecutable: "/usr/bin/chromium",
	}

	if err := WriteRuntimeEnv(path, values); err != nil {
		t.Fatalf("WriteRuntimeEnv() error = %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat runtime env: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("permissions = %o, want 0600", info.Mode().Perm())
	}

	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read runtime env: %v", err)
	}
	parsed, err := ParseRuntimeEnv(body)
	if err != nil {
		t.Fatalf("ParseRuntimeEnv() error = %v", err)
	}
	if parsed.SessionID != values.SessionID {
		t.Fatalf("session id = %q", parsed.SessionID)
	}
}

func TestRenderRuntimeEnvRejectsInvalidPort(t *testing.T) {
	t.Parallel()

	_, err := RenderRuntimeEnv(RuntimeEnvValues{
		SessionID:         "018f1234-0000-7000-8000-000000000004",
		MergedUserDataDir: "/merged",
		DownloadsDir:      "/downloads",
		CacheDir:          "/cache",
		ArtifactsDir:      "/artifacts",
		CDPPort:           0,
		BrowserExecutable: "/usr/bin/chromium",
	})
	if err == nil {
		t.Fatal("expected invalid port error")
	}
}

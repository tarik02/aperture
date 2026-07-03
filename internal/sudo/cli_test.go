package sudo

import (
	"os"
	"path/filepath"
	"testing"
)

func TestHelperConfigIgnoresEnvironmentOverrides(t *testing.T) {
	dir := t.TempDir()
	trustedRoot := filepath.Join(dir, "trusted")
	evilRoot := filepath.Join(dir, "evil")

	trustedConfig := filepath.Join(dir, "aperture.toml")
	if err := writeHelperConfig(trustedConfig, trustedRoot); err != nil {
		t.Fatalf("write trusted config: %v", err)
	}

	maliciousConfig := filepath.Join(dir, "malicious.toml")
	if err := writeHelperConfig(maliciousConfig, evilRoot); err != nil {
		t.Fatalf("write malicious config: %v", err)
	}

	restore := overrideHelperConfigLoader(func(string) error { return nil })
	defer restore()

	t.Setenv("APERTURE_CONFIG", maliciousConfig)
	t.Setenv("APERTURE_STORE_ROOT", evilRoot)
	t.Setenv("APERTURE_ARTIFACT_ROOT", evilRoot)
	t.Setenv("APERTURE_RUNTIME_ROOT", evilRoot)

	storeRoot, artifactRoot, err := helperConfigRootsForTest([]string{trustedConfig})
	if err != nil {
		t.Fatalf("helperConfigRootsForTest() error = %v", err)
	}
	if storeRoot != trustedRoot {
		t.Fatalf("store root = %q, want trusted root %q", storeRoot, trustedRoot)
	}
	wantArtifacts := filepath.Join(trustedRoot, "artifacts")
	if artifactRoot != wantArtifacts {
		t.Fatalf("artifact root = %q, want %q", artifactRoot, wantArtifacts)
	}
}

func writeHelperConfig(path, storeRoot string) error {
	runtimeRoot := filepath.Join(filepath.Dir(storeRoot), "runtime")
	contents := `store_root = "` + storeRoot + `"
runtime_root = "` + runtimeRoot + `"
external_base_url = "https://browser.example.test"
listen_address = "127.0.0.1:8080"

[channels.chromium]
executable = "/usr/bin/chromium"
`
	return os.WriteFile(path, []byte(contents), 0o644)
}

func overrideHelperConfigLoader(validate func(string) error) func() {
	oldValidate := validateTrustedConfig
	validateTrustedConfig = validate
	return func() {
		validateTrustedConfig = oldValidate
	}
}

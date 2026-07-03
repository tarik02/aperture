package cli

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func writeTestConfig(t *testing.T) string {
	t.Helper()

	root := t.TempDir()
	storeRoot := filepath.Join(root, "store")
	runtimeRoot := filepath.Join(root, "runtime")
	if err := os.MkdirAll(storeRoot, 0o700); err != nil {
		t.Fatalf("mkdir store: %v", err)
	}
	if err := os.MkdirAll(runtimeRoot, 0o700); err != nil {
		t.Fatalf("mkdir runtime: %v", err)
	}

	configPath := filepath.Join(root, "aperture.yaml")
	content := fmt.Sprintf(`store_root: %q
runtime_root: %q
database_path: %q
external_base_url: "https://browser.example.test"
channels:
  chromium:
    executable: "/usr/bin/chromium"
`, storeRoot, runtimeRoot, filepath.Join(storeRoot, "aperture.db"))

	if err := os.WriteFile(configPath, []byte(content), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	return configPath
}

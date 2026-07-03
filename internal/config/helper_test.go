package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadFromFileOnlyHonorsExplicitArtifactRoot(t *testing.T) {
	dir := t.TempDir()
	storeRoot := filepath.Join(dir, "store")
	runtimeRoot := filepath.Join(dir, "runtime")
	artifactRoot := filepath.Join(dir, "custom-artifacts")
	configPath := filepath.Join(dir, "aperture.toml")

	contents := `store_root = "` + storeRoot + `"
runtime_root = "` + runtimeRoot + `"
artifact_root = "` + artifactRoot + `"
external_base_url = "https://browser.example.test"
listen_address = "127.0.0.1:8080"

[channels.chromium]
executable = "/usr/bin/chromium"
`
	if err := os.WriteFile(configPath, []byte(contents), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cfg, err := LoadFromFileOnly(configPath)
	if err != nil {
		t.Fatalf("LoadFromFileOnly() error = %v", err)
	}
	if cfg.ArtifactRoot != artifactRoot {
		t.Fatalf("artifact_root = %q, want explicit %q", cfg.ArtifactRoot, artifactRoot)
	}
	if cfg.DatabasePath != filepath.Join(storeRoot, "aperture.db") {
		t.Fatalf("database_path = %q, want derived from store_root", cfg.DatabasePath)
	}
}

func TestLoadFromFileOnlyDerivesArtifactRootWhenUnset(t *testing.T) {
	dir := t.TempDir()
	storeRoot := filepath.Join(dir, "store")
	runtimeRoot := filepath.Join(dir, "runtime")
	configPath := filepath.Join(dir, "aperture.toml")

	contents := `store_root = "` + storeRoot + `"
runtime_root = "` + runtimeRoot + `"
external_base_url = "https://browser.example.test"
listen_address = "127.0.0.1:8080"

[channels.chromium]
executable = "/usr/bin/chromium"
`
	if err := os.WriteFile(configPath, []byte(contents), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cfg, err := LoadFromFileOnly(configPath)
	if err != nil {
		t.Fatalf("LoadFromFileOnly() error = %v", err)
	}
	wantArtifactRoot := filepath.Join(storeRoot, "artifacts")
	if cfg.ArtifactRoot != wantArtifactRoot {
		t.Fatalf("artifact_root = %q, want derived %q", cfg.ArtifactRoot, wantArtifactRoot)
	}
}

func TestValidateTrustedConfigParentDirRejectsGroupWritable(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o770); err != nil {
		t.Fatalf("chmod parent: %v", err)
	}

	info, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("stat parent: %v", err)
	}

	if err := validateTrustedConfigParentDir(info); err == nil {
		t.Fatal("expected group-writable parent rejection")
	}
}

func TestValidateTrustedConfigParentDirRejectsWorldWritable(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o777); err != nil {
		t.Fatalf("chmod parent: %v", err)
	}

	info, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("stat parent: %v", err)
	}

	if err := validateTrustedConfigParentDir(info); err == nil {
		t.Fatal("expected world-writable parent rejection")
	}
}

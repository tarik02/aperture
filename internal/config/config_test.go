package config

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/spf13/viper"
)

func TestDefaultsAreInvalidWithoutChannelsAndExternalURL(t *testing.T) {
	if err := Validate(Defaults()); err == nil {
		t.Fatal("expected bare defaults to fail validation")
	}
}

func TestValidTestConfigPassesValidation(t *testing.T) {
	if err := Validate(validTestConfig(t)); err != nil {
		t.Fatalf("valid test config failed validation: %v", err)
	}
}

func TestValidateRejectsNonLoopback(t *testing.T) {
	cfg := validTestConfig(t)
	cfg.ListenAddress = "0.0.0.0:8080"
	if err := Validate(cfg); err == nil {
		t.Fatal("expected non-loopback listen address to fail validation")
	}
}

func TestValidateRejectsRelativePaths(t *testing.T) {
	cfg := validTestConfig(t)
	cfg.StoreRoot = "relative/store"
	if err := Validate(cfg); err == nil {
		t.Fatal("expected relative store_root to fail validation")
	}

	cfg = validTestConfig(t)
	cfg.CdpRouteBasePath = "/internal/cdp"
	if err := Validate(cfg); err == nil {
		t.Fatal("expected cdp_route_base_path under /internal to fail validation")
	}
}

func TestLoadUsesFlagPrecedence(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "aperture.toml")
	storeRoot := filepath.Join(dir, "store")
	runtimeRoot := filepath.Join(dir, "runtime")
	artifactRoot := filepath.Join(dir, "artifacts")

	contents := `
store_root = "` + storeRoot + `"
runtime_root = "` + runtimeRoot + `"
artifact_root = "` + artifactRoot + `"
external_base_url = "https://browser.example.test"
listen_address = "127.0.0.1:7070"

[channels.chromium]
executable = "/usr/bin/chromium"
`
	if err := os.WriteFile(configPath, []byte(contents), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	flags := viper.New()
	flags.Set("config", configPath)
	flags.Set("listen-address", "127.0.0.1:9090")
	flags.Set("log-level", "debug")

	cfg, err := Load(flags)
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	if cfg.ListenAddress != "127.0.0.1:9090" {
		t.Fatalf("listen address = %q, want 127.0.0.1:9090", cfg.ListenAddress)
	}
	if cfg.LogLevel != "debug" {
		t.Fatalf("log level = %q, want debug", cfg.LogLevel)
	}
}

func TestLoadUsesEnvPrecedenceOverDefaults(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "aperture.toml")
	storeRoot := filepath.Join(dir, "store")
	runtimeRoot := filepath.Join(dir, "runtime")
	envStoreRoot := filepath.Join(dir, "env-store")

	contents := `
store_root = "` + storeRoot + `"
runtime_root = "` + runtimeRoot + `"
external_base_url = "https://file.example.test"

[channels.chromium]
executable = "/usr/bin/chromium"
`
	if err := os.WriteFile(configPath, []byte(contents), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	t.Setenv("APERTURE_STORE_ROOT", envStoreRoot)

	flags := viper.New()
	flags.Set("config", configPath)

	cfg, err := Load(flags)
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	if cfg.StoreRoot != envStoreRoot {
		t.Fatalf("store root = %q, want %q", cfg.StoreRoot, envStoreRoot)
	}
	if cfg.ArtifactRoot != filepath.Join(envStoreRoot, "artifacts") {
		t.Fatalf("artifact root = %q, want derived from env store root", cfg.ArtifactRoot)
	}
	if cfg.DatabasePath != filepath.Join(envStoreRoot, "aperture.db") {
		t.Fatalf("database path = %q, want derived from env store root", cfg.DatabasePath)
	}
	if cfg.DeployStatePath != filepath.Join(envStoreRoot, "deployment-state.json") {
		t.Fatalf("deploy state path = %q, want derived from env store root", cfg.DeployStatePath)
	}
	if cfg.ExternalBaseURL != "https://file.example.test" {
		t.Fatalf("external base url = %q, want file value", cfg.ExternalBaseURL)
	}
}

func TestLoadUsesConfigFileValues(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "aperture.toml")
	storeRoot := filepath.Join(dir, "store")
	runtimeRoot := filepath.Join(dir, "runtime")
	artifactRoot := filepath.Join(dir, "artifacts")

	contents := `
store_root = "` + storeRoot + `"
runtime_root = "` + runtimeRoot + `"
artifact_root = "` + artifactRoot + `"
external_base_url = "https://file.example.test"
listen_address = "127.0.0.1:7070"

[channels.chromium]
executable = "/usr/bin/chromium"
default_args = ["--no-first-run"]
`
	if err := os.WriteFile(configPath, []byte(contents), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	flags := viper.New()
	flags.Set("config", configPath)

	cfg, err := Load(flags)
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	if cfg.ListenAddress != "127.0.0.1:7070" {
		t.Fatalf("listen address = %q, want file value", cfg.ListenAddress)
	}
	if cfg.ChannelRegistry["chromium"].Executable != "/usr/bin/chromium" {
		t.Fatalf("channel executable = %q, want /usr/bin/chromium", cfg.ChannelRegistry["chromium"].Executable)
	}
}

func TestLoadWithoutConfigFileFailsWhenRequiredFieldsMissing(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)

	flags := viper.New()
	if _, err := Load(flags); err == nil {
		t.Fatal("expected error when required config fields are missing")
	}
}

func TestLoadFindsDefaultConfigFileInWorkingDirectory(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)
	storeRoot := filepath.Join(dir, "store")
	runtimeRoot := filepath.Join(dir, "runtime")
	artifactRoot := filepath.Join(dir, "artifacts")

	contents := `
store_root = "` + storeRoot + `"
runtime_root = "` + runtimeRoot + `"
artifact_root = "` + artifactRoot + `"
external_base_url = "https://browser.example.test"

[channels.chromium]
executable = "/usr/bin/chromium"
`
	if err := os.WriteFile(filepath.Join(dir, "aperture.toml"), []byte(contents), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	flags := viper.New()
	if _, err := Load(flags); err != nil {
		t.Fatalf("load config with default file: %v", err)
	}
}

func TestLoadExplicitMissingConfigFileReturnsError(t *testing.T) {
	flags := viper.New()
	flags.Set("config", filepath.Join(t.TempDir(), "missing.toml"))

	if _, err := Load(flags); err == nil {
		t.Fatal("expected error for missing explicit config file")
	}
}

func TestLoadMalformedConfigFileReturnsError(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "aperture.toml")
	if err := os.WriteFile(configPath, []byte("listen_address = [\n"), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	flags := viper.New()
	flags.Set("config", configPath)

	if _, err := Load(flags); err == nil {
		t.Fatal("expected error for malformed config file")
	}
}

func TestLoadFlagOverridesConfigFile(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "aperture.toml")
	storeRoot := filepath.Join(dir, "store")
	runtimeRoot := filepath.Join(dir, "runtime")
	artifactRoot := filepath.Join(dir, "artifacts")

	contents := `
store_root = "` + storeRoot + `"
runtime_root = "` + runtimeRoot + `"
artifact_root = "` + artifactRoot + `"
external_base_url = "https://file.example.test"
listen_address = "127.0.0.1:7070"

[channels.chromium]
executable = "/usr/bin/chromium"
`
	if err := os.WriteFile(configPath, []byte(contents), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	flags := viper.New()
	flags.Set("config", configPath)
	flags.Set("listen-address", "127.0.0.1:9090")

	cfg, err := Load(flags)
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	if cfg.ListenAddress != "127.0.0.1:9090" {
		t.Fatalf("listen address = %q, want flag override", cfg.ListenAddress)
	}
}

func TestLoadDerivesPathsFromStoreRootFlag(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "aperture.toml")
	runtimeRoot := filepath.Join(dir, "runtime")
	flagStoreRoot := filepath.Join(dir, "flag-store")

	contents := `
store_root = "` + filepath.Join(dir, "file-store") + `"
runtime_root = "` + runtimeRoot + `"
external_base_url = "https://browser.example.test"

[channels.chromium]
executable = "/usr/bin/chromium"
`
	if err := os.WriteFile(configPath, []byte(contents), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	flags := viper.New()
	flags.Set("config", configPath)
	flags.Set("store-root", flagStoreRoot)

	cfg, err := Load(flags)
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	if cfg.StoreRoot != flagStoreRoot {
		t.Fatalf("store root = %q, want flag override", cfg.StoreRoot)
	}
	if cfg.ArtifactRoot != filepath.Join(flagStoreRoot, "artifacts") {
		t.Fatalf("artifact root = %q, want derived from flag store root", cfg.ArtifactRoot)
	}
	if cfg.DatabasePath != filepath.Join(flagStoreRoot, "aperture.db") {
		t.Fatalf("database path = %q, want derived from flag store root", cfg.DatabasePath)
	}
}

func TestLoadDerivesTraefikPathFromRuntimeRootFlag(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "aperture.toml")
	storeRoot := filepath.Join(dir, "store")
	flagRuntimeRoot := filepath.Join(dir, "flag-runtime")

	contents := `
store_root = "` + storeRoot + `"
runtime_root = "` + filepath.Join(dir, "file-runtime") + `"
external_base_url = "https://browser.example.test"

[channels.chromium]
executable = "/usr/bin/chromium"
`
	if err := os.WriteFile(configPath, []byte(contents), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	flags := viper.New()
	flags.Set("config", configPath)
	flags.Set("runtime-root", flagRuntimeRoot)

	cfg, err := Load(flags)
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	if cfg.RuntimeRoot != flagRuntimeRoot {
		t.Fatalf("runtime root = %q, want flag override", cfg.RuntimeRoot)
	}
	wantTraefik := filepath.Join(flagRuntimeRoot, "traefik", "dynamic")
	if cfg.TraefikDynamicConfigDir != wantTraefik {
		t.Fatalf("traefik path = %q, want %q", cfg.TraefikDynamicConfigDir, wantTraefik)
	}
}

func TestLoadKeepsExplicitDerivedPaths(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "aperture.toml")
	storeRoot := filepath.Join(dir, "store")
	runtimeRoot := filepath.Join(dir, "runtime")
	customArtifactRoot := filepath.Join(dir, "custom-artifacts")
	customDatabasePath := filepath.Join(dir, "custom.db")
	customTraefikPath := filepath.Join(dir, "custom-traefik")

	contents := `
store_root = "` + storeRoot + `"
runtime_root = "` + runtimeRoot + `"
artifact_root = "` + customArtifactRoot + `"
database_path = "` + customDatabasePath + `"
traefik_dynamic_config_dir = "` + customTraefikPath + `"
external_base_url = "https://browser.example.test"

[channels.chromium]
executable = "/usr/bin/chromium"
`
	if err := os.WriteFile(configPath, []byte(contents), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	flags := viper.New()
	flags.Set("config", configPath)
	flags.Set("store-root", filepath.Join(dir, "override-store"))
	flags.Set("runtime-root", filepath.Join(dir, "override-runtime"))

	cfg, err := Load(flags)
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	if cfg.ArtifactRoot != customArtifactRoot {
		t.Fatalf("artifact root = %q, want explicit config value", cfg.ArtifactRoot)
	}
	if cfg.DatabasePath != customDatabasePath {
		t.Fatalf("database path = %q, want explicit config value", cfg.DatabasePath)
	}
	if cfg.TraefikDynamicConfigDir != customTraefikPath {
		t.Fatalf("traefik path = %q, want explicit config value", cfg.TraefikDynamicConfigDir)
	}
}

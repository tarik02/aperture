package config

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/spf13/viper"
)

func TestDefaultsAreValid(t *testing.T) {
	if err := Validate(Defaults()); err != nil {
		t.Fatalf("defaults invalid: %v", err)
	}
}

func TestValidateRejectsNonLoopback(t *testing.T) {
	cfg := Defaults()
	cfg.ListenAddress = "0.0.0.0:8080"
	if err := Validate(cfg); err == nil {
		t.Fatal("expected non-loopback listen address to fail validation")
	}
}

func TestLoadUsesFlagPrecedence(t *testing.T) {
	flags := viper.New()
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

func TestLoadIgnoresMissingDefaultConfigFile(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)

	flags := viper.New()
	if _, err := Load(flags); err != nil {
		t.Fatalf("load config without file: %v", err)
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

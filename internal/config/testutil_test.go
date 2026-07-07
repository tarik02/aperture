package config

import (
	"path/filepath"
	"testing"
)

func validTestConfig(t *testing.T) Config {
	t.Helper()

	root := t.TempDir()
	storeRoot := filepath.Join(root, "store")
	runtimeRoot := filepath.Join(root, "runtime")
	artifactRoot := filepath.Join(root, "artifacts")

	return Config{
		StoreRoot:                storeRoot,
		RuntimeRoot:              runtimeRoot,
		ArtifactRoot:             artifactRoot,
		DatabasePath:             filepath.Join(storeRoot, "aperture.db"),
		TraefikDynamicConfigPath: filepath.Join(runtimeRoot, "traefik", "dynamic.yaml"),
		DeployColor:              DeployColorBlue,
		DeployStatePath:          filepath.Join(storeRoot, "deployment-state.json"),
		DeployBlueURL:            "http://127.0.0.1:28080",
		DeployGreenURL:           "http://127.0.0.1:28082",
		ListenAddress:            "127.0.0.1:8080",
		SystemdBrowserUnitName:   "browser-session@.service",
		SessionRetentionDays:     7,
		SnapshotRetentionDays:    7,
		ChannelRegistry: map[string]ChannelConfig{
			"chromium": {Executable: "/usr/bin/chromium"},
		},
		ExternalBaseURL:  "https://browser.example.test",
		CdpRouteBasePath: "/cdp",
		LogLevel:         "info",
	}
}

package sudo

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/aperture/aperture/internal/config"
)

var (
	trustedHelperConfigPaths = []string{"/etc/aperture/aperture.toml"}
	validateTrustedConfig    = config.ValidateTrustedConfigFile
	loadConfigFromFile       = config.LoadFromFileOnly
)

var ErrUntrustedHelperConfig = errors.New("trusted helper config unavailable")

func loadHelperConfig() (config.Config, error) {
	return loadHelperConfigFromPaths(trustedHelperConfigPaths)
}

func loadHelperConfigFromPaths(paths []string) (config.Config, error) {
	for _, path := range paths {
		if err := validateTrustedConfig(path); err != nil {
			continue
		}
		cfg, err := loadConfigFromFile(path)
		if err != nil {
			return config.Config{}, fmt.Errorf("load trusted config %s: %w", path, err)
		}
		return cfg, nil
	}
	return config.Config{}, ErrUntrustedHelperConfig
}

// RunMountCLI executes the aperture-mount-session helper command.
func RunMountCLI(args []string) error {
	req, err := ParseMountArgs(args)
	if err != nil {
		return err
	}

	cfg, err := loadHelperConfig()
	if err != nil {
		return err
	}

	return MountSession(context.Background(), cfg, req)
}

// RunUnmountCLI executes the aperture-unmount-session helper command.
func RunUnmountCLI(args []string) error {
	sessionID, err := ParseUnmountArgs(args)
	if err != nil {
		return err
	}

	cfg, err := loadHelperConfig()
	if err != nil {
		return err
	}

	return UnmountSession(context.Background(), cfg, sessionID)
}

// helperConfigRootsForTest exposes resolved roots for tests.
func helperConfigRootsForTest(paths []string) (storeRoot, artifactRoot string, err error) {
	_ = os.Unsetenv("APERTURE_CONFIG")
	_ = os.Unsetenv("APERTURE_STORE_ROOT")
	_ = os.Unsetenv("APERTURE_ARTIFACT_ROOT")
	_ = os.Unsetenv("APERTURE_RUNTIME_ROOT")

	cfg, err := loadHelperConfigFromPaths(paths)
	if err != nil {
		return "", "", err
	}
	return cfg.StoreRoot, cfg.ArtifactRoot, nil
}

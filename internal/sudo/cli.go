package sudo

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

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

func loadRequestedHelperConfig(path string) (config.Config, error) {
	if strings.TrimSpace(path) == "" {
		return loadHelperConfig()
	}

	cleaned, err := trustedRequestedHelperConfigPath(path)
	if err != nil {
		return config.Config{}, err
	}
	if err := validateTrustedConfig(cleaned); err != nil {
		return config.Config{}, fmt.Errorf("%w: %s: %v", ErrUntrustedHelperConfig, cleaned, err)
	}

	cfg, err := loadConfigFromFile(cleaned)
	if err != nil {
		return config.Config{}, fmt.Errorf("load trusted config %s: %w", cleaned, err)
	}
	return cfg, nil
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

func trustedRequestedHelperConfigPath(path string) (string, error) {
	trimmed := strings.TrimSpace(path)
	if trimmed == "" {
		return "", fmt.Errorf("%w: config path is required", ErrInvalidArguments)
	}
	if !filepath.IsAbs(trimmed) {
		return "", fmt.Errorf("%w: helper config path must be absolute", ErrUntrustedHelperConfig)
	}

	cleaned := filepath.Clean(trimmed)
	for _, trusted := range trustedHelperConfigPaths {
		trustedCleaned := filepath.Clean(trusted)
		if cleaned == trustedCleaned || filepath.Dir(cleaned) == filepath.Dir(trustedCleaned) {
			return cleaned, nil
		}
	}
	return "", fmt.Errorf("%w: helper config path is outside trusted config directories", ErrUntrustedHelperConfig)
}

// RunMountCLI executes the aperture-mount-session helper command.
func RunMountCLI(args []string) error {
	configPath, remaining, err := parseHelperConfigFlag(args)
	if err != nil {
		return err
	}

	req, err := ParseMountArgs(remaining)
	if err != nil {
		return err
	}

	cfg, err := loadRequestedHelperConfig(configPath)
	if err != nil {
		return err
	}

	return MountSession(context.Background(), cfg, req)
}

// RunUnmountCLI executes the aperture-unmount-session helper command.
func RunUnmountCLI(args []string) error {
	configPath, remaining, err := parseHelperConfigFlag(args)
	if err != nil {
		return err
	}

	sessionID, err := ParseUnmountArgs(remaining)
	if err != nil {
		return err
	}

	cfg, err := loadRequestedHelperConfig(configPath)
	if err != nil {
		return err
	}

	return UnmountSession(context.Background(), cfg, sessionID)
}

func parseHelperConfigFlag(args []string) (string, []string, error) {
	if len(args) == 0 {
		return "", args, nil
	}

	first := strings.TrimSpace(args[0])
	if first == "--config" {
		if len(args) < 2 || strings.TrimSpace(args[1]) == "" {
			return "", nil, fmt.Errorf("%w: --config requires a path", ErrInvalidArguments)
		}
		return args[1], args[2:], nil
	}
	if value, ok := strings.CutPrefix(first, "--config="); ok {
		if strings.TrimSpace(value) == "" {
			return "", nil, fmt.Errorf("%w: --config requires a path", ErrInvalidArguments)
		}
		return value, args[1:], nil
	}
	return "", args, nil
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

package session

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/paths"
	"github.com/google/renameio/v2"
)

func cdpTokenPath(cfg config.Config, sessionID string) (string, error) {
	return paths.JoinUnderRoot(cfg.StoreRoot, "session-cdp-tokens", sessionID)
}

// StoreCDPTokenSeal writes the raw CDP token for later reopen responses.
func StoreCDPTokenSeal(cfg config.Config, sessionID, rawToken string) error {
	path, err := cdpTokenPath(cfg, sessionID)
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("mkdir cdp token dir: %w", err)
	}

	if err := renameio.WriteFile(path, []byte(rawToken), 0o600, renameio.WithStaticPermissions(0o600)); err != nil {
		return fmt.Errorf("write cdp token: %w", err)
	}
	return nil
}

// LoadCDPTokenSeal reads the sealed raw CDP token for reopen responses.
func LoadCDPTokenSeal(cfg config.Config, sessionID string) (string, error) {
	path, err := cdpTokenPath(cfg, sessionID)
	if err != nil {
		return "", err
	}
	body, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read cdp token seal: %w", err)
	}
	raw := string(body)
	if raw == "" {
		return "", fmt.Errorf("cdp token seal is empty")
	}
	return raw, nil
}

// RemoveCDPTokenSeal deletes the sealed CDP token file.
func RemoveCDPTokenSeal(cfg config.Config, sessionID string) error {
	path, err := cdpTokenPath(cfg, sessionID)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove cdp token seal: %w", err)
	}
	return nil
}

package session

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/paths"
)

func cdpTokenPath(cfg config.Config, sessionID string) (string, error) {
	return paths.JoinUnderRoot(cfg.RuntimeRoot, "sessions", sessionID+".cdp-token")
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

	tmp, err := os.CreateTemp(dir, ".cdp-token-*")
	if err != nil {
		return fmt.Errorf("create temp cdp token: %w", err)
	}
	tmpPath := tmp.Name()
	cleanup := func() {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
	}

	if _, err := tmp.WriteString(rawToken); err != nil {
		cleanup()
		return fmt.Errorf("write cdp token: %w", err)
	}
	if err := tmp.Chmod(0o600); err != nil {
		cleanup()
		return fmt.Errorf("chmod cdp token: %w", err)
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return fmt.Errorf("close cdp token: %w", err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		cleanup()
		return fmt.Errorf("rename cdp token: %w", err)
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

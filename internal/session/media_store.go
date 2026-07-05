package session

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/paths"
	"github.com/google/renameio/v2"
)

func mediaTokenHashPath(cfg config.Config, sessionID string) (string, error) {
	return paths.JoinUnderRoot(cfg.RuntimeRoot, "sessions", sessionID+".media-token-hash")
}

// StoreMediaTokenHash writes the media producer token hash for signaling auth.
func StoreMediaTokenHash(cfg config.Config, sessionID, tokenHash string) error {
	path, err := mediaTokenHashPath(cfg, sessionID)
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("mkdir media token dir: %w", err)
	}

	if err := renameio.WriteFile(path, []byte(tokenHash), 0o600, renameio.WithStaticPermissions(0o600)); err != nil {
		return fmt.Errorf("write media token hash: %w", err)
	}
	return nil
}

// LoadMediaTokenHash reads the media producer token hash for signaling auth.
func LoadMediaTokenHash(cfg config.Config, sessionID string) (string, error) {
	path, err := mediaTokenHashPath(cfg, sessionID)
	if err != nil {
		return "", err
	}
	body, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read media token hash: %w", err)
	}
	hash := string(body)
	if hash == "" {
		return "", fmt.Errorf("media token hash is empty")
	}
	return hash, nil
}

// RemoveMediaTokenHash deletes the media producer token hash.
func RemoveMediaTokenHash(cfg config.Config, sessionID string) error {
	path, err := mediaTokenHashPath(cfg, sessionID)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove media token hash: %w", err)
	}
	return nil
}

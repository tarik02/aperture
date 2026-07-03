package jobtoken

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"

	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/paths"
)

const secretBytes = 32

// Path returns the local job token file path.
func Path(cfg config.Config) (string, error) {
	return paths.JoinUnderRoot(cfg.RuntimeRoot, "job-token")
}

// Ensure creates the job token file when missing and returns the raw token value.
func Ensure(cfg config.Config) (string, error) {
	path, err := Path(cfg)
	if err != nil {
		return "", err
	}

	if body, err := os.ReadFile(path); err == nil {
		raw := string(body)
		if raw != "" {
			return raw, nil
		}
	} else if !os.IsNotExist(err) {
		return "", fmt.Errorf("read job token: %w", err)
	}

	secret := make([]byte, secretBytes)
	if _, err := rand.Read(secret); err != nil {
		return "", fmt.Errorf("generate job token: %w", err)
	}
	raw := base64.RawURLEncoding.EncodeToString(secret)

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("mkdir job token dir: %w", err)
	}

	tmp, err := os.CreateTemp(dir, ".job-token-*")
	if err != nil {
		return "", fmt.Errorf("create temp job token: %w", err)
	}
	tmpPath := tmp.Name()
	cleanup := func() {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
	}

	if _, err := tmp.WriteString(raw); err != nil {
		cleanup()
		return "", fmt.Errorf("write job token: %w", err)
	}
	if err := tmp.Chmod(0o600); err != nil {
		cleanup()
		return "", fmt.Errorf("chmod job token: %w", err)
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return "", fmt.Errorf("close job token: %w", err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		cleanup()
		return "", fmt.Errorf("rename job token: %w", err)
	}
	return raw, nil
}

// Load reads the job token from the local runtime file.
func Load(cfg config.Config) (string, error) {
	path, err := Path(cfg)
	if err != nil {
		return "", err
	}
	body, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read job token: %w", err)
	}
	raw := string(body)
	if raw == "" {
		return "", ErrMissing
	}
	return raw, nil
}

// Verify compares a presented token with the expected value using constant time.
func Verify(expected, presented string) error {
	if expected == "" || presented == "" {
		return ErrInvalid
	}
	if subtle.ConstantTimeCompare([]byte(expected), []byte(presented)) != 1 {
		return ErrInvalid
	}
	return nil
}

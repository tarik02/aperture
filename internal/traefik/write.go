package traefik

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/google/renameio/v2"
)

// WriteAtomic writes content to path using an atomic file replacement.
func WriteAtomic(path string, content []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("mkdir traefik config dir: %w", err)
	}

	if err := renameio.WriteFile(path, content, 0o600, renameio.WithStaticPermissions(0o600)); err != nil {
		return fmt.Errorf("write traefik config: %w", err)
	}
	return nil
}

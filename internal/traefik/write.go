package traefik

import (
	"fmt"
	"os"
	"path/filepath"
)

// WriteAtomic writes content to path using a temp file, fsync, and rename.
func WriteAtomic(path string, content []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("mkdir traefik config dir: %w", err)
	}

	tmp, err := os.CreateTemp(dir, ".dynamic-*")
	if err != nil {
		return fmt.Errorf("create temp traefik config: %w", err)
	}
	tmpPath := tmp.Name()
	cleanup := func() {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
	}

	if _, err := tmp.Write(content); err != nil {
		cleanup()
		return fmt.Errorf("write temp traefik config: %w", err)
	}
	if err := tmp.Chmod(0o600); err != nil {
		cleanup()
		return fmt.Errorf("chmod temp traefik config: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		cleanup()
		return fmt.Errorf("fsync temp traefik config: %w", err)
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return fmt.Errorf("close temp traefik config: %w", err)
	}
	if err := syncDir(dir); err != nil {
		cleanup()
		return fmt.Errorf("fsync traefik config dir: %w", err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		cleanup()
		return fmt.Errorf("rename traefik config: %w", err)
	}
	return nil
}

func syncDir(dir string) error {
	f, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}

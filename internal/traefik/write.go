package traefik

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/google/renameio/v2"
)

// WriteAtomic writes content to path using an atomic file replacement.
func WriteAtomic(path string, content []byte) error {
	return writeAtomicContext(context.Background(), path, content)
}

func writeAtomicContext(ctx context.Context, path string, content []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("mkdir traefik config dir: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	if err := renameio.WriteFile(path, content, 0o600, renameio.WithStaticPermissions(0o600)); err != nil {
		return fmt.Errorf("write traefik config: %w", err)
	}
	return nil
}

// WriteAtomicIfChanged atomically replaces path only when content differs.
func WriteAtomicIfChanged(path string, content []byte) (bool, error) {
	return WriteAtomicIfChangedContext(context.Background(), path, content)
}

// WriteAtomicIfChangedContext skips mutation when the operation is canceled.
func WriteAtomicIfChangedContext(ctx context.Context, path string, content []byte) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	existing, err := os.ReadFile(path)
	if err == nil {
		if bytes.Equal(existing, content) {
			return false, nil
		}
	} else if !os.IsNotExist(err) {
		return false, fmt.Errorf("read existing traefik config: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return false, err
	}

	if err := writeAtomicContext(ctx, path, content); err != nil {
		return false, err
	}
	return true, nil
}

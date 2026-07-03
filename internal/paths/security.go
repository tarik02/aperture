package paths

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

var (
	ErrPathOutsideRoot = errors.New("path outside configured root")
	ErrPathTraversal   = errors.New("path traversal rejected")
	ErrSymlinkPath     = errors.New("symlink path rejected")
)

// JoinUnderRoot joins path elements under root and rejects traversal outside root.
func JoinUnderRoot(root string, elems ...string) (string, error) {
	cleanRoot := filepath.Clean(root)
	if !filepath.IsAbs(cleanRoot) {
		return "", fmt.Errorf("root must be absolute")
	}

	joined := filepath.Join(append([]string{cleanRoot}, elems...)...)
	cleanJoined := filepath.Clean(joined)

	rel, err := filepath.Rel(cleanRoot, cleanJoined)
	if err != nil {
		return "", err
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", ErrPathTraversal
	}

	return cleanJoined, nil
}

// EnsureUnderRoot verifies target resolves under root after cleaning.
func EnsureUnderRoot(root, target string) error {
	cleanRoot := filepath.Clean(root)
	cleanTarget := filepath.Clean(target)

	rel, err := filepath.Rel(cleanRoot, cleanTarget)
	if err != nil {
		return err
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return ErrPathOutsideRoot
	}
	return nil
}

// RejectSymlink returns an error if path or any parent up to stopAt is a symlink.
func RejectSymlink(path string, stopAt string) error {
	cleanPath := filepath.Clean(path)
	cleanStop := filepath.Clean(stopAt)

	current := cleanPath
	for {
		info, err := os.Lstat(current)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				if current == cleanStop {
					return nil
				}
				parent := filepath.Dir(current)
				if parent == current {
					return nil
				}
				current = parent
				continue
			}
			return fmt.Errorf("lstat %s: %w", current, err)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("%w: %s", ErrSymlinkPath, current)
		}
		if current == cleanStop {
			return nil
		}
		parent := filepath.Dir(current)
		if parent == current {
			return nil
		}
		current = parent
	}
}

// ValidateTrustedPath ensures path is under root and contains no symlinks in the chain.
func ValidateTrustedPath(root, target string) error {
	if err := EnsureUnderRoot(root, target); err != nil {
		return err
	}
	return RejectSymlink(target, root)
}

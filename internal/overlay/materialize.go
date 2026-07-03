package overlay

import (
	"context"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

// MaterializeInput configures lower-plus-upper snapshot materialization.
type MaterializeInput struct {
	LowerDir string
	UpperDir string
	DestDir  string
}

// Materialize reconstructs an immutable profile tree from overlay lower and session upper.
func Materialize(ctx context.Context, input MaterializeInput) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if input.DestDir == "" {
		return fmt.Errorf("%w: destination directory is required", ErrMaterializeFailed)
	}

	if err := os.RemoveAll(input.DestDir); err != nil {
		return fmt.Errorf("%w: reset destination: %v", ErrMaterializeFailed, err)
	}
	if err := os.MkdirAll(input.DestDir, 0o755); err != nil {
		return fmt.Errorf("%w: mkdir destination: %v", ErrMaterializeFailed, err)
	}

	if err := materializeDir(ctx, input.LowerDir, input.UpperDir, input.DestDir, ""); err != nil {
		return err
	}
	return nil
}

func materializeDir(ctx context.Context, lowerDir, upperDir, destDir, rel string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if IsVolatileRelativePath(rel, 0) {
		return nil
	}

	lowerPath := joinRel(lowerDir, rel)
	upperPath := joinRel(upperDir, rel)
	destPath := joinRel(destDir, rel)

	if isOpaqueDirectory(upperPath) {
		if err := os.MkdirAll(destPath, 0o755); err != nil {
			return fmt.Errorf("%w: mkdir opaque destination %s: %v", ErrMaterializeFailed, rel, err)
		}
		return materializeUpperTree(ctx, upperDir, destDir, rel)
	}

	lowerEntries, err := readDirOptional(lowerPath)
	if err != nil {
		return fmt.Errorf("%w: read lower %s: %v", ErrMaterializeFailed, rel, err)
	}

	upperIndex, err := indexUpperEntries(upperPath)
	if err != nil {
		return fmt.Errorf("%w: read upper %s: %v", ErrMaterializeFailed, rel, err)
	}

	for _, entry := range lowerEntries {
		if err := ctx.Err(); err != nil {
			return err
		}

		name := entry.Name()
		childRel := joinRelPath(rel, name)
		if IsVolatileRelativePath(childRel, entry.Type()) {
			continue
		}
		if upperIndex.whiteouts[name] {
			continue
		}

		lowerChild := filepath.Join(lowerPath, name)
		destChild := filepath.Join(destPath, name)

		if upperEntry, changed := upperIndex.entries[name]; changed {
			if entry.IsDir() && upperEntry.IsDir() {
				if err := os.MkdirAll(destChild, 0o755); err != nil {
					return fmt.Errorf("%w: mkdir %s: %v", ErrMaterializeFailed, childRel, err)
				}
				if err := materializeDir(ctx, lowerDir, upperDir, destDir, childRel); err != nil {
					return err
				}
				continue
			}
			if err := cloneFromUpper(filepath.Join(upperPath, name), destChild, upperEntry); err != nil {
				return fmt.Errorf("%w: copy upper %s: %v", ErrMaterializeFailed, childRel, err)
			}
			continue
		}

		if entry.IsDir() {
			if err := os.MkdirAll(destChild, 0o755); err != nil {
				return fmt.Errorf("%w: mkdir %s: %v", ErrMaterializeFailed, childRel, err)
			}
			if err := materializeDir(ctx, lowerDir, upperDir, destDir, childRel); err != nil {
				return err
			}
			continue
		}

		if err := hardlinkFromLower(lowerChild, destChild, entry); err != nil {
			return fmt.Errorf("%w: hardlink %s: %v", ErrMaterializeFailed, childRel, err)
		}
	}

	for name, entry := range upperIndex.entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		if _, exists := findLowerEntry(lowerEntries, name); exists {
			continue
		}

		childRel := joinRelPath(rel, name)
		if IsVolatileRelativePath(childRel, entry.Type()) {
			continue
		}

		upperChild := filepath.Join(upperPath, name)
		destChild := filepath.Join(destPath, name)
		if entry.IsDir() {
			if err := os.MkdirAll(destChild, 0o755); err != nil {
				return fmt.Errorf("%w: mkdir %s: %v", ErrMaterializeFailed, childRel, err)
			}
			if err := materializeUpperTree(ctx, upperDir, destDir, childRel); err != nil {
				return err
			}
			continue
		}
		if err := cloneFromUpper(upperChild, destChild, entry); err != nil {
			return fmt.Errorf("%w: copy new upper %s: %v", ErrMaterializeFailed, childRel, err)
		}
	}

	return nil
}

func materializeUpperTree(ctx context.Context, upperDir, destDir, rel string) error {
	upperPath := joinRel(upperDir, rel)
	destPath := joinRel(destDir, rel)

	entries, err := readDirOptional(upperPath)
	if err != nil {
		return fmt.Errorf("%w: read upper-only %s: %v", ErrMaterializeFailed, rel, err)
	}

	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}

		name := entry.Name()
		upperChild := filepath.Join(upperPath, name)
		if isLegacyOpaqueWhiteoutName(name) || isLegacyWhiteoutName(name) {
			continue
		}
		if IsKernelOverlayWhiteout(upperChild, entry) {
			continue
		}

		childRel := joinRelPath(rel, name)
		if IsVolatileRelativePath(childRel, entry.Type()) {
			continue
		}

		destChild := filepath.Join(destPath, name)
		if entry.IsDir() {
			if isOpaqueDirectory(upperChild) {
				if err := os.MkdirAll(destChild, 0o755); err != nil {
					return fmt.Errorf("%w: mkdir opaque %s: %v", ErrMaterializeFailed, childRel, err)
				}
				if err := materializeUpperTree(ctx, upperDir, destDir, childRel); err != nil {
					return err
				}
				continue
			}
			if err := os.MkdirAll(destChild, 0o755); err != nil {
				return fmt.Errorf("%w: mkdir %s: %v", ErrMaterializeFailed, childRel, err)
			}
			if err := materializeUpperTree(ctx, upperDir, destDir, childRel); err != nil {
				return err
			}
			continue
		}

		if err := cloneFromUpper(upperChild, destChild, entry); err != nil {
			return fmt.Errorf("%w: copy upper-only %s: %v", ErrMaterializeFailed, childRel, err)
		}
	}

	return nil
}

type upperIndex struct {
	entries   map[string]fs.DirEntry
	whiteouts map[string]bool
}

func indexUpperEntries(upperPath string) (upperIndex, error) {
	entries, err := readDirOptional(upperPath)
	if err != nil {
		return upperIndex{}, err
	}

	index := upperIndex{
		entries:   make(map[string]fs.DirEntry),
		whiteouts: make(map[string]bool),
	}
	for _, entry := range entries {
		name := entry.Name()
		upperChild := filepath.Join(upperPath, name)
		if isLegacyOpaqueWhiteoutName(name) {
			continue
		}
		if IsLegacyAUFSWhiteout(name, entry) {
			if target, ok := whiteoutTarget(name); ok {
				index.whiteouts[target] = true
			}
			continue
		}
		if isLegacyWhiteoutName(name) {
			continue
		}
		if IsKernelOverlayWhiteout(upperChild, entry) {
			index.whiteouts[name] = true
			continue
		}
		index.entries[name] = entry
	}
	return index, nil
}

func hardlinkFromLower(lowerPath, destPath string, entry fs.DirEntry) error {
	if err := os.MkdirAll(filepath.Dir(destPath), 0o755); err != nil {
		return err
	}
	if err := os.Link(lowerPath, destPath); err == nil {
		return nil
	}
	return cloneFromUpper(lowerPath, destPath, entry)
}

func cloneFromUpper(srcPath, destPath string, entry fs.DirEntry) error {
	if err := os.MkdirAll(filepath.Dir(destPath), 0o755); err != nil {
		return err
	}

	mode := fs.FileMode(0o644)
	if entry != nil {
		if info, err := entry.Info(); err == nil {
			mode = info.Mode() & os.ModePerm
		}
	} else if info, err := os.Lstat(srcPath); err == nil {
		mode = info.Mode() & os.ModePerm
	}

	if err := tryReflinkCopy(srcPath, destPath, mode); err == nil {
		return nil
	}

	return copyFile(srcPath, destPath, mode)
}

func tryReflinkCopy(srcPath, destPath string, mode fs.FileMode) error {
	in, err := os.Open(srcPath)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.OpenFile(destPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	defer func() {
		_ = out.Close()
	}()

	if err := unix.IoctlFileClone(int(out.Fd()), int(in.Fd())); err != nil {
		_ = os.Remove(destPath)
		return err
	}
	return out.Close()
}

func copyFile(srcPath, destPath string, mode fs.FileMode) error {
	in, err := os.Open(srcPath)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.OpenFile(destPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}

	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		_ = os.Remove(destPath)
		return err
	}
	return out.Close()
}

func readDirOptional(path string) ([]fs.DirEntry, error) {
	entries, err := os.ReadDir(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	return entries, nil
}

func findLowerEntry(entries []fs.DirEntry, name string) (fs.DirEntry, bool) {
	for _, entry := range entries {
		if entry.Name() == name {
			return entry, true
		}
	}
	return nil, false
}

func joinRel(base, rel string) string {
	if rel == "" {
		return base
	}
	return filepath.Join(base, rel)
}

func joinRelPath(rel, name string) string {
	if rel == "" {
		return name
	}
	return filepath.Join(rel, name)
}

func dirEntryFromInfo(name string, info os.FileInfo) fs.DirEntry {
	return &staticDirEntry{name: name, info: info}
}

type staticDirEntry struct {
	name string
	info os.FileInfo
}

func (e *staticDirEntry) Name() string               { return e.name }
func (e *staticDirEntry) IsDir() bool                { return e.info.IsDir() }
func (e *staticDirEntry) Type() fs.FileMode          { return e.info.Mode().Type() }
func (e *staticDirEntry) Info() (os.FileInfo, error) { return e.info, nil }

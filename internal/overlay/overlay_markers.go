package overlay

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

const (
	xattrTrustedWhiteout = "trusted.overlay.whiteout"
	xattrUserWhiteout    = "user.overlay.whiteout"
	xattrTrustedOpaque   = "trusted.overlay.opaque"
	xattrUserOpaque      = "user.overlay.opaque"
)

// IsKernelOverlayWhiteout reports whether path is a kernel overlayfs whiteout in upperdir.
func IsKernelOverlayWhiteout(path string, entry fs.DirEntry) bool {
	info, err := entryInfo(entry, path)
	if err != nil {
		return false
	}

	if isCharDeviceWhiteout(info) {
		return true
	}

	if info.Mode().IsRegular() && info.Size() == 0 && hasOverlayWhiteoutXattr(path) {
		return true
	}

	return false
}

func hasOverlayWhiteoutXattr(path string) bool {
	for _, attr := range []string{xattrUserWhiteout, xattrTrustedWhiteout} {
		if xattrExists(path, attr) {
			return true
		}
	}
	return false
}

// IsKernelOverlayOpaqueDir reports whether path is a kernel overlayfs opaque directory.
func IsKernelOverlayOpaqueDir(path string) bool {
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() {
		return false
	}

	for _, attr := range []string{xattrUserOpaque, xattrTrustedOpaque} {
		if value, ok := getXattr(path, attr); ok && value == "y" {
			return true
		}
	}

	return false
}

// IsLegacyAUFSWhiteout reports AUFS/OCI-style .wh.* whiteout marker files.
func IsLegacyAUFSWhiteout(name string, entry fs.DirEntry) bool {
	target, ok := whiteoutTarget(name)
	if !ok {
		return false
	}
	if target == "" {
		return false
	}
	return isCharDeviceEntry(entry)
}

func isOpaqueDirectory(upperPath string) bool {
	if IsKernelOverlayOpaqueDir(upperPath) {
		return true
	}

	info, err := os.Lstat(filepath.Join(upperPath, ".wh..wh..opq"))
	if err != nil {
		return false
	}
	return isCharDeviceInfo(info)
}

func isCharDeviceWhiteout(info os.FileInfo) bool {
	if info.Mode()&os.ModeCharDevice == 0 {
		return false
	}
	if stat, ok := info.Sys().(*unix.Stat_t); ok {
		return unix.Major(stat.Rdev) == 0 && unix.Minor(stat.Rdev) == 0
	}
	return true
}

func isCharDeviceEntry(entry fs.DirEntry) bool {
	if entry.Type()&os.ModeCharDevice != 0 {
		return true
	}
	info, err := entry.Info()
	if err != nil {
		return false
	}
	return info.Mode()&os.ModeCharDevice != 0
}

func isCharDeviceInfo(info os.FileInfo) bool {
	return info.Mode()&os.ModeCharDevice != 0
}

func entryInfo(entry fs.DirEntry, path string) (os.FileInfo, error) {
	if entry != nil {
		if info, err := entry.Info(); err == nil {
			return info, nil
		}
	}
	return os.Lstat(path)
}

func xattrExists(path, attr string) bool {
	_, err := unix.Lgetxattr(path, attr, nil)
	return err == nil
}

func getXattr(path, attr string) (string, bool) {
	size, err := unix.Lgetxattr(path, attr, nil)
	if err != nil {
		return "", false
	}
	if size == 0 {
		return "", false
	}

	buf := make([]byte, size)
	n, err := unix.Lgetxattr(path, attr, buf)
	if err != nil || n <= 0 {
		return "", false
	}

	return strings.TrimRight(string(buf[:n]), "\x00"), true
}

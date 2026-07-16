package sudo

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

var ErrOverlayMount = errors.New("overlay mount failed")
var ErrOverlayUnmount = errors.New("overlay unmount failed")

// MountOverlayFS mounts an overlayfs at merged using trusted lower, upper, and work paths.
func MountOverlayFS(lower, upper, work, merged string) error {
	if err := validateOverlayPaths(lower, upper, work, merged); err != nil {
		return err
	}

	mounted, err := isMountPoint(merged)
	if err != nil {
		return fmt.Errorf("%w: inspect mount point: %v", ErrOverlayMount, err)
	}
	if mounted {
		return nil
	}

	if err := os.MkdirAll(merged, 0o755); err != nil {
		return fmt.Errorf("%w: mkdir merged: %v", ErrOverlayMount, err)
	}

	options := overlayMountOptions(lower, upper, work)
	if err := unix.Mount("overlay", merged, "overlay", 0, options); err != nil {
		return fmt.Errorf("%w: %v", ErrOverlayMount, err)
	}
	return nil
}

// overlayMountOptions builds overlayfs mount data for non-root upperdir xattr access.
func overlayMountOptions(lower, upper, work string) string {
	return fmt.Sprintf("lowerdir=%s,upperdir=%s,workdir=%s,userxattr", lower, upper, work)
}

// UnmountOverlayFS unmounts the overlay at merged when it is a mount point.
func UnmountOverlayFS(merged string) error {
	if merged == "" {
		return fmt.Errorf("%w: merged path is required", ErrOverlayUnmount)
	}

	mounted, err := isMountPoint(merged)
	if err != nil {
		return fmt.Errorf("%w: inspect mount point: %v", ErrOverlayUnmount, err)
	}
	if !mounted {
		return nil
	}

	if err := unix.Unmount(merged, unix.MNT_DETACH); err != nil {
		return fmt.Errorf("%w: %v", ErrOverlayUnmount, err)
	}
	return nil
}

func validateOverlayPaths(lower, upper, work, merged string) error {
	for name, path := range map[string]string{
		"lower":  lower,
		"upper":  upper,
		"work":   work,
		"merged": merged,
	} {
		if path == "" {
			return fmt.Errorf("%w: %s path is required", ErrOverlayMount, name)
		}
		if !filepath.IsAbs(path) {
			return fmt.Errorf("%w: %s path must be absolute", ErrOverlayMount, name)
		}
	}
	return nil
}

// IsMountPoint reports whether path is a mount point.
func IsMountPoint(path string) (bool, error) {
	return isMountPoint(path)
}

func isMountPoint(path string) (bool, error) {
	var stat unix.Stat_t
	if err := unix.Stat(path, &stat); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, err
	}

	var parentStat unix.Stat_t
	parent := filepath.Dir(path)
	if err := unix.Stat(parent, &parentStat); err != nil {
		return false, err
	}

	return stat.Dev != parentStat.Dev, nil
}

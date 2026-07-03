//go:build linux

package overlay

import (
	"github.com/aperture/aperture/internal/sudo"
)

// IsMergedMounted reports whether merged is a mount point (overlay mounted or absent).
func IsMergedMounted(mergedPath string) (bool, error) {
	return sudo.IsMountPoint(mergedPath)
}

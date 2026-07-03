//go:build !linux

package overlay

import "errors"

// IsMergedMounted is only supported on Linux hosts with overlay mounts.
func IsMergedMounted(string) (bool, error) {
	return false, errors.New("overlay mount inspection is only supported on linux")
}

package overlay

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

const whiteoutPrefix = ".wh."

var volatileDirNames = map[string]struct{}{
	"GPUCache":       {},
	"GrShaderCache":  {},
	"ShaderCache":    {},
	"BrowserMetrics": {},
	"Crashpad":       {},
	"Code Cache":     {},
	"Cache":          {},
	"downloads":      {},
	"cache":          {},
}

var volatileBaseNames = map[string]struct{}{
	"SingletonLock":        {},
	"SingletonSocket":      {},
	"SingletonCookie":      {},
	"lockfile":             {},
	"LOCK":                 {},
	"LOG":                  {},
	"LOG.old":              {},
	"RunningChromeVersion": {},
}

// IsVolatileRelativePath reports whether rel should be excluded from snapshot materialization.
func IsVolatileRelativePath(rel string, mode fs.FileMode) bool {
	if mode&os.ModeSocket != 0 {
		return true
	}

	clean := filepath.ToSlash(filepath.Clean(rel))
	if clean == "." || clean == "" {
		return false
	}

	base := filepath.Base(clean)
	if strings.HasSuffix(strings.ToLower(base), ".lock") {
		return true
	}
	if _, ok := volatileBaseNames[base]; ok {
		return true
	}

	parts := strings.Split(clean, "/")
	for _, part := range parts {
		if _, ok := volatileDirNames[part]; ok {
			return true
		}
		if strings.HasPrefix(part, "crashpad_") {
			return true
		}
		if strings.HasSuffix(part, ".env") {
			return true
		}
		if strings.Contains(part, "traefik") {
			return true
		}
	}

	return false
}

func isLegacyWhiteoutName(name string) bool {
	return strings.HasPrefix(name, whiteoutPrefix)
}

func whiteoutTarget(name string) (string, bool) {
	if !isLegacyWhiteoutName(name) {
		return "", false
	}
	target := strings.TrimPrefix(name, whiteoutPrefix)
	if target == "" {
		return "", false
	}
	return target, true
}

func isLegacyOpaqueWhiteoutName(name string) bool {
	return name == ".wh..wh..opq"
}

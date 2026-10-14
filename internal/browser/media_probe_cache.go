package browser

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/tarik02/webdesktop/media"
)

const mediaProbeTTL = 30 * time.Second

type mediaProbeCache struct {
	mu      sync.Mutex
	entries map[[32]byte]mediaProbeResult
}

type mediaProbeResult struct {
	profile media.EncoderProfile
	expires time.Time
}

func newMediaProbeCache() *mediaProbeCache {
	return &mediaProbeCache{entries: make(map[[32]byte]mediaProbeResult)}
}

func mediaProbeIdentity(executable string, values RuntimeEnvValues, request []byte, env []string) [32]byte {
	hash := sha256.New()
	_, _ = hash.Write(request)
	for _, value := range env {
		key, _, _ := strings.Cut(value, "=")
		switch key {
		case "LD_LIBRARY_PATH", "LD_PRELOAD",
			"LIBVA_DRIVER_NAME", "LIBVA_DRIVERS_PATH",
			"CUDA_VISIBLE_DEVICES", "NVIDIA_VISIBLE_DEVICES", "NVIDIA_DRIVER_CAPABILITIES",
			"GST_PLUGIN_PATH", "GST_PLUGIN_PATH_1_0", "GST_PLUGIN_SYSTEM_PATH", "GST_PLUGIN_SYSTEM_PATH_1_0",
			"GST_PLUGIN_SCANNER", "GST_PLUGIN_SCANNER_1_0", "GST_REGISTRY_1_0":
			_, _ = fmt.Fprintf(hash, "%q;", value)
		}
	}
	for _, path := range mediaProbeIdentityPaths(executable, values) {
		info, err := os.Stat(path)
		if err != nil {
			_, _ = fmt.Fprintf(hash, "%q:%v;", path, err)
			continue
		}
		_, _ = fmt.Fprintf(hash, "%q:%d:%d:%v;", path, info.Size(), info.ModTime().UnixNano(), info.Mode())
		if stat, ok := info.Sys().(*syscall.Stat_t); ok {
			_, _ = fmt.Fprintf(hash, "%d:%d:%d;", stat.Dev, stat.Ino, stat.Rdev)
		}
	}
	return [32]byte(hash.Sum(nil))
}

func mediaProbeIdentityPaths(executable string, values RuntimeEnvValues) []string {
	paths := []string{executable, values.MediaProducerGSTExecutable, values.RenderNode, "/sys/module/nvidia/version"}
	for _, pattern := range []string{"/dev/dri/renderD*", "/dev/nvidia*"} {
		devices, _ := filepath.Glob(pattern)
		paths = append(paths, devices...)
	}
	for _, directory := range filepath.SplitList(values.MediaProducerPluginPath) {
		paths = append(paths, directory)
		plugins, _ := filepath.Glob(filepath.Join(directory, "*.so"))
		paths = append(paths, plugins...)
	}
	return paths
}

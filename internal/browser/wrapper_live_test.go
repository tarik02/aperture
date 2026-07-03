package browser

import (
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestLiveBrowserLaunchThroughBwrap(t *testing.T) {
	if os.Getenv("APERTURE_LIVE_DESKTOP") != "1" {
		t.Skip("set APERTURE_LIVE_DESKTOP=1 to run live desktop smoke test")
	}

	chromiumPath, err := exec.LookPath("chromium")
	if err != nil {
		chromiumPath, err = exec.LookPath("chromium-browser")
		if err != nil {
			t.Skip("chromium executable not found in PATH")
		}
	}
	if _, err := exec.LookPath("bwrap"); err != nil {
		t.Skip("bwrap executable not found in PATH")
	}

	root := t.TempDir()
	merged := filepath.Join(root, "merged")
	downloads := filepath.Join(root, "downloads")
	cache := filepath.Join(root, "cache")
	artifacts := filepath.Join(root, "artifacts")
	for _, dir := range []string{merged, downloads, cache, artifacts} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", dir, err)
		}
	}
	if err := WriteDownloadPreferences(merged, downloads); err != nil {
		t.Fatalf("WriteDownloadPreferences() error = %v", err)
	}

	port, err := allocateTestPort()
	if err != nil {
		t.Fatalf("allocate port: %v", err)
	}

	bwrapPath, err := exec.LookPath("bwrap")
	if err != nil {
		t.Fatalf("locate bwrap: %v", err)
	}

	cmd, err := BuildBwrapCommand(LaunchConfig{
		BwrapPath:         bwrapPath,
		BrowserExecutable: chromiumPath,
		MergedUserDataDir: merged,
		DownloadsDir:      downloads,
		CacheDir:          cache,
		ArtifactsDir:      artifacts,
		CDPPort:           port,
		DefaultArgs:       []string{"--headless=new"},
		ExtraArgs:         []string{"--disable-gpu"},
	})
	if err != nil {
		t.Fatalf("BuildBwrapCommand() error = %v", err)
	}

	if err := cmd.Start(); err != nil {
		t.Fatalf("start chromium through bwrap: %v", err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
	})

	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if cmd.ProcessState != nil && cmd.ProcessState.Exited() {
			t.Fatalf("chromium exited before CDP endpoint became ready")
		}
		time.Sleep(250 * time.Millisecond)
	}
}

func allocateTestPort() (int, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port, nil
}

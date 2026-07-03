package sudo

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aperture/aperture/internal/config"
)

func TestOverlayMountOptionsIncludeUserxattr(t *testing.T) {
	t.Parallel()

	opts := overlayMountOptions("/lower", "/upper", "/work")
	if !strings.Contains(opts, "userxattr") {
		t.Fatalf("overlay mount options = %q, want userxattr", opts)
	}
	if strings.Count(opts, "userxattr") != 1 {
		t.Fatalf("overlay mount options = %q, want userxattr exactly once", opts)
	}
}

func TestMountOverlayFSRoundTrip(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("overlay mount integration requires root privileges for mount syscall")
	}

	root := t.TempDir()
	lower := filepath.Join(root, "lower")
	upper := filepath.Join(root, "upper")
	work := filepath.Join(root, "work")
	merged := filepath.Join(root, "merged")

	for _, dir := range []string{lower, upper, work, merged} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", dir, err)
		}
	}

	if err := os.WriteFile(filepath.Join(lower, "seed.txt"), []byte("seed"), 0o644); err != nil {
		t.Fatalf("write seed: %v", err)
	}

	if err := MountOverlayFS(lower, upper, work, merged); err != nil {
		t.Fatalf("MountOverlayFS() error = %v", err)
	}
	t.Cleanup(func() { _ = UnmountOverlayFS(merged) })

	if _, err := os.Stat(filepath.Join(merged, "seed.txt")); err != nil {
		t.Fatalf("seed file missing in merged overlay: %v", err)
	}

	if err := UnmountOverlayFS(merged); err != nil {
		t.Fatalf("UnmountOverlayFS() error = %v", err)
	}
}

func TestMountSessionMountsOverlayWhenPrivileged(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("overlay mount integration requires root privileges for mount syscall")
	}

	root := t.TempDir()
	cfg := config.Config{
		StoreRoot:    filepath.Join(root, "store"),
		RuntimeRoot:  filepath.Join(root, "runtime"),
		ArtifactRoot: filepath.Join(root, "artifacts"),
	}
	sessionID := "018f1234-0000-7000-8000-000000000020"

	if err := MountSession(context.Background(), cfg, MountRequest{SessionID: sessionID, Empty: true}); err != nil {
		t.Fatalf("MountSession() error = %v", err)
	}

	merged := filepath.Join(cfg.StoreRoot, "sessions", "01", "8f", sessionID, "merged")
	t.Cleanup(func() { _ = UnmountSession(context.Background(), cfg, sessionID) })

	mounted, err := isMountPoint(merged)
	if err != nil {
		t.Fatalf("isMountPoint() error = %v", err)
	}
	if !mounted {
		t.Fatalf("expected merged dir to be a mount point")
	}

	if err := UnmountSession(context.Background(), cfg, sessionID); err != nil {
		t.Fatalf("UnmountSession() error = %v", err)
	}
}

func TestMountSessionCreatesPathsWithoutMountWhenUnprivileged(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("unprivileged path construction test skips when running as root")
	}

	root := t.TempDir()
	cfg := config.Config{
		StoreRoot:    filepath.Join(root, "store"),
		RuntimeRoot:  filepath.Join(root, "runtime"),
		ArtifactRoot: filepath.Join(root, "artifacts"),
	}
	sessionID := "018f1234-0000-7000-8000-000000000021"

	err := MountSession(context.Background(), cfg, MountRequest{SessionID: sessionID, Empty: true})

	upper := filepath.Join(cfg.StoreRoot, "sessions", "01", "8f", sessionID, "upper")
	if _, statErr := os.Stat(upper); statErr != nil {
		t.Fatalf("expected upper dir to be created: %v", statErr)
	}

	merged := filepath.Join(cfg.StoreRoot, "sessions", "01", "8f", sessionID, "merged")
	if err != nil {
		t.Logf("mount failed as expected without privileges: %v", err)
		return
	}

	mounted, mountErr := isMountPoint(merged)
	if mountErr != nil {
		t.Fatalf("isMountPoint() error = %v", mountErr)
	}
	if mounted {
		t.Skip("environment allows unprivileged overlay mount; skipping failure expectation")
	}
}

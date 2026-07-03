//go:build linux

package overlay

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/paths"
	"github.com/aperture/aperture/internal/sudo"
	"golang.org/x/sys/unix"
)

func testOverlayConfig(t *testing.T, root string) config.Config {
	t.Helper()
	return config.Config{
		StoreRoot:    filepath.Join(root, "store"),
		RuntimeRoot:  filepath.Join(root, "runtime"),
		ArtifactRoot: filepath.Join(root, "artifacts"),
	}
}

func requireOverlayIntegration(t *testing.T) {
	t.Helper()
	if os.Geteuid() != 0 && os.Getenv("APERTURE_RUN_OVERLAY_TESTS") == "" {
		t.Skip("overlay integration requires root or APERTURE_RUN_OVERLAY_TESTS=1")
	}
}

func TestMaterializeOverlayFilesystemIntegration(t *testing.T) {
	requireOverlayIntegration(t)

	root, err := filepath.Abs(t.TempDir())
	if err != nil {
		t.Fatalf("abs temp dir: %v", err)
	}
	cfg := testOverlayConfig(t, root)
	emptyLower, err := paths.EmptyLowerDir(cfg)
	if err != nil {
		t.Fatalf("empty lower: %v", err)
	}
	if err := os.MkdirAll(emptyLower, 0o755); err != nil {
		t.Fatalf("mkdir empty lower: %v", err)
	}

	sessionID := "018f1234-5678-79ab-8cde-f123456789ab"
	layout, err := paths.Session(cfg, sessionID)
	if err != nil {
		t.Fatalf("session layout: %v", err)
	}
	if err := sudo.MountSession(context.Background(), cfg, sudo.MountRequest{
		SessionID: sessionID,
		Empty:     true,
	}); err != nil {
		t.Fatalf("mount session: %v", err)
	}
	t.Cleanup(func() { _ = sudo.UnmountSession(context.Background(), cfg, sessionID) })

	prefs := filepath.Join(layout.Merged, "Default", "Preferences")
	if err := os.MkdirAll(filepath.Dir(prefs), 0o755); err != nil {
		t.Fatalf("mkdir profile: %v", err)
	}
	if err := os.WriteFile(prefs, []byte(`{"profile":{"name":"integration"}}`), 0o644); err != nil {
		t.Fatalf("write prefs: %v", err)
	}
	if err := os.WriteFile(filepath.Join(layout.Upper, "Default", "state.txt"), []byte("upper-only"), 0o644); err != nil {
		t.Fatalf("write upper: %v", err)
	}

	dest := filepath.Join(root, "snapshot-profile")
	if err := Materialize(context.Background(), MaterializeInput{
		LowerDir: emptyLower,
		UpperDir: layout.Upper,
		DestDir:  dest,
	}); err != nil {
		t.Fatalf("materialize: %v", err)
	}

	materializedPrefs, err := os.ReadFile(filepath.Join(dest, "Default", "Preferences"))
	if err != nil {
		t.Fatalf("read materialized prefs: %v", err)
	}
	if string(materializedPrefs) == "" {
		t.Fatal("preferences not materialized")
	}
	upperOnly, err := os.ReadFile(filepath.Join(dest, "Default", "state.txt"))
	if err != nil {
		t.Fatalf("read upper-only file: %v", err)
	}
	if string(upperOnly) != "upper-only" {
		t.Fatalf("upper-only = %q", string(upperOnly))
	}
}

func TestMaterializeKernelOverlayDeleteWhiteout(t *testing.T) {
	requireOverlayIntegration(t)

	root, err := filepath.Abs(t.TempDir())
	if err != nil {
		t.Fatalf("abs temp dir: %v", err)
	}
	cfg := testOverlayConfig(t, root)
	lowerDir := filepath.Join(root, "lower")
	if err := os.MkdirAll(lowerDir, 0o755); err != nil {
		t.Fatalf("mkdir lower: %v", err)
	}
	if err := os.WriteFile(filepath.Join(lowerDir, "removed.txt"), []byte("gone"), 0o644); err != nil {
		t.Fatalf("write lower file: %v", err)
	}

	sessionID := "018f1234-5678-79ab-8cde-f123456789ac"
	layout, err := paths.Session(cfg, sessionID)
	if err != nil {
		t.Fatalf("session layout: %v", err)
	}
	if err := os.MkdirAll(layout.Upper, 0o755); err != nil {
		t.Fatalf("mkdir upper: %v", err)
	}
	if err := os.MkdirAll(layout.Work, 0o755); err != nil {
		t.Fatalf("mkdir work: %v", err)
	}
	mountOverlayOrSkip(t, lowerDir, layout.Upper, layout.Work, layout.Merged)
	t.Cleanup(func() { _ = sudo.UnmountOverlayFS(layout.Merged) })

	mergedFile := filepath.Join(layout.Merged, "removed.txt")
	if err := os.Remove(mergedFile); err != nil {
		t.Fatalf("unlink merged file: %v", err)
	}

	upperMarker := filepath.Join(layout.Upper, "removed.txt")
	info, err := os.Lstat(upperMarker)
	if err != nil {
		t.Fatalf("upper whiteout missing after unlink: %v", err)
	}
	if !IsKernelOverlayWhiteout(upperMarker, dirEntryFromInfo("removed.txt", info)) {
		t.Fatalf("upper marker is not a kernel overlay whiteout: mode=%v", info.Mode())
	}

	dest := filepath.Join(root, "dest")
	if err := Materialize(context.Background(), MaterializeInput{
		LowerDir: lowerDir,
		UpperDir: layout.Upper,
		DestDir:  dest,
	}); err != nil {
		t.Fatalf("materialize: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dest, "removed.txt")); !os.IsNotExist(err) {
		t.Fatalf("deleted lower file leaked into snapshot: %v", err)
	}
}

func TestMaterializeKernelOverlayOpaqueDirectory(t *testing.T) {
	requireOverlayIntegration(t)

	root, err := filepath.Abs(t.TempDir())
	if err != nil {
		t.Fatalf("abs temp dir: %v", err)
	}
	cfg := testOverlayConfig(t, root)
	lowerDir := filepath.Join(root, "lower", "Default", "Extensions")
	if err := os.MkdirAll(lowerDir, 0o755); err != nil {
		t.Fatalf("mkdir lower: %v", err)
	}
	if err := os.WriteFile(filepath.Join(lowerDir, "old.txt"), []byte("old"), 0o644); err != nil {
		t.Fatalf("write lower file: %v", err)
	}

	sessionID := "018f1234-5678-79ab-8cde-f123456789ad"
	layout, err := paths.Session(cfg, sessionID)
	if err != nil {
		t.Fatalf("session layout: %v", err)
	}
	if err := os.MkdirAll(layout.Upper, 0o755); err != nil {
		t.Fatalf("mkdir upper: %v", err)
	}
	if err := os.MkdirAll(layout.Work, 0o755); err != nil {
		t.Fatalf("mkdir work: %v", err)
	}
	mountOverlayOrSkip(t, filepath.Join(root, "lower"), layout.Upper, layout.Work, layout.Merged)
	t.Cleanup(func() { _ = sudo.UnmountOverlayFS(layout.Merged) })

	upperExt := filepath.Join(layout.Upper, "Default", "Extensions")
	if err := os.MkdirAll(upperExt, 0o755); err != nil {
		t.Fatalf("mkdir upper opaque dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(upperExt, "fresh.txt"), []byte("fresh"), 0o644); err != nil {
		t.Fatalf("write upper file: %v", err)
	}
	if err := unix.Lsetxattr(upperExt, xattrUserOpaque, []byte("y"), 0); err != nil {
		if err := unix.Lsetxattr(upperExt, xattrTrustedOpaque, []byte("y"), 0); err != nil {
			t.Skipf("cannot set kernel opaque xattr on overlay upperdir %s: %v", upperExt, err)
		}
	}
	if !IsKernelOverlayOpaqueDir(upperExt) {
		t.Fatalf("upperdir Extensions is not opaque after setting xattr")
	}

	dest := filepath.Join(root, "dest")
	if err := Materialize(context.Background(), MaterializeInput{
		LowerDir: filepath.Join(root, "lower"),
		UpperDir: layout.Upper,
		DestDir:  dest,
	}); err != nil {
		t.Fatalf("materialize: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dest, "Default", "Extensions", "old.txt")); !os.IsNotExist(err) {
		t.Fatalf("lower file leaked through kernel opaque dir: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(dest, "Default", "Extensions", "fresh.txt"))
	if err != nil {
		t.Fatalf("read fresh: %v", err)
	}
	if string(data) != "fresh" {
		t.Fatalf("fresh = %q", string(data))
	}
}

func mountOverlayOrSkip(t *testing.T, lower, upper, work, merged string) {
	t.Helper()
	if err := sudo.MountOverlayFS(lower, upper, work, merged); err != nil {
		if isOverlayMountDenied(err) {
			t.Skipf("kernel overlay mount unavailable (need root or user-ns overlay support): %v", err)
		}
		t.Fatalf("mount overlay: %v", err)
	}
}

func isOverlayMountDenied(err error) bool {
	if errors.Is(err, unix.EPERM) {
		return true
	}
	return strings.Contains(err.Error(), "operation not permitted")
}

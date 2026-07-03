package overlay

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

func TestIsKernelOverlayWhiteoutCharDevice(t *testing.T) {
	t.Parallel()

	root, err := filepath.Abs(t.TempDir())
	if err != nil {
		t.Fatalf("abs temp dir: %v", err)
	}
	path := filepath.Join(root, "deleted.txt")
	if err := mkCharDeviceWhiteout(path); err != nil {
		t.Fatalf("mknod whiteout: %v", err)
	}

	entry, err := os.Lstat(path)
	if err != nil {
		t.Fatalf("lstat: %v", err)
	}
	dirEntry := dirEntryFromInfo("deleted.txt", entry)
	if !IsKernelOverlayWhiteout(path, dirEntry) {
		t.Fatal("expected kernel char-device whiteout")
	}
}

func TestIsKernelOverlayWhiteoutTrustedXattr(t *testing.T) {
	t.Parallel()

	root, err := filepath.Abs(t.TempDir())
	if err != nil {
		t.Fatalf("abs temp dir: %v", err)
	}
	path := filepath.Join(root, "deleted.txt")
	if err := os.WriteFile(path, nil, 0o644); err != nil {
		t.Fatalf("write empty file: %v", err)
	}
	if err := unix.Lsetxattr(path, xattrTrustedWhiteout, []byte("y"), 0); err != nil {
		t.Skipf("cannot set %s (need overlay upperdir or CAP_SYS_ADMIN): %v", xattrTrustedWhiteout, err)
	}
	if !IsKernelOverlayWhiteout(path, nil) {
		t.Fatal("expected trusted xattr whiteout")
	}
}

func TestIsKernelOverlayWhiteoutUserXattr(t *testing.T) {
	t.Parallel()

	root, err := filepath.Abs(t.TempDir())
	if err != nil {
		t.Fatalf("abs temp dir: %v", err)
	}
	path := filepath.Join(root, "deleted.txt")
	if err := os.WriteFile(path, nil, 0o644); err != nil {
		t.Fatalf("write empty file: %v", err)
	}
	if err := unix.Lsetxattr(path, xattrUserWhiteout, []byte("y"), 0); err != nil {
		t.Skipf("cannot set %s: %v", xattrUserWhiteout, err)
	}
	if !IsKernelOverlayWhiteout(path, nil) {
		t.Fatal("expected user xattr whiteout")
	}
}

func TestIsKernelOverlayWhiteoutUserXattrZeroSize(t *testing.T) {
	t.Parallel()

	root, err := filepath.Abs(t.TempDir())
	if err != nil {
		t.Fatalf("abs temp dir: %v", err)
	}
	path := filepath.Join(root, "deleted.txt")
	if err := os.WriteFile(path, nil, 0o644); err != nil {
		t.Fatalf("write empty file: %v", err)
	}
	if err := unix.Lsetxattr(path, xattrUserWhiteout, []byte{}, 0); err != nil {
		t.Skipf("cannot set zero-size %s: %v", xattrUserWhiteout, err)
	}
	if !xattrExists(path, xattrUserWhiteout) {
		t.Fatal("expected zero-size user whiteout xattr to exist")
	}
	if !IsKernelOverlayWhiteout(path, nil) {
		t.Fatal("expected zero-size user xattr whiteout")
	}
}

func TestIsLegacyAUFSWhiteout(t *testing.T) {
	t.Parallel()

	root, err := filepath.Abs(t.TempDir())
	if err != nil {
		t.Fatalf("abs temp dir: %v", err)
	}
	path := filepath.Join(root, ".wh.deleted.txt")
	if err := mkCharDeviceWhiteout(path); err != nil {
		t.Fatalf("mknod legacy whiteout: %v", err)
	}
	entry, err := os.Lstat(path)
	if err != nil {
		t.Fatalf("lstat: %v", err)
	}
	dirEntry := dirEntryFromInfo(".wh.deleted.txt", entry)
	if !IsLegacyAUFSWhiteout(".wh.deleted.txt", dirEntry) {
		t.Fatal("expected legacy AUFS whiteout")
	}
}

func TestIsKernelOverlayOpaqueDir(t *testing.T) {
	t.Parallel()

	root, err := filepath.Abs(t.TempDir())
	if err != nil {
		t.Fatalf("abs temp dir: %v", err)
	}
	path := filepath.Join(root, "Extensions")
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	setOpaqueXattr(t, path)
	if !IsKernelOverlayOpaqueDir(path) {
		t.Fatal("expected opaque directory")
	}
	if !isOpaqueDirectory(path) {
		t.Fatal("expected isOpaqueDirectory wrapper to detect kernel opaque dir")
	}
}

func TestIsKernelOverlayOpaqueDirUserXattr(t *testing.T) {
	t.Parallel()

	root, err := filepath.Abs(t.TempDir())
	if err != nil {
		t.Fatalf("abs temp dir: %v", err)
	}
	path := filepath.Join(root, "Extensions")
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := unix.Lsetxattr(path, xattrUserOpaque, []byte("y"), 0); err != nil {
		t.Skipf("cannot set %s: %v", xattrUserOpaque, err)
	}
	if !IsKernelOverlayOpaqueDir(path) {
		t.Fatal("expected user.overlay.opaque directory")
	}
}

func TestMaterializeHonorsKernelSameNameWhiteout(t *testing.T) {
	t.Parallel()

	root, err := filepath.Abs(t.TempDir())
	if err != nil {
		t.Fatalf("abs temp dir: %v", err)
	}
	lower := filepath.Join(root, "lower", "Default")
	upper := filepath.Join(root, "upper", "Default")
	dest := filepath.Join(root, "dest")

	if err := os.MkdirAll(lower, 0o755); err != nil {
		t.Fatalf("mkdir lower: %v", err)
	}
	if err := os.MkdirAll(upper, 0o755); err != nil {
		t.Fatalf("mkdir upper: %v", err)
	}
	if err := os.WriteFile(filepath.Join(lower, "deleted.txt"), []byte("gone"), 0o644); err != nil {
		t.Fatalf("write lower deleted: %v", err)
	}
	if err := mkCharDeviceWhiteout(filepath.Join(upper, "deleted.txt")); err != nil {
		t.Fatalf("kernel whiteout: %v", err)
	}

	if err := Materialize(t.Context(), MaterializeInput{
		LowerDir: filepath.Join(root, "lower"),
		UpperDir: filepath.Join(root, "upper"),
		DestDir:  dest,
	}); err != nil {
		t.Fatalf("materialize: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dest, "Default", "deleted.txt")); !os.IsNotExist(err) {
		t.Fatalf("deleted file present after kernel whiteout: %v", err)
	}
}

func TestMaterializeHonorsKernelOpaqueXattr(t *testing.T) {
	t.Parallel()

	root, err := filepath.Abs(t.TempDir())
	if err != nil {
		t.Fatalf("abs temp dir: %v", err)
	}
	lower := filepath.Join(root, "lower")
	upper := filepath.Join(root, "upper")
	dest := filepath.Join(root, "dest")

	if err := os.MkdirAll(filepath.Join(lower, "Default", "Extensions"), 0o755); err != nil {
		t.Fatalf("mkdir lower: %v", err)
	}
	if err := os.WriteFile(filepath.Join(lower, "Default", "Extensions", "old.txt"), []byte("old"), 0o644); err != nil {
		t.Fatalf("write lower file: %v", err)
	}
	upperExt := filepath.Join(upper, "Default", "Extensions")
	if err := os.MkdirAll(upperExt, 0o755); err != nil {
		t.Fatalf("mkdir upper: %v", err)
	}
	if err := os.WriteFile(filepath.Join(upperExt, "fresh.txt"), []byte("fresh"), 0o644); err != nil {
		t.Fatalf("write upper file: %v", err)
	}
	setOpaqueXattr(t, upperExt)

	if err := Materialize(t.Context(), MaterializeInput{
		LowerDir: lower,
		UpperDir: upper,
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

func mkCharDeviceWhiteout(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	_ = os.Remove(path)
	return unix.Mknod(path, unix.S_IFCHR, 0)
}

func setOpaqueXattr(t *testing.T, path string) {
	t.Helper()
	if err := unix.Lsetxattr(path, xattrUserOpaque, []byte("y"), 0); err == nil {
		return
	}
	if err := unix.Lsetxattr(path, xattrTrustedOpaque, []byte("y"), 0); err == nil {
		return
	}
	t.Skipf("cannot set kernel opaque xattr on %s (need overlay upperdir with userxattr or CAP_SYS_ADMIN)", path)
}

package overlay

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

func TestIsVolatileRelativePath(t *testing.T) {
	t.Parallel()

	cases := []struct {
		rel      string
		volatile bool
	}{
		{"Default/Preferences", false},
		{"Default/GPUCache/data", true},
		{"Default/SingletonLock", true},
		{"Default/Local Storage/leveldb", false},
		{"downloads/file.bin", true},
		{"cache/index", true},
	}

	for _, tc := range cases {
		if got := IsVolatileRelativePath(tc.rel, 0); got != tc.volatile {
			t.Fatalf("IsVolatileRelativePath(%q) = %v, want %v", tc.rel, got, tc.volatile)
		}
	}
}

func TestMaterializeHonorsLegacyAUFSWhiteoutAndHardlink(t *testing.T) {
	t.Parallel()

	root, err := filepath.Abs(t.TempDir())
	if err != nil {
		t.Fatalf("abs temp dir: %v", err)
	}
	lower := filepath.Join(root, "lower")
	upper := filepath.Join(root, "upper")
	dest := filepath.Join(root, "dest")

	if err := os.MkdirAll(filepath.Join(lower, "Default"), 0o755); err != nil {
		t.Fatalf("mkdir lower: %v", err)
	}
	if err := os.WriteFile(filepath.Join(lower, "Default", "kept.txt"), []byte("lower-kept"), 0o644); err != nil {
		t.Fatalf("write kept: %v", err)
	}
	if err := os.WriteFile(filepath.Join(lower, "Default", "deleted.txt"), []byte("gone"), 0o644); err != nil {
		t.Fatalf("write deleted: %v", err)
	}
	if err := os.WriteFile(filepath.Join(lower, "Default", "changed.txt"), []byte("lower"), 0o644); err != nil {
		t.Fatalf("write changed: %v", err)
	}

	if err := os.MkdirAll(filepath.Join(upper, "Default"), 0o755); err != nil {
		t.Fatalf("mkdir upper: %v", err)
	}
	if err := os.WriteFile(filepath.Join(upper, "Default", "changed.txt"), []byte("upper"), 0o644); err != nil {
		t.Fatalf("write upper changed: %v", err)
	}
	if err := os.WriteFile(filepath.Join(upper, "Default", "new.txt"), []byte("new"), 0o644); err != nil {
		t.Fatalf("write upper new: %v", err)
	}
	if err := mkCharDeviceWhiteout(filepath.Join(upper, "Default", ".wh.deleted.txt")); err != nil {
		t.Fatalf("whiteout: %v", err)
	}

	if err := Materialize(context.Background(), MaterializeInput{
		LowerDir: lower,
		UpperDir: upper,
		DestDir:  dest,
	}); err != nil {
		t.Fatalf("materialize: %v", err)
	}

	if _, err := os.Stat(filepath.Join(dest, "Default", "deleted.txt")); !os.IsNotExist(err) {
		t.Fatalf("deleted file present after whiteout: %v", err)
	}

	keptLower := filepath.Join(lower, "Default", "kept.txt")
	keptDest := filepath.Join(dest, "Default", "kept.txt")
	if !sameInode(t, keptLower, keptDest) {
		t.Fatal("expected hardlink for unchanged lower file")
	}

	changed, err := os.ReadFile(filepath.Join(dest, "Default", "changed.txt"))
	if err != nil {
		t.Fatalf("read changed: %v", err)
	}
	if string(changed) != "upper" {
		t.Fatalf("changed content = %q, want upper", string(changed))
	}

	newData, err := os.ReadFile(filepath.Join(dest, "Default", "new.txt"))
	if err != nil {
		t.Fatalf("read new: %v", err)
	}
	if string(newData) != "new" {
		t.Fatalf("new content = %q, want new", string(newData))
	}
}

func TestMaterializeHonorsLegacyAUFSOpaqueDirectory(t *testing.T) {
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
		t.Fatalf("write lower ext: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(upper, "Default", "Extensions"), 0o755); err != nil {
		t.Fatalf("mkdir upper: %v", err)
	}
	if err := os.WriteFile(filepath.Join(upper, "Default", "Extensions", "fresh.txt"), []byte("fresh"), 0o644); err != nil {
		t.Fatalf("write upper ext: %v", err)
	}
	if err := mkCharDeviceWhiteout(filepath.Join(upper, "Default", "Extensions", ".wh..wh..opq")); err != nil {
		t.Fatalf("opaque marker: %v", err)
	}

	if err := Materialize(context.Background(), MaterializeInput{
		LowerDir: lower,
		UpperDir: upper,
		DestDir:  dest,
	}); err != nil {
		t.Fatalf("materialize: %v", err)
	}

	if _, err := os.Stat(filepath.Join(dest, "Default", "Extensions", "old.txt")); !os.IsNotExist(err) {
		t.Fatalf("lower file leaked through opaque dir: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(dest, "Default", "Extensions", "fresh.txt"))
	if err != nil {
		t.Fatalf("read fresh: %v", err)
	}
	if string(data) != "fresh" {
		t.Fatalf("fresh = %q", string(data))
	}
}

func TestMaterializeExcludesVolatilePaths(t *testing.T) {
	t.Parallel()

	root, err := filepath.Abs(t.TempDir())
	if err != nil {
		t.Fatalf("abs temp dir: %v", err)
	}
	lower := filepath.Join(root, "lower")
	upper := filepath.Join(root, "upper")
	dest := filepath.Join(root, "dest")

	if err := os.MkdirAll(filepath.Join(lower, "Default", "GPUCache"), 0o755); err != nil {
		t.Fatalf("mkdir lower cache: %v", err)
	}
	if err := os.WriteFile(filepath.Join(lower, "Default", "GPUCache", "data"), []byte("cache"), 0o644); err != nil {
		t.Fatalf("write cache: %v", err)
	}
	if err := os.WriteFile(filepath.Join(lower, "Default", "Preferences"), []byte("{}"), 0o644); err != nil {
		t.Fatalf("write prefs: %v", err)
	}

	if err := Materialize(context.Background(), MaterializeInput{
		LowerDir: lower,
		UpperDir: upper,
		DestDir:  dest,
	}); err != nil {
		t.Fatalf("materialize: %v", err)
	}

	if _, err := os.Stat(filepath.Join(dest, "Default", "GPUCache")); !os.IsNotExist(err) {
		t.Fatalf("volatile cache dir materialized: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dest, "Default", "Preferences")); err != nil {
		t.Fatalf("preferences missing: %v", err)
	}
}

func sameInode(t *testing.T, a, b string) bool {
	t.Helper()
	var statA, statB unix.Stat_t
	if err := unix.Stat(a, &statA); err != nil {
		t.Fatalf("stat a: %v", err)
	}
	if err := unix.Stat(b, &statB); err != nil {
		t.Fatalf("stat b: %v", err)
	}
	return statA.Ino == statB.Ino
}

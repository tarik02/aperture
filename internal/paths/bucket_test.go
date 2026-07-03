package paths

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/aperture/aperture/internal/config"
)

func testConfig(t *testing.T) config.Config {
	t.Helper()

	root := t.TempDir()
	storeRoot := filepath.Join(root, "store")
	runtimeRoot := filepath.Join(root, "runtime")
	artifactRoot := filepath.Join(root, "artifacts")

	return config.Config{
		StoreRoot:    storeRoot,
		RuntimeRoot:  runtimeRoot,
		ArtifactRoot: artifactRoot,
	}
}

func TestBucketPrefix(t *testing.T) {
	t.Parallel()

	got, err := BucketPrefix("018f1234-0000-7000-8000-000000000000")
	if err != nil {
		t.Fatalf("BucketPrefix() error = %v", err)
	}
	if got != "01/8f" {
		t.Fatalf("bucket = %q, want 01/8f", got)
	}
}

func TestSessionPaths(t *testing.T) {
	t.Parallel()

	cfg := testConfig(t)
	sessionID := "018f1234-0000-7000-8000-000000000001"

	layout, err := Session(cfg, sessionID)
	if err != nil {
		t.Fatalf("Session() error = %v", err)
	}

	wantRoot := filepath.Join(cfg.StoreRoot, "sessions", "01", "8f", sessionID)
	if layout.Root != wantRoot {
		t.Fatalf("root = %q, want %q", layout.Root, wantRoot)
	}
	if layout.Merged != filepath.Join(wantRoot, "merged") {
		t.Fatalf("merged = %q", layout.Merged)
	}
	if layout.RuntimeEnv != filepath.Join(cfg.RuntimeRoot, "sessions", sessionID+".env") {
		t.Fatalf("runtime env = %q", layout.RuntimeEnv)
	}
	if layout.Logs != filepath.Join(cfg.ArtifactRoot, "01", "8f", sessionID, "logs") {
		t.Fatalf("logs = %q", layout.Logs)
	}
}

func TestSnapshotPaths(t *testing.T) {
	t.Parallel()

	cfg := testConfig(t)
	snapshotID := "018f1234-0000-7000-8000-000000000002"

	layout, err := Snapshot(cfg, snapshotID)
	if err != nil {
		t.Fatalf("Snapshot() error = %v", err)
	}

	wantProfile := filepath.Join(cfg.StoreRoot, "snapshots", "01", "8f", snapshotID, "profile")
	if layout.Profile != wantProfile {
		t.Fatalf("profile = %q, want %q", layout.Profile, wantProfile)
	}
}

func TestJoinUnderRootRejectsTraversal(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	if _, err := JoinUnderRoot(root, "..", "etc", "passwd"); err == nil {
		t.Fatal("expected traversal rejection")
	}
}

func TestEnsureUnderRootRejectsOutsidePath(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	outside := filepath.Join(filepath.Dir(root), "outside")
	if err := EnsureUnderRoot(root, outside); err == nil {
		t.Fatal("expected outside root rejection")
	}
}

func TestRejectSymlink(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	realDir := filepath.Join(root, "real")
	if err := os.MkdirAll(realDir, 0o755); err != nil {
		t.Fatalf("mkdir real: %v", err)
	}

	linkPath := filepath.Join(root, "link")
	if err := os.Symlink(realDir, linkPath); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	target := filepath.Join(linkPath, "nested")
	if err := RejectSymlink(target, root); err == nil {
		t.Fatal("expected symlink rejection")
	}
}

func TestValidateTrustedPathRejectsSymlinkComponent(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	store := filepath.Join(root, "store")
	if err := os.MkdirAll(store, 0o755); err != nil {
		t.Fatalf("mkdir store: %v", err)
	}

	link := filepath.Join(root, "store-link")
	if err := os.Symlink(store, link); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	target := filepath.Join(link, "sessions", "01", "8f", "018f1234-0000-7000-8000-000000000000")
	if err := ValidateTrustedPath(root, target); err == nil {
		t.Fatal("expected symlink rejection")
	}
}

func TestSessionRejectsInvalidID(t *testing.T) {
	t.Parallel()

	cfg := testConfig(t)
	if _, err := Session(cfg, "bad-id"); err == nil {
		t.Fatal("expected invalid session id error")
	}
}

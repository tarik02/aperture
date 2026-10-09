package sessionstorage

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/db"
	"github.com/aperture/aperture/internal/paths"
)

func TestRemoveOverlayIgnoresPathsOutsideSession(t *testing.T) {
	t.Parallel()
	cfg, row, layout := removalFixture(t)
	marker := filepath.Join(cfg.StoreRoot, "keep")
	if err := os.WriteFile(marker, []byte("unrelated data"), 0o600); err != nil {
		t.Fatal(err)
	}
	row.UpperPath = cfg.StoreRoot
	if err := RemoveOverlay(cfg, row); err != nil {
		t.Fatalf("RemoveOverlay() = %v", err)
	}
	if _, err := os.Stat(layout.Root); !os.IsNotExist(err) {
		t.Fatalf("current session root remains: %v", err)
	}
	if body, err := os.ReadFile(marker); err != nil || string(body) != "unrelated data" {
		t.Fatalf("unrelated data = %q, error = %v", body, err)
	}
}

func TestRemoveSessionStorageAfterRootRelocation(t *testing.T) {
	t.Parallel()
	cfg, row, _ := removalFixture(t)
	oldLayout, err := paths.Session(cfg, row.ID)
	if err != nil {
		t.Fatal(err)
	}
	row.DownloadsPath = oldLayout.Files.Downloads
	cfg.ColdRoot = filepath.Join(t.TempDir(), "moved-cold")
	cfg.ArtifactRoot = filepath.Join(t.TempDir(), "moved-artifacts")
	current, err := paths.Session(cfg, row.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{oldLayout.Files.Downloads, oldLayout.Artifacts, current.Files.Uploads, current.Artifacts} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "data"), []byte("session data"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := RemoveOverlay(cfg, row); err != nil {
		t.Fatalf("RemoveOverlay() = %v", err)
	}
	if err := RemoveArtifacts(cfg, row); err != nil {
		t.Fatalf("RemoveArtifacts() = %v", err)
	}
	for _, dir := range []string{current.Root, filepath.Dir(current.Files.Root), current.Artifacts} {
		if _, err := os.Stat(dir); !os.IsNotExist(err) {
			t.Fatalf("current storage %s remains: %v", dir, err)
		}
	}
	for _, dir := range []string{oldLayout.Files.Downloads, oldLayout.Artifacts} {
		if body, err := os.ReadFile(filepath.Join(dir, "data")); err != nil || string(body) != "session data" {
			t.Fatalf("storage outside configured roots changed: body=%q err=%v", body, err)
		}
	}
}

func TestRemoveOverlayRejectsSymlinkedStorageRoot(t *testing.T) {
	t.Parallel()
	cfg, row, layout := removalFixture(t)
	symlinkCfg := cfg
	symlinkCfg.StoreRoot = filepath.Join(t.TempDir(), "linked-store")
	if err := os.Symlink(cfg.StoreRoot, symlinkCfg.StoreRoot); err != nil {
		t.Fatal(err)
	}
	linked, err := paths.Session(symlinkCfg, row.ID)
	if err != nil {
		t.Fatal(err)
	}
	row.OverlayPath = linked.Root
	row.UpperPath = linked.Upper
	row.MergedPath = linked.Merged
	if err := RemoveOverlay(symlinkCfg, row); !errors.Is(err, paths.ErrSymlinkPath) {
		t.Fatalf("RemoveOverlay() = %v, want symlink rejection", err)
	}
	if _, err := os.Stat(layout.Upper); err != nil {
		t.Fatalf("symlink rejection removed session data: %v", err)
	}
}

func TestRemoveOverlayWithSharedStoreAndColdRoots(t *testing.T) {
	t.Parallel()
	cfg, row, layout := removalFixture(t)
	cfg.ColdRoot = cfg.StoreRoot
	shared, err := paths.Session(cfg, row.ID)
	if err != nil {
		t.Fatal(err)
	}
	row.DownloadsPath = shared.Files.Downloads
	if err := os.MkdirAll(shared.Files.Uploads, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(shared.Files.Uploads, "file"), []byte("data"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := RemoveOverlay(cfg, row); err != nil {
		t.Fatalf("RemoveOverlay() = %v", err)
	}
	if _, err := os.Stat(layout.Root); !os.IsNotExist(err) {
		t.Fatalf("session root remains: %v", err)
	}
}

func removalFixture(t *testing.T) (config.Config, *db.Session, paths.SessionLayout) {
	t.Helper()
	root := t.TempDir()
	cfg := config.Config{
		StoreRoot: filepath.Join(root, "store"), ColdRoot: filepath.Join(root, "cold"),
		ArtifactRoot: filepath.Join(root, "artifacts"), RuntimeRoot: filepath.Join(root, "runtime"),
	}
	const sessionID = "018f1234-0000-7000-8000-000000000001"
	layout, err := paths.Session(cfg, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(layout.Upper, 0o755); err != nil {
		t.Fatal(err)
	}
	return cfg, &db.Session{
		ID: sessionID, OverlayPath: layout.Root, UpperPath: layout.Upper,
		MergedPath: layout.Merged, ArtifactsPath: layout.Artifacts,
	}, layout
}

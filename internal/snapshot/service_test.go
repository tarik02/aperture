package snapshot

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/db"
	"github.com/aperture/aperture/internal/ids"
	"github.com/aperture/aperture/internal/paths"
)

func testStoreRoot(t *testing.T) (string, config.Config) {
	t.Helper()
	root, err := filepath.Abs(t.TempDir())
	if err != nil {
		t.Fatalf("abs temp dir: %v", err)
	}
	storeRoot := filepath.Join(root, "store")
	return storeRoot, config.Config{
		StoreRoot:             storeRoot,
		RuntimeRoot:           filepath.Join(root, "runtime"),
		ArtifactRoot:          filepath.Join(root, "artifacts"),
		SessionRetentionDays:  7,
		SnapshotRetentionDays: 7,
	}
}

func newSnapshotTestRepo(t *testing.T) (*db.Repository, string) {
	t.Helper()
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "aperture.db")
	database, err := db.Open(ctx, dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := database.Migrate(ctx); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	tenantID, err := ids.NewUUIDv7()
	if err != nil {
		t.Fatalf("tenant id: %v", err)
	}
	repo := db.NewRepository(database)
	if err := repo.CreateTenant(ctx, &db.Tenant{
		ID:          tenantID,
		DisplayName: "test",
		CreatedAt:   db.NowUTC(),
	}); err != nil {
		t.Fatalf("create tenant: %v", err)
	}
	return repo, tenantID
}

func TestSnapshotDeleteAndRestore(t *testing.T) {
	t.Parallel()

	repo, tenantID := newSnapshotTestRepo(t)
	ctx := context.Background()
	_, cfg := testStoreRoot(t)
	cfg.SnapshotRetentionDays = 7
	service := NewService(cfg, repo)

	snapshotID, err := ids.NewUUIDv7()
	if err != nil {
		t.Fatalf("snapshot id: %v", err)
	}
	layout, err := paths.Snapshot(cfg, snapshotID)
	if err != nil {
		t.Fatalf("layout: %v", err)
	}
	if err := os.MkdirAll(layout.Profile, 0o755); err != nil {
		t.Fatalf("mkdir profile: %v", err)
	}
	if err := repo.CreateSnapshot(ctx, &db.Snapshot{
		ID:        snapshotID,
		TenantID:  tenantID,
		Name:      "baseline",
		Path:      layout.Root,
		CreatedAt: db.NowUTC(),
	}); err != nil {
		t.Fatalf("create snapshot: %v", err)
	}

	deleted, err := service.Delete(ctx, tenantID, "baseline")
	if err != nil {
		t.Fatalf("delete snapshot: %v", err)
	}
	if deleted.Snapshot.DeletedAt == nil || deleted.Snapshot.ExpiresAt == nil {
		t.Fatal("expected tombstone timestamps")
	}

	restored, err := service.Restore(ctx, tenantID, "baseline")
	if err != nil {
		t.Fatalf("restore snapshot: %v", err)
	}
	if restored.Snapshot.DeletedAt != nil || restored.Snapshot.ExpiresAt != nil {
		t.Fatal("expected active snapshot after restore")
	}
}

type fakeBrowser struct {
	active bool
}

func (f *fakeBrowser) IsActive(context.Context, string) (bool, error) {
	return f.active, nil
}

func TestPromotionFromStoppedSession(t *testing.T) {
	t.Parallel()

	repo, tenantID := newSnapshotTestRepo(t)
	ctx := context.Background()
	_, cfg := testStoreRoot(t)

	sessionID, err := ids.NewUUIDv7()
	if err != nil {
		t.Fatalf("session id: %v", err)
	}
	layout, err := paths.Session(cfg, sessionID)
	if err != nil {
		t.Fatalf("session layout: %v", err)
	}
	for _, dir := range []string{layout.Upper, layout.Work} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
	}
	emptyLower, err := paths.EmptyLowerDir(cfg)
	if err != nil {
		t.Fatalf("empty lower: %v", err)
	}
	if err := os.MkdirAll(emptyLower, 0o755); err != nil {
		t.Fatalf("mkdir empty lower: %v", err)
	}
	if err := os.WriteFile(filepath.Join(layout.Upper, "marker.txt"), []byte("session-state"), 0o644); err != nil {
		t.Fatalf("write upper: %v", err)
	}

	now := time.Now().UTC()
	if err := repo.CreateSession(ctx, &db.Session{
		ID:              sessionID,
		TenantID:        tenantID,
		Status:          db.SessionStatusDeleted,
		OverlayPath:     layout.Root,
		UpperPath:       layout.Upper,
		WorkPath:        layout.Work,
		MergedPath:      layout.Merged,
		DownloadsPath:   layout.Downloads,
		CachePath:       layout.Cache,
		ArtifactsPath:   layout.Artifacts,
		BrowserChannel:  "chromium",
		BrowserArgsJSON: "[]",
		CreatedAt:       now.Format(time.RFC3339Nano),
		ExpiresAt:       now.Add(24 * time.Hour).Format(time.RFC3339Nano),
	}); err != nil {
		t.Fatalf("create session: %v", err)
	}

	snapshots := NewService(cfg, repo)
	promotion := NewPromotionService(cfg, repo, &fakeBrowser{}, snapshots)
	view, err := promotion.Promote(ctx, PromoteInput{
		TenantID:  tenantID,
		SessionID: sessionID,
		Name:      "promoted-v1",
		Tags:      map[string]string{"purpose": "test"},
	})
	if err != nil {
		t.Fatalf("promote: %v", err)
	}
	if view.Snapshot.Name != "promoted-v1" {
		t.Fatalf("name = %q", view.Snapshot.Name)
	}
	if view.Tags["purpose"] != "test" {
		t.Fatalf("tags = %#v", view.Tags)
	}

	snapshotLayout, err := paths.Snapshot(cfg, view.Snapshot.ID)
	if err != nil {
		t.Fatalf("snapshot layout: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(snapshotLayout.Profile, "marker.txt"))
	if err != nil {
		t.Fatalf("read materialized marker: %v", err)
	}
	if string(data) != "session-state" {
		t.Fatalf("marker = %q", string(data))
	}
}

func TestPromotionRejectsRunningSession(t *testing.T) {
	t.Parallel()

	repo, tenantID := newSnapshotTestRepo(t)
	ctx := context.Background()
	_, cfg := testStoreRoot(t)

	sessionID, err := ids.NewUUIDv7()
	if err != nil {
		t.Fatalf("session id: %v", err)
	}
	layout, err := paths.Session(cfg, sessionID)
	if err != nil {
		t.Fatalf("layout: %v", err)
	}
	if err := os.MkdirAll(layout.Upper, 0o755); err != nil {
		t.Fatalf("mkdir upper: %v", err)
	}

	now := time.Now().UTC()
	if err := repo.CreateSession(ctx, &db.Session{
		ID:              sessionID,
		TenantID:        tenantID,
		Status:          db.SessionStatusRunning,
		OverlayPath:     layout.Root,
		UpperPath:       layout.Upper,
		WorkPath:        layout.Work,
		MergedPath:      layout.Merged,
		DownloadsPath:   layout.Downloads,
		CachePath:       layout.Cache,
		ArtifactsPath:   layout.Artifacts,
		BrowserChannel:  "chromium",
		BrowserArgsJSON: "[]",
		CreatedAt:       now.Format(time.RFC3339Nano),
		ExpiresAt:       now.Add(24 * time.Hour).Format(time.RFC3339Nano),
	}); err != nil {
		t.Fatalf("create session: %v", err)
	}

	promotion := NewPromotionService(cfg, repo, &fakeBrowser{active: true}, NewService(cfg, repo))
	_, err = promotion.Promote(ctx, PromoteInput{
		TenantID:  tenantID,
		SessionID: sessionID,
		Name:      "blocked",
	})
	if err == nil {
		t.Fatal("expected promotion conflict")
	}
	var conflict *PromotionConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("err = %v, want PromotionConflictError", err)
	}
}

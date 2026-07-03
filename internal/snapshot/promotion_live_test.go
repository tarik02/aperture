//go:build linux

package snapshot

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/db"
	"github.com/aperture/aperture/internal/ids"
	"github.com/aperture/aperture/internal/overlay"
	"github.com/aperture/aperture/internal/paths"
)

func TestLiveStoppedSessionPromotionAndRestoreSmoke(t *testing.T) {
	if os.Getenv("APERTURE_LIVE_DESKTOP_TESTS") != "1" {
		t.Skip("set APERTURE_LIVE_DESKTOP_TESTS=1 to run live promotion smoke test")
	}

	ctx := context.Background()
	root, err := filepath.Abs(t.TempDir())
	if err != nil {
		t.Fatalf("abs temp dir: %v", err)
	}
	cfg := config.Config{
		StoreRoot:             filepath.Join(root, "store"),
		RuntimeRoot:           filepath.Join(root, "runtime"),
		ArtifactRoot:          filepath.Join(root, "artifacts"),
		SessionRetentionDays:  7,
		SnapshotRetentionDays: 7,
	}

	repo, tenantID := newSnapshotTestRepo(t)
	emptyLower, err := paths.EmptyLowerDir(cfg)
	if err != nil {
		t.Fatalf("empty lower: %v", err)
	}
	if err := os.MkdirAll(emptyLower, 0o755); err != nil {
		t.Fatalf("mkdir empty lower: %v", err)
	}

	sessionID, err := ids.NewUUIDv7()
	if err != nil {
		t.Fatalf("session id: %v", err)
	}
	layout, err := paths.Session(cfg, sessionID)
	if err != nil {
		t.Fatalf("session layout: %v", err)
	}
	if err := overlay.MountDirect(cfg, overlay.MountRequestFromIDs(sessionID, nil)); err != nil {
		t.Fatalf("mount overlay: %v", err)
	}
	t.Cleanup(func() { _ = overlay.UnmountDirect(cfg, sessionID) })

	if err := os.WriteFile(filepath.Join(layout.Upper, "live-marker.txt"), []byte("promoted-live"), 0o644); err != nil {
		t.Fatalf("write upper marker: %v", err)
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
	promoted, err := promotion.Promote(ctx, PromoteInput{
		TenantID:  tenantID,
		SessionID: sessionID,
		Name:      "live-promoted",
	})
	if err != nil {
		t.Fatalf("promote: %v", err)
	}

	snapshotLayout, err := paths.Snapshot(cfg, promoted.Snapshot.ID)
	if err != nil {
		t.Fatalf("snapshot layout: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(snapshotLayout.Profile, "live-marker.txt"))
	if err != nil {
		t.Fatalf("read promoted marker: %v", err)
	}
	if string(data) != "promoted-live" {
		t.Fatalf("marker = %q", string(data))
	}

	if _, err := snapshots.Delete(ctx, tenantID, "live-promoted"); err != nil {
		t.Fatalf("delete snapshot: %v", err)
	}
	if _, err := snapshots.Restore(ctx, tenantID, "live-promoted"); err != nil {
		t.Fatalf("restore snapshot: %v", err)
	}
}

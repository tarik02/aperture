package db

import (
	"context"
	"path/filepath"
	"testing"
)

// openTagFilterRepo returns a repository over a migrated temporary database.
func openTagFilterRepo(t *testing.T) (*Repository, context.Context) {
	t.Helper()

	ctx := context.Background()
	database, err := Open(ctx, filepath.Join(t.TempDir(), "aperture.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	if err := database.Migrate(ctx); err != nil {
		t.Fatalf("migrate database: %v", err)
	}

	repo := NewRepository(database)
	tenant := &Tenant{ID: "tenant-1", DisplayName: "tenant-1", CreatedAt: "2026-09-18T00:00:00Z"}
	if _, err := repo.db.bun.NewInsert().Model(tenant).Exec(ctx); err != nil {
		t.Fatalf("insert tenant: %v", err)
	}

	return repo, ctx
}

func insertTaggedSession(t *testing.T, repo *Repository, ctx context.Context, id, tenantID, key, value string) {
	t.Helper()

	session := &Session{
		ID:          id,
		TenantID:    tenantID,
		Status:      "running",
		OverlayPath: "/overlay/" + id,
		UpperPath:   "/upper/" + id,
		WorkPath:    "/work/" + id,
		MergedPath:  "/merged/" + id,
		// created_at orders pagination, so distinct ids get distinct timestamps.
		DownloadsPath: "/downloads/" + id,
		CachePath:     "/cache/" + id,
		ArtifactsPath: "/artifacts/" + id,
		CreatedAt:     "2026-09-18T00:00:00Z",
		ExpiresAt:     "2026-09-25T00:00:00Z",
	}
	if _, err := repo.db.bun.NewInsert().Model(session).Exec(ctx); err != nil {
		t.Fatalf("insert session %s: %v", id, err)
	}

	tag := &SessionTag{SessionID: id, Key: key, Value: value}
	if _, err := repo.db.bun.NewInsert().Model(tag).Exec(ctx); err != nil {
		t.Fatalf("insert session tag %s: %v", id, err)
	}
}

func insertTaggedSnapshot(t *testing.T, repo *Repository, ctx context.Context, id, tenantID, key, value string) {
	t.Helper()

	snapshot := &Snapshot{
		ID:        id,
		TenantID:  tenantID,
		Name:      id,
		Path:      "/snapshots/" + id,
		CreatedAt: "2026-09-18T00:00:00Z",
	}
	if _, err := repo.db.bun.NewInsert().Model(snapshot).Exec(ctx); err != nil {
		t.Fatalf("insert snapshot %s: %v", id, err)
	}

	tag := &SnapshotTag{SnapshotID: id, Key: key, Value: value}
	if _, err := repo.db.bun.NewInsert().Model(tag).Exec(ctx); err != nil {
		t.Fatalf("insert snapshot tag %s: %v", id, err)
	}
}

// The tag predicates correlate a subquery against the outer table. bun aliases a
// model to its struct name, not its table name, so naming the table there made
// every tag-filtered list fail at the database with an unresolved identifier.
// Each operator builds its own predicate, so each is exercised separately.
func TestListSessionsPageFiltersByTag(t *testing.T) {
	t.Parallel()

	repo, ctx := openTagFilterRepo(t)
	insertTaggedSession(t, repo, ctx, "session-match", "tenant-1", "role", "account")
	insertTaggedSession(t, repo, ctx, "session-other", "tenant-1", "role", "anonymous")

	for _, tc := range []struct {
		name   string
		filter TagFilter
		want   string
	}{
		{"equal", TagFilter{Key: "role", Operator: TagOperatorEqual, Values: []string{"account"}}, "session-match"},
		{"not equal", TagFilter{Key: "role", Operator: TagOperatorNotEqual, Values: []string{"account"}}, "session-other"},
		{"in", TagFilter{Key: "role", Operator: TagOperatorIn, Values: []string{"account", "absent"}}, "session-match"},
		{"not in", TagFilter{Key: "role", Operator: TagOperatorNotIn, Values: []string{"account"}}, "session-other"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			page, err := repo.ListSessionsPage(ctx, SessionFilter{TenantID: "tenant-1", Tags: []TagFilter{tc.filter}}, PageParams{})
			if err != nil {
				t.Fatalf("list sessions: %v", err)
			}
			if len(page.Items) != 1 {
				t.Fatalf("matched %d sessions, want 1", len(page.Items))
			}
			if page.Items[0].ID != tc.want {
				t.Fatalf("matched session %q, want %q", page.Items[0].ID, tc.want)
			}
		})
	}
}

func TestListSnapshotsPageFiltersByTag(t *testing.T) {
	t.Parallel()

	repo, ctx := openTagFilterRepo(t)
	insertTaggedSnapshot(t, repo, ctx, "snapshot-match", "tenant-1", "managed", "true")
	insertTaggedSnapshot(t, repo, ctx, "snapshot-other", "tenant-1", "managed", "false")

	for _, tc := range []struct {
		name   string
		filter TagFilter
		want   string
	}{
		{"equal", TagFilter{Key: "managed", Operator: TagOperatorEqual, Values: []string{"true"}}, "snapshot-match"},
		{"not equal", TagFilter{Key: "managed", Operator: TagOperatorNotEqual, Values: []string{"true"}}, "snapshot-other"},
		{"in", TagFilter{Key: "managed", Operator: TagOperatorIn, Values: []string{"true", "absent"}}, "snapshot-match"},
		{"not in", TagFilter{Key: "managed", Operator: TagOperatorNotIn, Values: []string{"true"}}, "snapshot-other"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			page, err := repo.ListSnapshotsPage(ctx, SnapshotFilter{TenantID: "tenant-1", Tags: []TagFilter{tc.filter}}, PageParams{})
			if err != nil {
				t.Fatalf("list snapshots: %v", err)
			}
			if len(page.Items) != 1 {
				t.Fatalf("matched %d snapshots, want 1", len(page.Items))
			}
			if page.Items[0].ID != tc.want {
				t.Fatalf("matched snapshot %q, want %q", page.Items[0].ID, tc.want)
			}
		})
	}
}

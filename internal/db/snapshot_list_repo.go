package db

import (
	"context"
	"fmt"

	"github.com/uptrace/bun"
)

// SnapshotFilter controls snapshot listing behavior.
type SnapshotFilter struct {
	TenantID       string
	IncludeDeleted bool
	TagKey         string
	TagValue       string
}

// ListSnapshotsPage returns tenant snapshots with cursor pagination.
func (r *Repository) ListSnapshotsPage(ctx context.Context, filter SnapshotFilter, params PageParams) (PageResult[Snapshot], error) {
	params = NormalizePageParams(params)
	cursor, err := parsePageCursor(params)
	if err != nil {
		return PageResult[Snapshot]{}, err
	}

	query := r.db.bun.NewSelect().Model((*Snapshot)(nil)).Where("tenant_id = ?", filter.TenantID)
	if !filter.IncludeDeleted {
		query = query.Where("deleted_at IS NULL")
	}
	if filter.TagKey != "" && filter.TagValue != "" {
		query = query.Where(
			"EXISTS (SELECT 1 FROM snapshot_tags st WHERE st.snapshot_id = snapshots.id AND st.key = ? AND st.value = ?)",
			filter.TagKey,
			filter.TagValue,
		)
	}
	query = paginateCreatedAtID(query, params, cursor)

	snapshots := make([]Snapshot, 0)
	if err := query.Scan(ctx, &snapshots); err != nil {
		return PageResult[Snapshot]{}, fmt.Errorf("list snapshots page: %w", err)
	}

	return buildPageResult(snapshots, params.Limit, func(s Snapshot) string { return s.CreatedAt }, func(s Snapshot) string { return s.ID })
}

// ListSnapshotTagsForSnapshots returns tags grouped by snapshot id.
func (r *Repository) ListSnapshotTagsForSnapshots(ctx context.Context, snapshotIDs []string) (map[string]map[string]string, error) {
	result := make(map[string]map[string]string)
	if len(snapshotIDs) == 0 {
		return result, nil
	}

	tags := make([]SnapshotTag, 0)
	if err := r.db.bun.NewSelect().
		Model(&tags).
		Where("snapshot_id IN (?)", bun.In(snapshotIDs)).
		OrderExpr("snapshot_id ASC, key ASC").
		Scan(ctx); err != nil {
		return nil, fmt.Errorf("list snapshot tags for snapshots: %w", err)
	}

	for _, tag := range tags {
		if result[tag.SnapshotID] == nil {
			result[tag.SnapshotID] = make(map[string]string)
		}
		result[tag.SnapshotID][tag.Key] = tag.Value
	}
	return result, nil
}

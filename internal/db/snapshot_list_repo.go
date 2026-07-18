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
	DeletedOnly    bool
	Tags           []TagFilter
	Resources      ResourceIDFilter
}

// ListSnapshotsPage returns tenant snapshots with cursor pagination.
func (r *Repository) ListSnapshotsPage(ctx context.Context, filter SnapshotFilter, params PageParams) (PageResult[Snapshot], error) {
	params = NormalizePageParams(params)
	cursor, err := parsePageCursor(params)
	if err != nil {
		return PageResult[Snapshot]{}, err
	}

	query := r.db.bun.NewSelect().Model((*Snapshot)(nil)).Where("tenant_id = ?", filter.TenantID)
	if filter.Resources.Restricted {
		if len(filter.Resources.IDs) == 0 {
			query = query.Where("1 = 0")
		} else {
			query = query.Where("id IN (?)", bun.List(filter.Resources.IDs))
		}
	}
	if filter.DeletedOnly {
		query = query.Where("deleted_at IS NOT NULL")
	} else if !filter.IncludeDeleted {
		query = query.Where("deleted_at IS NULL")
	}
	for _, tag := range filter.Tags {
		if tag.Key == "" || len(tag.Values) == 0 {
			continue
		}
		switch tag.Operator {
		case TagOperatorNotEqual:
			query = query.Where(
				"EXISTS (SELECT 1 FROM snapshot_tags st WHERE st.snapshot_id = snapshots.id AND st.key = ? AND st.value != ?)",
				tag.Key,
				tag.Values[0],
			)
		case TagOperatorIn:
			query = query.Where(
				"EXISTS (SELECT 1 FROM snapshot_tags st WHERE st.snapshot_id = snapshots.id AND st.key = ? AND st.value IN (?))",
				tag.Key,
				bun.List(tag.Values),
			)
		case TagOperatorNotIn:
			query = query.Where(
				"EXISTS (SELECT 1 FROM snapshot_tags st WHERE st.snapshot_id = snapshots.id AND st.key = ? AND st.value NOT IN (?))",
				tag.Key,
				bun.List(tag.Values),
			)
		default:
			query = query.Where(
				"EXISTS (SELECT 1 FROM snapshot_tags st WHERE st.snapshot_id = snapshots.id AND st.key = ? AND st.value = ?)",
				tag.Key,
				tag.Values[0],
			)
		}
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
		Where("snapshot_id IN (?)", bun.List(snapshotIDs)).
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

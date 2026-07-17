package db

import (
	"context"
	"fmt"

	"github.com/uptrace/bun"
)

// SessionFilter controls session listing behavior.
type SessionFilter struct {
	TenantID       string
	IncludeDeleted bool
	Status         *string
	Tags           []TagFilter
}

// ListSessionsPage returns tenant sessions with cursor pagination.
func (r *Repository) ListSessionsPage(ctx context.Context, filter SessionFilter, params PageParams) (PageResult[Session], error) {
	params = NormalizePageParams(params)
	cursor, err := parsePageCursor(params)
	if err != nil {
		return PageResult[Session]{}, err
	}

	query := r.db.bun.NewSelect().Model((*Session)(nil)).Where("tenant_id = ?", filter.TenantID)
	if !filter.IncludeDeleted {
		query = query.Where("deleted_at IS NULL")
	}
	if filter.Status != nil {
		query = query.Where("status = ?", *filter.Status)
	}
	for _, tag := range filter.Tags {
		if tag.Key == "" || len(tag.Values) == 0 {
			continue
		}
		switch tag.Operator {
		case TagOperatorNotEqual:
			query = query.Where(
				"EXISTS (SELECT 1 FROM session_tags st WHERE st.session_id = sessions.id AND st.key = ? AND st.value != ?)",
				tag.Key,
				tag.Values[0],
			)
		case TagOperatorIn:
			query = query.Where(
				"EXISTS (SELECT 1 FROM session_tags st WHERE st.session_id = sessions.id AND st.key = ? AND st.value IN (?))",
				tag.Key,
				bun.List(tag.Values),
			)
		case TagOperatorNotIn:
			query = query.Where(
				"EXISTS (SELECT 1 FROM session_tags st WHERE st.session_id = sessions.id AND st.key = ? AND st.value NOT IN (?))",
				tag.Key,
				bun.List(tag.Values),
			)
		default:
			query = query.Where(
				"EXISTS (SELECT 1 FROM session_tags st WHERE st.session_id = sessions.id AND st.key = ? AND st.value = ?)",
				tag.Key,
				tag.Values[0],
			)
		}
	}
	query = paginateCreatedAtID(query, params, cursor)

	sessions := make([]Session, 0)
	if err := query.Scan(ctx, &sessions); err != nil {
		return PageResult[Session]{}, fmt.Errorf("list sessions page: %w", err)
	}

	return buildPageResult(sessions, params.Limit, func(s Session) string { return s.CreatedAt }, func(s Session) string { return s.ID })
}

// ListSessionsByTenantAndIDs returns non-deleted tenant sessions matching ids.
func (r *Repository) ListSessionsByTenantAndIDs(ctx context.Context, tenantID string, sessionIDs []string) ([]Session, error) {
	sessions := make([]Session, 0)
	if len(sessionIDs) == 0 {
		return sessions, nil
	}
	if err := r.db.bun.NewSelect().
		Model(&sessions).
		Where("tenant_id = ?", tenantID).
		Where("id IN (?)", bun.List(sessionIDs)).
		Where("deleted_at IS NULL").
		Scan(ctx); err != nil {
		return nil, fmt.Errorf("list sessions by tenant and ids: %w", err)
	}
	return sessions, nil
}

// ListSessionTagsForSessions returns tags grouped by session id.
func (r *Repository) ListSessionTagsForSessions(ctx context.Context, sessionIDs []string) (map[string]map[string]string, error) {
	result := make(map[string]map[string]string)
	if len(sessionIDs) == 0 {
		return result, nil
	}

	tags := make([]SessionTag, 0)
	if err := r.db.bun.NewSelect().
		Model(&tags).
		Where("session_id IN (?)", bun.List(sessionIDs)).
		OrderExpr("session_id ASC, key ASC").
		Scan(ctx); err != nil {
		return nil, fmt.Errorf("list session tags for sessions: %w", err)
	}

	for _, tag := range tags {
		if result[tag.SessionID] == nil {
			result[tag.SessionID] = make(map[string]string)
		}
		result[tag.SessionID][tag.Key] = tag.Value
	}
	return result, nil
}

// ListSnapshotNamesByIDs returns snapshot names keyed by snapshot id.
func (r *Repository) ListSnapshotNamesByIDs(ctx context.Context, snapshotIDs []string) (map[string]string, error) {
	result := make(map[string]string, len(snapshotIDs))
	if len(snapshotIDs) == 0 {
		return result, nil
	}

	rows := make([]Snapshot, 0)
	if err := r.db.bun.NewSelect().
		Model(&rows).
		Column("id", "name").
		Where("id IN (?)", bun.List(snapshotIDs)).
		Scan(ctx); err != nil {
		return nil, fmt.Errorf("list snapshot names by ids: %w", err)
	}
	for _, row := range rows {
		result[row.ID] = row.Name
	}
	return result, nil
}

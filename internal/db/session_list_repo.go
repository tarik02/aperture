package db

import (
	"context"
	"fmt"

	"github.com/uptrace/bun"
)

// SessionSort orders a session page, newest first, with the id breaking ties.
type SessionSort string

const (
	SessionSortCreatedAt       SessionSort = "createdAt"
	SessionSortLastConnectedAt SessionSort = "lastConnectedAt"
)

// SessionFilter controls session listing behavior.
type SessionFilter struct {
	TenantID       string
	IncludeDeleted bool
	Status         *string
	// ActiveAt keeps only sessions that are creating, running or suspended and
	// whose retention outlasts this time. Empty disables the filter.
	ActiveAt string
	// Sort defaults to SessionSortCreatedAt.
	Sort SessionSort
	// Query matches a substring of the label, the id, or the base snapshot name.
	Query     string
	Tags      []TagFilter
	Resources ResourceIDFilter
}

// ListSessionsPage returns tenant sessions with cursor pagination.
func (r *Repository) ListSessionsPage(ctx context.Context, filter SessionFilter, params PageParams) (PageResult[Session], error) {
	params = NormalizePageParams(params)
	cursor, err := parsePageCursor(params)
	if err != nil {
		return PageResult[Session]{}, err
	}

	query := r.db.bun.NewSelect().Model((*Session)(nil)).Where("tenant_id = ?", filter.TenantID)
	if filter.Resources.Restricted {
		if len(filter.Resources.IDs) == 0 {
			query = query.Where("1 = 0")
		} else {
			query = query.Where("id IN (?)", bun.List(filter.Resources.IDs))
		}
	}
	if !filter.IncludeDeleted {
		query = query.Where("deleted_at IS NULL")
	}
	if filter.Status != nil {
		query = query.Where("status = ?", *filter.Status)
	}
	if filter.ActiveAt != "" {
		query = query.
			Where("status IN (?)", bun.List([]string{SessionStatusCreating, SessionStatusRunning, SessionStatusSuspended})).
			Where("expires_at > ?", filter.ActiveAt)
	}
	if filter.Query != "" {
		pattern := containsPattern(filter.Query)
		query = query.Where(
			"(label LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\' OR base_snapshot_id IN (SELECT s.id FROM snapshots s WHERE s.name LIKE ? ESCAPE '\\'))",
			pattern,
			pattern,
			pattern,
		)
	}
	for _, tag := range filter.Tags {
		if tag.Key == "" || len(tag.Values) == 0 {
			continue
		}
		switch tag.Operator {
		case TagOperatorNotEqual:
			query = query.Where(
				"EXISTS (SELECT 1 FROM session_tags st WHERE st.session_id = ?TableAlias.id AND st.key = ? AND st.value != ?)",
				tag.Key,
				tag.Values[0],
			)
		case TagOperatorIn:
			query = query.Where(
				"EXISTS (SELECT 1 FROM session_tags st WHERE st.session_id = ?TableAlias.id AND st.key = ? AND st.value IN (?))",
				tag.Key,
				bun.List(tag.Values),
			)
		case TagOperatorNotIn:
			query = query.Where(
				"EXISTS (SELECT 1 FROM session_tags st WHERE st.session_id = ?TableAlias.id AND st.key = ? AND st.value NOT IN (?))",
				tag.Key,
				bun.List(tag.Values),
			)
		default:
			query = query.Where(
				"EXISTS (SELECT 1 FROM session_tags st WHERE st.session_id = ?TableAlias.id AND st.key = ? AND st.value = ?)",
				tag.Key,
				tag.Values[0],
			)
		}
	}
	switch filter.Sort {
	case SessionSortLastConnectedAt:
		if cursor != nil && cursor.LastConnectedAt == "" {
			return PageResult[Session]{}, ErrInvalidCursor
		}
		query = query.OrderExpr("last_connected_at DESC, id DESC").Limit(params.Limit + 1)
		if cursor != nil {
			query = query.Where(
				"(last_connected_at < ?) OR (last_connected_at = ? AND id < ?)",
				cursor.LastConnectedAt,
				cursor.LastConnectedAt,
				cursor.ID,
			)
		}
	case SessionSortCreatedAt, "":
		query = paginateCreatedAtID(query, params, cursor)
	default:
		return PageResult[Session]{}, fmt.Errorf("unknown session sort %q", filter.Sort)
	}

	sessions := make([]Session, 0)
	if err := query.Scan(ctx, &sessions); err != nil {
		return PageResult[Session]{}, fmt.Errorf("list sessions page: %w", err)
	}

	return buildCursorPageResult(sessions, params.Limit, func(s Session) orderCursor {
		cursor := orderCursor{CreatedAt: s.CreatedAt, ID: s.ID}
		if s.LastConnectedAt != nil {
			cursor.LastConnectedAt = *s.LastConnectedAt
		}
		return cursor
	})
}

// ListSessionsByTenantAndIDs returns non-deleted tenant sessions matching ids.
func (r *Repository) ListSessionsByTenantAndIDs(ctx context.Context, tenantID string, sessionIDs []string, resources ResourceIDFilter) ([]Session, error) {
	sessions := make([]Session, 0)
	if len(sessionIDs) == 0 || resources.Restricted && len(resources.IDs) == 0 {
		return sessions, nil
	}
	query := r.db.bun.NewSelect().
		Model(&sessions).
		Where("tenant_id = ?", tenantID).
		Where("id IN (?)", bun.List(sessionIDs)).
		Where("deleted_at IS NULL")
	if resources.Restricted {
		query = query.Where("id IN (?)", bun.List(resources.IDs))
	}
	if err := query.Scan(ctx); err != nil {
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

// ListSessionTokensForSessions returns session tokens keyed by session id.
func (r *Repository) ListSessionTokensForSessions(ctx context.Context, sessionIDs []string) (map[string]SessionToken, error) {
	result := make(map[string]SessionToken, len(sessionIDs))
	if len(sessionIDs) == 0 {
		return result, nil
	}

	tokens := make([]SessionToken, 0, len(sessionIDs))
	if err := r.db.bun.NewSelect().
		Model(&tokens).
		Where("session_id IN (?)", bun.List(sessionIDs)).
		Scan(ctx); err != nil {
		return nil, fmt.Errorf("list session tokens for sessions: %w", err)
	}
	for _, token := range tokens {
		result[token.SessionID] = token
	}
	return result, nil
}

// ListSessionCollaborationCapabilitiesForSessions returns sharing secrets for sessions.
func (r *Repository) ListSessionCollaborationCapabilitiesForSessions(ctx context.Context, sessionIDs []string) ([]SessionCollaborationCapability, error) {
	if len(sessionIDs) == 0 {
		return []SessionCollaborationCapability{}, nil
	}
	capabilities := make([]SessionCollaborationCapability, 0, len(sessionIDs)*2)
	if err := r.db.bun.NewSelect().
		Model(&capabilities).
		Where("session_id IN (?)", bun.List(sessionIDs)).
		Scan(ctx); err != nil {
		return nil, fmt.Errorf("list session collaboration capabilities for sessions: %w", err)
	}
	return capabilities, nil
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

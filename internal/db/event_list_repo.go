package db

import (
	"context"
	"fmt"
)

// EventFilter controls event listing behavior.
type EventFilter struct {
	TenantID     string
	ResourceType *string
	ResourceID   *string
}

// ListEventsPage returns tenant events with cursor pagination.
func (r *Repository) ListEventsPage(ctx context.Context, filter EventFilter, params PageParams) (PageResult[Event], error) {
	params = NormalizePageParams(params)
	cursor, err := parsePageCursor(params)
	if err != nil {
		return PageResult[Event]{}, err
	}

	query := r.db.bun.NewSelect().Model((*Event)(nil)).Where("tenant_id = ?", filter.TenantID)
	if filter.ResourceType != nil {
		query = query.Where("resource_type = ?", *filter.ResourceType)
	}
	if filter.ResourceID != nil {
		query = query.Where("resource_id = ?", *filter.ResourceID)
	}
	query = paginateCreatedAtID(query, params, cursor)

	events := make([]Event, 0)
	if err := query.Scan(ctx, &events); err != nil {
		return PageResult[Event]{}, fmt.Errorf("list events page: %w", err)
	}

	return buildPageResult(events, params.Limit, func(e Event) string { return e.CreatedAt }, func(e Event) string { return e.ID })
}

package db

import (
	"context"
	"fmt"

	"github.com/uptrace/bun"
)

// EventFilter controls event listing behavior.
type EventFilter struct {
	TenantID     string
	ResourceType *string
	ResourceID   *string
	Resources    []ResourceReference
	Restricted   bool
}

// ListEventsPage returns tenant events with cursor pagination.
func (r *Repository) ListEventsPage(ctx context.Context, filter EventFilter, params PageParams) (PageResult[Event], error) {
	params = NormalizePageParams(params)
	cursor, err := parsePageCursor(params)
	if err != nil {
		return PageResult[Event]{}, err
	}

	query := r.db.bun.NewSelect().Model((*Event)(nil)).Where("tenant_id = ?", filter.TenantID)
	if filter.Restricted {
		if len(filter.Resources) == 0 {
			query = query.Where("1 = 0")
		} else {
			query = query.WhereGroup(" AND ", func(query *bun.SelectQuery) *bun.SelectQuery {
				for _, resource := range filter.Resources {
					query = query.WhereOr("(resource_type = ? AND resource_id = ?)", resource.ResourceType, resource.ResourceID)
				}
				return query
			})
		}
	}
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

package event

import (
	"context"

	"github.com/aperture/aperture/internal/db"
)

// Service provides read access to resource events.
type Service struct {
	repo *db.Repository
}

// NewService constructs an event service.
func NewService(repo *db.Repository) *Service {
	return &Service{repo: repo}
}

// ListFilter configures event listing.
type ListFilter struct {
	ResourceType *string
	ResourceID   *string
	Resources    []db.ResourceReference
	Restricted   bool
}

// List returns tenant events with cursor pagination.
func (s *Service) List(ctx context.Context, tenantID string, filter ListFilter, params db.PageParams) (db.PageResult[db.Event], error) {
	return s.repo.ListEventsPage(ctx, db.EventFilter{
		TenantID:     tenantID,
		ResourceType: filter.ResourceType,
		ResourceID:   filter.ResourceID,
		Resources:    filter.Resources,
		Restricted:   filter.Restricted,
	}, params)
}

package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/aperture/aperture/internal/db"
	"github.com/aperture/aperture/internal/event"
	"github.com/aperture/aperture/internal/session"
	"github.com/aperture/aperture/internal/snapshot"
	"github.com/gin-gonic/gin"
)

func toSessionListItem(view session.SessionView) sessionListItemResponse {
	resp := sessionListItemResponse{
		ID:               view.Session.ID,
		TenantID:         view.Session.TenantID,
		BaseSnapshotName: view.BaseSnapshotName,
		Status:           view.Session.Status,
		BrowserChannel:   view.Session.BrowserChannel,
		Media: sessionMedia{
			Mode:           view.Media.Mode,
			WebRTCProducer: view.Media.WebRTCProducer,
		},
		CreatedAt: view.Session.CreatedAt,
		StartedAt: view.Session.StartedAt,
		StoppedAt: view.Session.StoppedAt,
		DeletedAt: view.Session.DeletedAt,
		ExpiresAt: view.Session.ExpiresAt,
		Tags:      view.Tags,
	}
	if view.CDPURL != "" {
		resp.CDPURL = view.CDPURL
	}
	return resp
}

func toSnapshotListItem(view snapshot.SnapshotView) snapshotListItemResponse {
	return snapshotListItemResponse{
		ID:                    view.Snapshot.ID,
		Name:                  view.Snapshot.Name,
		TenantID:              view.Snapshot.TenantID,
		ParentSnapshotID:      view.Snapshot.ParentSnapshotID,
		PromotedFromSessionID: view.Snapshot.PromotedFromSessionID,
		CreatedAt:             view.Snapshot.CreatedAt,
		DeletedAt:             view.Snapshot.DeletedAt,
		ExpiresAt:             view.Snapshot.ExpiresAt,
		Tags:                  view.Tags,
	}
}

func toEventListItem(row db.Event) (eventListItemResponse, error) {
	var data json.RawMessage
	if row.DataJSON != "" {
		if err := json.Unmarshal([]byte(row.DataJSON), &data); err != nil {
			return eventListItemResponse{}, err
		}
	} else {
		data = json.RawMessage("{}")
	}

	return eventListItemResponse{
		ID:           row.ID,
		TenantID:     row.TenantID,
		ResourceType: row.ResourceType,
		ResourceID:   row.ResourceID,
		Type:         row.Type,
		Message:      row.Message,
		Data:         data,
		CreatedAt:    row.CreatedAt,
	}, nil
}

func (s *Server) listSessions(c *gin.Context) {
	if s.Sessions == nil {
		WriteError(c, errSessionServiceUnavailable)
		return
	}

	params, err := parsePageParams(c)
	if err != nil {
		WriteError(c, err)
		return
	}

	status, err := parseOptionalStatus(c)
	if err != nil {
		WriteError(c, err)
		return
	}

	tagFilters, err := parseTagFilters(c)
	if err != nil {
		WriteError(c, err)
		return
	}

	page, err := s.Sessions.List(c.Request.Context(), tenantIDFromContext(c), session.ListFilter{
		IncludeDeleted: parseIncludeDeleted(c),
		Status:         status,
		Tags:           tagFilters,
	}, params)
	if err != nil {
		WriteError(c, mapInvalidCursor(err))
		return
	}

	items := make([]sessionListItemResponse, 0, len(page.Items))
	for _, view := range page.Items {
		items = append(items, toSessionListItem(view))
	}
	c.JSON(http.StatusOK, paginatedResponse[sessionListItemResponse]{Data: items, Meta: page.Meta})
}

func (s *Server) listSnapshots(c *gin.Context) {
	if s.Snapshots == nil {
		WriteError(c, errSnapshotServiceUnavailable)
		return
	}

	params, err := parsePageParams(c)
	if err != nil {
		WriteError(c, err)
		return
	}

	includeDeleted, deletedOnly, err := parseDeletedFilter(c)
	if err != nil {
		WriteError(c, err)
		return
	}

	tagFilters, err := parseTagFilters(c)
	if err != nil {
		WriteError(c, err)
		return
	}

	page, err := s.Snapshots.List(c.Request.Context(), tenantIDFromContext(c), snapshot.ListFilter{
		IncludeDeleted: includeDeleted,
		DeletedOnly:    deletedOnly,
		Tags:           tagFilters,
	}, params)
	if err != nil {
		WriteError(c, mapInvalidCursor(err))
		return
	}

	items := make([]snapshotListItemResponse, 0, len(page.Items))
	for _, view := range page.Items {
		items = append(items, toSnapshotListItem(view))
	}
	c.JSON(http.StatusOK, paginatedResponse[snapshotListItemResponse]{Data: items, Meta: page.Meta})
}

func (s *Server) listEvents(c *gin.Context) {
	if s.Events == nil {
		WriteError(c, errEventServiceUnavailable)
		return
	}

	params, err := parsePageParams(c)
	if err != nil {
		WriteError(c, err)
		return
	}

	page, err := s.Events.List(c.Request.Context(), tenantIDFromContext(c), event.ListFilter{
		ResourceType: parseOptionalQuery(c, "resourceType"),
		ResourceID:   parseOptionalQuery(c, "resourceId"),
	}, params)
	if err != nil {
		WriteError(c, mapInvalidCursor(err))
		return
	}

	items := make([]eventListItemResponse, 0, len(page.Items))
	for _, row := range page.Items {
		mapped, err := toEventListItem(row)
		if err != nil {
			WriteError(c, err)
			return
		}
		items = append(items, mapped)
	}
	c.JSON(http.StatusOK, paginatedResponse[eventListItemResponse]{Data: items, Meta: page.Meta})
}

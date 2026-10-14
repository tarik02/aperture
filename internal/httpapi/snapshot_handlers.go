package httpapi

import (
	"context"
	"net/http"
	"strings"

	"github.com/aperture/aperture/internal/auth"
	"github.com/aperture/aperture/internal/db"
	"github.com/aperture/aperture/internal/snapshot"
	"github.com/gin-gonic/gin"
)

func toSnapshotResponse(view *snapshot.SnapshotView) snapshotResponse {
	return snapshotResponse{
		ID:                    view.Snapshot.ID,
		Name:                  view.Snapshot.Name,
		Description:           view.Snapshot.Description,
		TenantID:              view.Snapshot.TenantID,
		ParentSnapshotID:      view.Snapshot.ParentSnapshotID,
		PromotedFromSessionID: view.Snapshot.PromotedFromSessionID,
		CreatedAt:             view.Snapshot.CreatedAt,
		DeletedAt:             view.Snapshot.DeletedAt,
		ExpiresAt:             view.Snapshot.ExpiresAt,
		Tags:                  view.Tags,
	}
}

func (s *Server) promoteSession(c *gin.Context) {
	if s.Promotion == nil {
		WriteError(c, errPromotionServiceUnavailable)
		return
	}

	var req promoteSessionRequest
	if err := bindJSON(c, &req); err != nil {
		WriteError(c, err)
		return
	}
	principal := c.MustGet("principal").(auth.Principal)
	if err := s.Auth.AuthorizeSnapshotNameIfExists(c.Request.Context(), principal, tenantIDFromContext(c), req.Name); err != nil {
		WriteError(c, err)
		return
	}

	view, err := s.promote(c.Request.Context(), snapshot.PromoteInput{
		TenantID:    tenantIDFromContext(c),
		SessionID:   c.Param("sessionId"),
		Name:        req.Name,
		Description: req.Description,
		Force:       req.Force,
		Tags:        req.Tags,
	})
	if err != nil {
		WriteError(c, err)
		return
	}

	item, ok := s.snapshotWithNames(c, view)
	if !ok {
		return
	}
	c.JSON(http.StatusOK, promoteSessionResponse{Snapshot: item})
}

func (s *Server) updateSnapshot(c *gin.Context) {
	if s.Snapshots == nil {
		WriteError(c, errSnapshotServiceUnavailable)
		return
	}

	var req updateSnapshotRequest
	if err := bindJSON(c, &req); err != nil {
		WriteError(c, err)
		return
	}
	if !s.requireSnapshotResource(c, c.Param("name")) {
		return
	}

	view, err := s.Snapshots.UpdateDescription(c.Request.Context(), tenantIDFromContext(c), c.Param("name"), req.Description)
	if err != nil {
		WriteError(c, err)
		return
	}

	item, ok := s.snapshotWithNames(c, view)
	if !ok {
		return
	}
	c.JSON(http.StatusOK, snapshotMutationResponse{Snapshot: item})
}

func (s *Server) replaceSnapshotTags(c *gin.Context) {
	if s.Snapshots == nil {
		WriteError(c, errSnapshotServiceUnavailable)
		return
	}

	var req replaceTagsRequest
	if err := bindJSON(c, &req); err != nil {
		WriteError(c, err)
		return
	}
	if !s.requireSnapshotResource(c, c.Param("name")) {
		return
	}

	view, err := s.Snapshots.ReplaceTags(c.Request.Context(), tenantIDFromContext(c), c.Param("name"), req.Tags)
	if err != nil {
		WriteError(c, err)
		return
	}

	item, ok := s.snapshotWithNames(c, view)
	if !ok {
		return
	}
	c.JSON(http.StatusOK, snapshotMutationResponse{Snapshot: item})
}

func (s *Server) deleteSnapshot(c *gin.Context) {
	if s.Snapshots == nil {
		WriteError(c, errSnapshotServiceUnavailable)
		return
	}
	if !s.requireSnapshotResource(c, c.Param("name")) {
		return
	}

	view, err := s.Snapshots.Delete(c.Request.Context(), tenantIDFromContext(c), c.Param("name"))
	if err != nil {
		WriteError(c, err)
		return
	}

	item, ok := s.snapshotWithNames(c, view)
	if !ok {
		return
	}
	c.JSON(http.StatusOK, snapshotMutationResponse{Snapshot: item})
}

func (s *Server) restoreSnapshot(c *gin.Context) {
	if s.Snapshots == nil {
		WriteError(c, errSnapshotServiceUnavailable)
		return
	}
	if !s.requireSnapshotResource(c, c.Param("name")) {
		return
	}

	view, err := s.Snapshots.Restore(c.Request.Context(), tenantIDFromContext(c), c.Param("name"))
	if err != nil {
		WriteError(c, err)
		return
	}

	item, ok := s.snapshotWithNames(c, view)
	if !ok {
		return
	}
	c.JSON(http.StatusOK, snapshotMutationResponse{Snapshot: item})
}

func (s *Server) requireSnapshotScope(c *gin.Context, scope string) bool {
	principal, ok := c.Get("principal")
	if !ok {
		WriteError(c, auth.ErrTokenMissing)
		c.Abort()
		return false
	}

	p := principal.(auth.Principal)
	if !auth.HasScope(p.Scopes, scope) {
		WriteError(c, auth.ErrScopeDenied)
		c.Abort()
		return false
	}

	tenantID, err := s.Auth.ResolveTenantID(c.Request.Context(), p, selectedTenantID(c))
	if err != nil {
		WriteError(c, err)
		c.Abort()
		return false
	}
	c.Set("tenantId", tenantID)
	return true
}

func (s *Server) requireSnapshotResource(c *gin.Context, name string) bool {
	principal := c.MustGet("principal").(auth.Principal)
	if err := s.Auth.AuthorizeSnapshotName(c.Request.Context(), principal, tenantIDFromContext(c), name); err != nil {
		WriteError(c, err)
		return false
	}
	return true
}

func validateSnapshotName(name string) error {
	if strings.TrimSpace(name) == "" {
		return validationError("name is required")
	}
	return nil
}

// addSnapshotReferenceNames fills in the parent snapshot's name and the label
// of the session a snapshot was promoted from, so clients need not resolve
// those ids themselves. Both belong to the snapshot's own tenant.
func (s *Server) addSnapshotReferenceNames(ctx context.Context, snapshots []snapshotResponse) error {
	var refs db.ReferenceIDs
	for _, item := range snapshots {
		if item.ParentSnapshotID != nil {
			refs.Snapshots = append(refs.Snapshots, *item.ParentSnapshotID)
		}
		if item.PromotedFromSessionID != nil {
			refs.Sessions = append(refs.Sessions, *item.PromotedFromSessionID)
		}
	}
	if s.Repository == nil || (len(refs.Snapshots) == 0 && len(refs.Sessions) == 0) {
		return nil
	}
	names, err := s.Repository.ResolveReferenceNames(ctx, refs)
	if err != nil {
		return err
	}
	for i := range snapshots {
		item := &snapshots[i]
		if item.ParentSnapshotID != nil {
			if name, ok := names.Snapshots[*item.ParentSnapshotID]; ok {
				item.ParentSnapshotName = &name
			}
		}
		if item.PromotedFromSessionID != nil {
			if label, ok := names.Sessions[*item.PromotedFromSessionID]; ok {
				item.PromotedFromSessionLabel = &label
			}
		}
	}
	return nil
}

// snapshotWithNames maps one snapshot with its reference names. On failure it
// writes the error and returns false.
func (s *Server) snapshotWithNames(c *gin.Context, view *snapshot.SnapshotView) (snapshotResponse, bool) {
	items := []snapshotResponse{toSnapshotResponse(view)}
	if err := s.addSnapshotReferenceNames(c.Request.Context(), items); err != nil {
		WriteError(c, err)
		return snapshotResponse{}, false
	}
	return items[0], true
}

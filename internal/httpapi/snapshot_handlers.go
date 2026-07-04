package httpapi

import (
	"net/http"
	"strings"

	"github.com/aperture/aperture/internal/auth"
	"github.com/aperture/aperture/internal/snapshot"
	"github.com/gin-gonic/gin"
)

func toSnapshotResponse(view *snapshot.SnapshotView) snapshotResponse {
	return snapshotResponse{
		ID:        view.Snapshot.ID,
		Name:      view.Snapshot.Name,
		TenantID:  view.Snapshot.TenantID,
		CreatedAt: view.Snapshot.CreatedAt,
		DeletedAt: view.Snapshot.DeletedAt,
		Tags:      view.Tags,
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

	view, err := s.Promotion.Promote(c.Request.Context(), snapshot.PromoteInput{
		TenantID:  tenantIDFromContext(c),
		SessionID: c.Param("sessionId"),
		Name:      req.Name,
		Force:     req.Force,
		Tags:      req.Tags,
	})
	if err != nil {
		WriteError(c, err)
		return
	}

	c.JSON(http.StatusOK, promoteSessionResponse{Snapshot: toSnapshotResponse(view)})
}

func (s *Server) deleteSnapshot(c *gin.Context) {
	if s.Snapshots == nil {
		WriteError(c, errSnapshotServiceUnavailable)
		return
	}

	view, err := s.Snapshots.Delete(c.Request.Context(), tenantIDFromContext(c), c.Param("name"))
	if err != nil {
		WriteError(c, err)
		return
	}

	c.JSON(http.StatusOK, snapshotMutationResponse{Snapshot: toSnapshotResponse(view)})
}

func (s *Server) restoreSnapshot(c *gin.Context) {
	if s.Snapshots == nil {
		WriteError(c, errSnapshotServiceUnavailable)
		return
	}

	view, err := s.Snapshots.Restore(c.Request.Context(), tenantIDFromContext(c), c.Param("name"))
	if err != nil {
		WriteError(c, err)
		return
	}

	c.JSON(http.StatusOK, snapshotMutationResponse{Snapshot: toSnapshotResponse(view)})
}

func (s *Server) requireSnapshotsWrite(c *gin.Context) {
	if !s.requireSnapshotScope(c, auth.ScopeSnapshotsWrite) {
		return
	}
	c.Next()
}

func (s *Server) requirePromotionScopes(c *gin.Context) {
	principal, ok := c.Get("principal")
	if !ok {
		WriteError(c, auth.ErrTokenMissing)
		c.Abort()
		return
	}

	p := principal.(auth.Principal)
	if !auth.HasScope(p.Scopes, auth.ScopeSessionsWrite) || !auth.HasScope(p.Scopes, auth.ScopeSnapshotsWrite) {
		WriteError(c, auth.ErrScopeDenied)
		c.Abort()
		return
	}

	tenantID, err := auth.ResolveTenantID(p, selectedTenantID(c))
	if err != nil {
		WriteError(c, err)
		c.Abort()
		return
	}
	c.Set("tenantId", tenantID)
	c.Next()
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

	tenantID, err := auth.ResolveTenantID(p, selectedTenantID(c))
	if err != nil {
		WriteError(c, err)
		c.Abort()
		return false
	}
	c.Set("tenantId", tenantID)
	return true
}

func validateSnapshotName(name string) error {
	if strings.TrimSpace(name) == "" {
		return validationError("name is required")
	}
	return nil
}

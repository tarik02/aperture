package httpapi

import (
	"errors"
	"net/http"

	"github.com/aperture/aperture/internal/auth"
	"github.com/aperture/aperture/internal/session"
	"github.com/gin-gonic/gin"
)

func (s *Server) sessionTenant(c *gin.Context) {
	// Resolve account access independently of the tenant remembered by the browser.
	principal, err := s.WebAuth.Authenticate(c.Request.Context(), "")
	if err != nil {
		WriteError(c, err)
		return
	}
	row, err := s.Repository.GetSessionByID(c.Request.Context(), c.Param("sessionId"))
	if err != nil {
		WriteError(c, err)
		return
	}
	if row == nil || row.DeletedAt != nil {
		WriteError(c, session.ErrNotFound)
		return
	}
	if principal.Type == auth.PrincipalTypeUser && principal.OAuthGrantID == "" {
		principal, err = s.WebAuth.Authenticate(c.Request.Context(), row.TenantID)
	} else {
		principal, err = auth.SelectTenant(principal, row.TenantID)
	}
	if err != nil {
		if errors.Is(err, auth.ErrTenantForbidden) || errors.Is(err, auth.ErrTenantNotFound) || errors.Is(err, auth.ErrTenantDeleted) {
			WriteError(c, session.ErrNotFound)
		} else {
			WriteError(c, err)
		}
		return
	}
	if _, err := auth.ResolveTenantID(principal, row.TenantID); err != nil ||
		!auth.HasScope(principal.Scopes, auth.ScopeSessionsRead) ||
		!auth.HasResourceAccess(principal, auth.ResourceTypeSession, row.ID) {
		// An inaccessible session must not disclose its owning tenant.
		WriteError(c, session.ErrNotFound)
		return
	}
	tenant, err := s.Auth.GetTenant(c.Request.Context(), row.TenantID)
	if err != nil {
		WriteError(c, err)
		return
	}
	if tenant.DeletedAt != nil {
		WriteError(c, session.ErrNotFound)
		return
	}
	c.JSON(http.StatusOK, toTenantResponse(*tenant))
}

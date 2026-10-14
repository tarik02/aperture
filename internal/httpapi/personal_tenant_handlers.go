package httpapi

import (
	"context"
	"net/http"

	"github.com/aperture/aperture/internal/auth"
	"github.com/aperture/aperture/internal/db"
	"github.com/gin-gonic/gin"
)

// authorizeTenant rejects a tenant the request principal may not see.
func (s *Server) authorizeTenant(c *gin.Context, tenantID string) bool {
	principal := c.MustGet("principal").(auth.Principal)
	if err := s.Auth.AuthorizeTenant(c.Request.Context(), principal, tenantID); err != nil {
		WriteError(c, err)
		return false
	}
	return true
}

// personalTenantOwner returns the user a personal-tenant self-service request
// acts for. Only the user's own sign-in qualifies: API tokens act for no user,
// and an OAuth client must not dispose of the user's tenant.
func personalTenantOwner(principal auth.Principal) (string, bool) {
	if principal.Type != auth.PrincipalTypeUser || principal.UserID == nil || principal.OAuthGrantID != "" {
		return "", false
	}
	return *principal.UserID, true
}

func (s *Server) createOwnPersonalTenant(c *gin.Context) {
	s.changeOwnPersonalTenant(c, http.StatusCreated, "created", s.Auth.CreatePersonalTenant)
}

func (s *Server) deleteOwnPersonalTenant(c *gin.Context) {
	s.changeOwnPersonalTenant(c, http.StatusOK, "deleted", s.Auth.DeletePersonalTenant)
}

func (s *Server) restoreOwnPersonalTenant(c *gin.Context) {
	s.changeOwnPersonalTenant(c, http.StatusOK, "restored", s.Auth.RestorePersonalTenant)
}

func (s *Server) changeOwnPersonalTenant(
	c *gin.Context,
	status int,
	action string,
	change func(ctx context.Context, userID string) (*db.Tenant, error),
) {
	userID, ok := personalTenantOwner(c.MustGet("principal").(auth.Principal))
	if !ok {
		WriteError(c, auth.ErrScopeDenied)
		return
	}
	tenant, err := change(c.Request.Context(), userID)
	if err != nil {
		WriteError(c, err)
		return
	}
	if !s.recordAudit(c, auth.PersonalTenantAudit(userID, action)) {
		return
	}
	c.JSON(status, toTenantResponse(*tenant))
}

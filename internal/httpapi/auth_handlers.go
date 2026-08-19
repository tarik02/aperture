package httpapi

import (
	"net/http"

	"github.com/aperture/aperture/internal/auth"
	"github.com/gin-gonic/gin"
)

func toPrincipalResponse(principal auth.Principal) principalResponse {
	return principalResponse{
		TokenID:       principal.TokenID,
		Name:          principal.Name,
		AuthorityType: principal.AuthorityType,
		TenantID:      principal.TenantID,
		Scopes:        principal.Scopes,
	}
}

func (s *Server) authMe(c *gin.Context) {
	principal := c.MustGet("principal").(auth.Principal)

	resp := authMeResponse{
		Principal: toPrincipalResponse(principal),
	}

	selectedTenant, err := s.resolveSelectedTenant(c, principal)
	if err != nil {
		WriteError(c, err)
		return
	}
	resp.SelectedTenant = selectedTenant

	c.JSON(http.StatusOK, resp)
}

func (s *Server) resolveSelectedTenant(c *gin.Context, principal auth.Principal) (*tenantResponse, error) {
	var tenantID string
	switch principal.AuthorityType {
	case auth.AuthorityTenant:
		if principal.TenantID == nil {
			return nil, nil
		}
		tenantID = *principal.TenantID
	case auth.AuthoritySystemAdmin:
		tenantID = selectedTenantID(c)
		if tenantID == "" {
			tenants, err := s.Auth.ListTenants(c.Request.Context(), false)
			if err != nil {
				return nil, err
			}
			if len(tenants) == 0 {
				return nil, nil
			}
			tenantID = tenants[0].ID
		}
	default:
		return nil, nil
	}

	tenant, err := s.Auth.GetTenant(c.Request.Context(), tenantID)
	if err != nil {
		return nil, err
	}

	mapped := toTenantResponse(*tenant)
	return &mapped, nil
}

func (s *Server) listBrowserConfigurations(c *gin.Context) {
	if s.Channels == nil {
		WriteError(c, errBrowserConfigurationsUnavailable)
		return
	}
	c.JSON(http.StatusOK, browserConfigurationsResponse{Configurations: s.Channels.Configurations()})
}

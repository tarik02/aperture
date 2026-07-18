package httpapi

import (
	"net/http"

	"github.com/aperture/aperture/internal/auth"
	"github.com/gin-gonic/gin"
)

func toPrincipalResponse(principal auth.Principal) principalResponse {
	return principalResponse{
		Type:          principal.Type,
		ID:            principal.ID,
		AuthMethod:    principal.AuthMethod,
		TokenID:       principal.TokenID,
		UserID:        principal.UserID,
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
			return nil, nil
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

func (s *Server) listBrowserChannels(c *gin.Context) {
	if s.Channels == nil {
		WriteError(c, errChannelsUnavailable)
		return
	}

	names := s.Channels.Names()
	channels := make([]browserChannelResponse, 0, len(names))
	for _, name := range names {
		channels = append(channels, browserChannelResponse{Name: name})
	}

	c.JSON(http.StatusOK, browserChannelsResponse{Channels: channels})
}

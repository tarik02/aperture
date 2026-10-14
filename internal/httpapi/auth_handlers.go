package httpapi

import (
	"net/http"
	"slices"

	"github.com/aperture/aperture/internal/auth"
	"github.com/aperture/aperture/internal/db"
	"github.com/gin-gonic/gin"
)

func toPrincipalResponse(principal auth.Principal) principalResponse {
	var tokenID *string
	if principal.TokenID != "" {
		tokenID = &principal.TokenID
	}
	resourceGrants := make([]resourceGrantResponse, 0, len(principal.ResourceGrants))
	for _, grant := range principal.ResourceGrants {
		resourceGrants = append(resourceGrants, resourceGrantResponse{ResourceType: grant.ResourceType, ResourceID: grant.ResourceID})
	}
	return principalResponse{
		Type:           principal.Type,
		ID:             principal.ID,
		AuthMethod:     principal.AuthMethod,
		TokenID:        tokenID,
		UserID:         principal.UserID,
		Name:           principal.Name,
		AuthorityType:  principal.AuthorityType,
		TenantID:       principal.TenantID,
		Scopes:         principal.Scopes,
		ResourceMode:   principal.ResourceMode,
		ResourceGrants: resourceGrants,
	}
}

func (s *Server) authMe(c *gin.Context) {
	principal := c.MustGet("principal").(auth.Principal)
	s.writeAuthMe(c, principal, true)
}

func (s *Server) tenantContext(c *gin.Context) {
	principal, err := s.authenticate(c)
	if err != nil {
		WriteError(c, err)
		return
	}
	s.writeAuthMe(c, principal, false)
}

func (s *Server) writeAuthMe(c *gin.Context, principal auth.Principal, remember bool) {

	resp := authMeResponse{
		Principal:        toPrincipalResponse(principal),
		AvailableTenants: []tenantResponse{},
		Settings:         authMeSettings{AutoCreatePersonalTenant: s.Config.AutoCreatePersonalTenant},
	}

	selectedTenant, err := s.resolveSelectedTenant(c, principal)
	if err != nil {
		WriteError(c, err)
		return
	}
	resp.SelectedTenant = selectedTenant
	if !remember && selectedTenant != nil && selectedTenant.DeletedAt != nil {
		WriteError(c, auth.ErrTenantDeleted)
		return
	}
	if remember && selectedTenant != nil && c.GetBool(webSessionAuthenticationContextKey) {
		s.WebAuth.RememberSelectedTenant(c.Request.Context(), selectedTenant.ID)
	}
	if userID, ok := personalTenantOwner(principal); ok {
		active, restorable, err := s.Auth.PersonalTenantStatus(c.Request.Context(), userID)
		if err != nil {
			WriteError(c, err)
			return
		}
		status := personalTenantStatusResponse{Restorable: restorable}
		if active != nil {
			mapped := toTenantResponse(*active)
			status.Tenant = &mapped
		}
		resp.PersonalTenant = &status
	}
	if principal.Type == auth.PrincipalTypeUser && principal.UserID != nil {
		tenants, err := s.Auth.UserTenants(c.Request.Context(), *principal.UserID)
		if err != nil {
			WriteError(c, err)
			return
		}
		for _, tenant := range tenants {
			// An OAuth client sees only the tenants its grant covers.
			if principal.OAuthGrantID != "" && !slices.ContainsFunc(principal.TenantGrants, func(grant auth.TenantGrant) bool { return grant.TenantID == tenant.ID }) {
				continue
			}
			resp.AvailableTenants = append(resp.AvailableTenants, toTenantResponse(tenant))
		}
	}

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
		if tenantID != "" {
			if err := s.Auth.AuthorizeTenant(c.Request.Context(), principal, tenantID); err != nil {
				return nil, err
			}
		} else {
			defaultTenant, err := s.defaultAdminTenant(c, principal)
			if err != nil {
				return nil, err
			}
			if defaultTenant == nil {
				return nil, nil
			}
			tenantID = defaultTenant.ID
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

// defaultAdminTenant picks the tenant a system admin lands in without a
// selection: their own personal tenant when they have one, else the oldest
// active shared tenant.
func (s *Server) defaultAdminTenant(c *gin.Context, principal auth.Principal) (*db.Tenant, error) {
	if principal.UserID != nil {
		personal, err := s.Auth.PersonalTenant(c.Request.Context(), *principal.UserID)
		if err != nil {
			return nil, err
		}
		if personal != nil {
			return personal, nil
		}
	}
	tenants, err := s.Auth.ListTenants(c.Request.Context(), db.TenantFilter{
		Personal: db.PersonalTenantScope{Restricted: true},
	})
	if err != nil {
		return nil, err
	}
	if len(tenants) == 0 {
		return nil, nil
	}
	return &tenants[0], nil
}

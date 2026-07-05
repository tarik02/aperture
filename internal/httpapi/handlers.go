package httpapi

import (
	"strings"
	"time"

	"github.com/aperture/aperture/internal/auth"
	"github.com/aperture/aperture/internal/db"
	"github.com/gin-gonic/gin"
)

func toTenantResponse(tenant db.Tenant) tenantResponse {
	return tenantResponse{
		ID:          tenant.ID,
		DisplayName: tenant.DisplayName,
		CreatedAt:   tenant.CreatedAt,
		DeletedAt:   tenant.DeletedAt,
	}
}

func toTokenResponse(token db.APIToken) (tokenResponse, error) {
	scopes, err := auth.ParseScopesJSON(token.ScopesJSON)
	if err != nil {
		return tokenResponse{}, err
	}

	return tokenResponse{
		ID:            token.ID,
		AuthorityType: token.AuthorityType,
		TenantID:      token.TenantID,
		Name:          token.Name,
		Scopes:        scopes,
		CreatedAt:     token.CreatedAt,
		ExpiresAt:     token.ExpiresAt,
		RevokedAt:     token.RevokedAt,
	}, nil
}

func parseOptionalExpiresAt(raw *string) (*time.Time, error) {
	if raw == nil {
		return nil, nil
	}
	trimmed := strings.TrimSpace(*raw)
	if trimmed == "" {
		return nil, nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, trimmed)
	if err != nil {
		return nil, validationError("expiresAt must be RFC3339Nano")
	}
	return &parsed, nil
}

func (s *Server) createTenant(c *gin.Context) {
	var req createTenantRequest
	if err := bindJSON(c, &req); err != nil {
		WriteError(c, err)
		return
	}

	tenant, err := s.Auth.CreateTenant(c.Request.Context(), auth.CreateTenantInput{
		DisplayName: req.DisplayName,
	})
	if err != nil {
		WriteError(c, err)
		return
	}

	c.JSON(201, toTenantResponse(*tenant))
}

func (s *Server) listTenants(c *gin.Context) {
	includeDeleted, deletedOnly, err := parseDeletedFilter(c)
	if err != nil {
		WriteError(c, err)
		return
	}
	params, err := parsePageParams(c)
	if err != nil {
		WriteError(c, err)
		return
	}

	page, err := s.Auth.ListTenantsPage(c.Request.Context(), db.TenantFilter{
		IncludeDeleted: includeDeleted,
		DeletedOnly:    deletedOnly,
	}, params)
	if err != nil {
		WriteError(c, mapInvalidCursor(err))
		return
	}

	resp := make([]tenantResponse, 0, len(page.Items))
	for _, tenant := range page.Items {
		resp = append(resp, toTenantResponse(tenant))
	}
	c.JSON(200, paginatedResponse[tenantResponse]{Data: resp, Meta: page.Meta})
}

func (s *Server) updateTenant(c *gin.Context) {
	tenantID := c.Param("tenantId")
	var req updateTenantRequest
	if err := bindJSON(c, &req); err != nil {
		WriteError(c, err)
		return
	}

	tenant, err := s.Auth.UpdateTenant(c.Request.Context(), tenantID, auth.UpdateTenantInput{
		DisplayName: req.DisplayName,
	})
	if err != nil {
		WriteError(c, err)
		return
	}

	c.JSON(200, toTenantResponse(*tenant))
}

func (s *Server) deleteTenant(c *gin.Context) {
	tenantID := c.Param("tenantId")
	tenant, err := s.Auth.DeleteTenant(c.Request.Context(), tenantID)
	if err != nil {
		WriteError(c, err)
		return
	}
	c.JSON(200, toTenantResponse(*tenant))
}

func (s *Server) restoreTenant(c *gin.Context) {
	tenantID := c.Param("tenantId")
	tenant, err := s.Auth.RestoreTenant(c.Request.Context(), tenantID)
	if err != nil {
		WriteError(c, err)
		return
	}
	c.JSON(200, toTenantResponse(*tenant))
}

func (s *Server) createAdminToken(c *gin.Context) {
	var req createTokenRequest
	if err := bindJSON(c, &req); err != nil {
		WriteError(c, err)
		return
	}

	expiresAt, err := parseOptionalExpiresAt(req.ExpiresAt)
	if err != nil {
		WriteError(c, err)
		return
	}

	created, err := s.Auth.CreateToken(c.Request.Context(), auth.CreateTokenInput{
		AuthorityType: req.AuthorityType,
		TenantID:      req.TenantID,
		Name:          req.Name,
		Scopes:        req.Scopes,
		ExpiresAt:     expiresAt,
	})
	if err != nil {
		WriteError(c, err)
		return
	}

	token, err := toTokenResponse(created.Token)
	if err != nil {
		WriteError(c, err)
		return
	}

	c.JSON(201, createTokenResponse{Token: token, RawToken: created.Raw})
}

func (s *Server) listAdminTokens(c *gin.Context) {
	var tenantID *string
	if raw := strings.TrimSpace(c.Query("tenantId")); raw != "" {
		tenantID = &raw
	}

	filter, err := parseTokenFilter(c, tenantID, true)
	if err != nil {
		WriteError(c, err)
		return
	}

	params, err := parsePageParams(c)
	if err != nil {
		WriteError(c, err)
		return
	}

	page, err := s.Auth.ListTokensPage(c.Request.Context(), filter, params)
	if err != nil {
		WriteError(c, mapInvalidCursor(err))
		return
	}

	resp := make([]tokenResponse, 0, len(page.Items))
	for _, token := range page.Items {
		mapped, err := toTokenResponse(token)
		if err != nil {
			WriteError(c, err)
			return
		}
		resp = append(resp, mapped)
	}
	c.JSON(200, paginatedResponse[tokenResponse]{Data: resp, Meta: page.Meta})
}

func (s *Server) revokeAdminToken(c *gin.Context) {
	tokenID := c.Param("tokenId")
	if err := s.Auth.RevokeToken(c.Request.Context(), tokenID, nil); err != nil {
		WriteError(c, err)
		return
	}
	c.Status(204)
}

func (s *Server) getTenantSelf(c *gin.Context) {
	principal := c.MustGet("principal").(auth.Principal)
	tenantID := *principal.TenantID

	tenant, err := s.Auth.RequireActiveTenant(c.Request.Context(), tenantID)
	if err != nil {
		WriteError(c, err)
		return
	}

	c.JSON(200, toTenantResponse(*tenant))
}

func (s *Server) updateTenantSelf(c *gin.Context) {
	principal := c.MustGet("principal").(auth.Principal)
	tenantID := *principal.TenantID

	var req updateTenantRequest
	if err := bindJSON(c, &req); err != nil {
		WriteError(c, err)
		return
	}

	tenant, err := s.Auth.UpdateTenant(c.Request.Context(), tenantID, auth.UpdateTenantInput{
		DisplayName: req.DisplayName,
	})
	if err != nil {
		WriteError(c, err)
		return
	}

	c.JSON(200, toTenantResponse(*tenant))
}

func (s *Server) createTenantToken(c *gin.Context) {
	principal := c.MustGet("principal").(auth.Principal)
	tenantID := *principal.TenantID

	var req createTenantLocalTokenRequest
	if err := bindJSON(c, &req); err != nil {
		WriteError(c, err)
		return
	}

	expiresAt, err := parseOptionalExpiresAt(req.ExpiresAt)
	if err != nil {
		WriteError(c, err)
		return
	}

	tenantCopy := tenantID
	created, err := s.Auth.CreateToken(c.Request.Context(), auth.CreateTokenInput{
		AuthorityType: auth.AuthorityTenant,
		TenantID:      &tenantCopy,
		Name:          req.Name,
		Scopes:        req.Scopes,
		ExpiresAt:     expiresAt,
	})
	if err != nil {
		WriteError(c, err)
		return
	}

	token, err := toTokenResponse(created.Token)
	if err != nil {
		WriteError(c, err)
		return
	}

	c.JSON(201, createTokenResponse{Token: token, RawToken: created.Raw})
}

func (s *Server) listTenantTokens(c *gin.Context) {
	principal := c.MustGet("principal").(auth.Principal)
	tenantID := *principal.TenantID

	filter, err := parseTokenFilter(c, &tenantID, false)
	if err != nil {
		WriteError(c, err)
		return
	}

	params, err := parsePageParams(c)
	if err != nil {
		WriteError(c, err)
		return
	}

	page, err := s.Auth.ListTokensPage(c.Request.Context(), filter, params)
	if err != nil {
		WriteError(c, mapInvalidCursor(err))
		return
	}

	resp := make([]tokenResponse, 0, len(page.Items))
	for _, token := range page.Items {
		mapped, err := toTokenResponse(token)
		if err != nil {
			WriteError(c, err)
			return
		}
		resp = append(resp, mapped)
	}
	c.JSON(200, paginatedResponse[tokenResponse]{Data: resp, Meta: page.Meta})
}

func (s *Server) revokeTenantToken(c *gin.Context) {
	principal := c.MustGet("principal").(auth.Principal)
	tenantID := *principal.TenantID

	tokenID := c.Param("tokenId")
	if err := s.Auth.RevokeToken(c.Request.Context(), tokenID, &tenantID); err != nil {
		WriteError(c, err)
		return
	}
	c.Status(204)
}

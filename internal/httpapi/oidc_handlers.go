package httpapi

import (
	"net/http"
	"net/url"

	"github.com/aperture/aperture/internal/auth"
	"github.com/gin-gonic/gin"
)

func (s *Server) listOIDCProviders(c *gin.Context) {
	if s.WebAuth == nil {
		c.JSON(http.StatusOK, oidcProvidersResponse{Providers: []oidcProviderResponse{}})
		return
	}
	providers := s.WebAuth.Providers()
	response := make([]oidcProviderResponse, 0, len(providers))
	for _, provider := range providers {
		response = append(response, oidcProviderResponse{
			ID:       provider.ID,
			Name:     provider.DisplayName,
			LoginURL: "/auth/oidc/" + url.PathEscape(provider.ID) + "/login",
		})
	}
	c.JSON(http.StatusOK, oidcProvidersResponse{Providers: response})
}

func (s *Server) beginOIDC(c *gin.Context) {
	authorizationURL, err := s.WebAuth.BeginOIDC(c.Request.Context(), c.Param("providerId"), c.Query("returnTo"))
	if err != nil {
		WriteError(c, err)
		return
	}
	c.Redirect(http.StatusFound, authorizationURL)
}

func (s *Server) completeOIDC(c *gin.Context) {
	_, returnTo, err := s.WebAuth.CompleteOIDC(
		c.Request.Context(),
		c.Param("providerId"),
		c.Query("state"),
		c.Query("code"),
	)
	if err != nil {
		WriteError(c, err)
		return
	}
	c.Redirect(http.StatusFound, returnTo)
}

func (s *Server) logoutWebSession(c *gin.Context) {
	userID, err := s.WebAuth.Logout(c.Request.Context())
	if err != nil {
		WriteError(c, err)
		return
	}
	if userID != "" {
		principal := auth.Principal{Type: auth.PrincipalTypeUser, ID: userID, UserID: &userID, AuthMethod: auth.AuthMethodOIDC}
		if err := s.Auth.RecordAudit(c.Request.Context(), principal, auth.AuditInput{Action: "user.logged_out", ResourceType: "user", ResourceID: &userID}); err != nil {
			WriteError(c, err)
			return
		}
	}
	c.Status(http.StatusNoContent)
}

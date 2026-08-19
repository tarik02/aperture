package httpapi

import (
	"net/http"
	"net/url"

	"github.com/aperture/aperture/internal/auth"
	"github.com/aperture/aperture/internal/config"
	"github.com/gin-gonic/gin"
)

func (s *Server) listLoginMethods(c *gin.Context) {
	response := make([]loginMethodResponse, 0, len(s.Config.LoginMethods))
	for _, method := range s.Config.LoginMethods {
		switch method {
		case config.LoginMethodAPIToken:
			response = append(response, loginMethodResponse{Type: method})
		case config.LoginMethodPassword, config.LoginMethodPasskey:
			if s.WebAuth != nil {
				response = append(response, loginMethodResponse{Type: method})
			}
		case config.LoginMethodOIDC:
			if s.WebAuth == nil {
				continue
			}
			for _, provider := range s.WebAuth.Providers() {
				response = append(response, loginMethodResponse{
					Type:     method,
					ID:       provider.ID,
					Name:     provider.DisplayName,
					LoginURL: "/auth/oidc/" + url.PathEscape(provider.ID) + "/login",
				})
			}
		}
	}
	c.JSON(http.StatusOK, loginMethodsResponse{Methods: response})
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
	userID, authMethod, err := s.WebAuth.Logout(c.Request.Context())
	if err != nil {
		WriteError(c, err)
		return
	}
	if userID != "" {
		principal := auth.Principal{Type: auth.PrincipalTypeUser, ID: userID, UserID: &userID, AuthMethod: authMethod}
		if err := s.Auth.RecordAudit(c.Request.Context(), principal, auth.AuditInput{Action: "user.logged_out", ResourceType: "user", ResourceID: &userID}); err != nil {
			WriteError(c, err)
			return
		}
	}
	c.Status(http.StatusNoContent)
}

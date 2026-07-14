package httpapi

import (
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/aperture/aperture/internal/auth"
	"github.com/aperture/aperture/internal/session"
	"github.com/gin-gonic/gin"
)

func (s *Server) sessionTokenForwardAuth(c *gin.Context) {
	if s.Sessions == nil {
		c.Status(http.StatusUnauthorized)
		return
	}

	sessionID := c.Param("sessionId")
	err := s.Sessions.ValidateSessionTokenForwardAuth(
		c.Request.Context(),
		sessionID,
		sessionTokenForwardAuthCredential(c),
	)
	if err != nil {
		status, _ := mapForwardAuthError(err)
		c.Status(status)
		return
	}

	c.Status(http.StatusOK)
}

func (s *Server) liveSessionForwardAuth(c *gin.Context) {
	if s.Sessions == nil {
		c.Status(http.StatusUnauthorized)
		return
	}

	if authorization := liveSessionTokenAuthorization(c); authorization != "" {
		if err := s.Sessions.ValidateSessionTokenForwardAuth(c.Request.Context(), c.Param("sessionId"), authorization); err != nil {
			status, _ := mapForwardAuthError(err)
			c.Status(status)
			return
		}
		c.Status(http.StatusOK)
		return
	}

	if s.Auth == nil {
		c.Status(http.StatusUnauthorized)
		return
	}

	principal, err := s.authenticate(c)
	if err != nil {
		WriteError(c, err)
		return
	}
	c.Set("principal", principal)

	scope, ok := liveSessionForwardAuthScope(c.Param("access"))
	if !ok {
		c.Status(http.StatusNotFound)
		return
	}
	if !s.requireSessionScope(c, scope) {
		return
	}

	if err := s.Sessions.ValidateLiveSessionForwardAuth(
		c.Request.Context(),
		tenantIDFromContext(c),
		c.Param("sessionId"),
	); err != nil {
		WriteError(c, err)
		return
	}

	c.Status(http.StatusOK)
}

func liveSessionTokenAuthorization(c *gin.Context) string {
	if authorization := c.GetHeader("Authorization"); strings.HasPrefix(strings.TrimSpace(authorization), "Bearer session_") {
		return authorization
	}
	for _, protocol := range strings.Split(c.GetHeader("Sec-WebSocket-Protocol"), ",") {
		protocol = strings.TrimSpace(protocol)
		if strings.HasPrefix(protocol, "authorization.bearer.session_") {
			return "Bearer " + strings.TrimPrefix(protocol, "authorization.bearer.")
		}
	}
	return ""
}

func liveSessionForwardAuthScope(access string) (string, bool) {
	switch access {
	case "read":
		return auth.ScopeSessionsRead, true
	case "write":
		return auth.ScopeSessionsWrite, true
	default:
		return "", false
	}
}

func sessionTokenForwardAuthCredential(c *gin.Context) string {
	if token := sessionTokenFromForwardedURI(c.GetHeader("X-Forwarded-Uri")); token != "" {
		return "Bearer " + token
	}
	return ""
}

func sessionTokenFromForwardedURI(forwardedURI string) string {
	if forwardedURI == "" {
		return ""
	}
	parsed, err := url.ParseRequestURI(forwardedURI)
	if err != nil {
		return ""
	}
	parts := strings.Split(strings.TrimPrefix(parsed.Path, "/"), "/")
	if len(parts) >= 4 && parts[0] == "sessions" && parts[2] == "cdp" && strings.HasPrefix(parts[3], "session_") {
		return parts[3]
	}
	return ""
}

func mapForwardAuthError(err error) (int, string) {
	switch {
	case errors.Is(err, session.ErrSessionTokenMissing), errors.Is(err, session.ErrSessionTokenInvalid), errors.Is(err, session.ErrSessionTokenRevoked):
		return http.StatusUnauthorized, err.Error()
	case errors.Is(err, session.ErrNotFound):
		return http.StatusNotFound, err.Error()
	case errors.Is(err, session.ErrNotRunning):
		return http.StatusConflict, err.Error()
	case errors.Is(err, session.ErrExpired):
		return http.StatusGone, err.Error()
	default:
		return http.StatusUnauthorized, "session token authorization failed"
	}
}

func (s *Server) rotateSessionToken(c *gin.Context) {
	if s.Sessions == nil {
		WriteError(c, errSessionServiceUnavailable)
		return
	}

	view, err := s.Sessions.RotateSessionToken(
		c.Request.Context(),
		tenantIDFromContext(c),
		c.Param("sessionId"),
	)
	if err != nil {
		WriteError(c, err)
		return
	}

	c.JSON(http.StatusOK, sessionMutationResponse{
		Session:      toSessionResponse(view),
		CDPURL:       view.CDPURL,
		SessionToken: view.SessionToken,
	})
}

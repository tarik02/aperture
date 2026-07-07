package httpapi

import (
	"errors"
	"net/http"
	"net/url"

	"github.com/aperture/aperture/internal/auth"
	"github.com/aperture/aperture/internal/session"
	"github.com/gin-gonic/gin"
)

func (s *Server) cdpForwardAuth(c *gin.Context) {
	if s.Sessions == nil {
		c.Status(http.StatusUnauthorized)
		return
	}

	sessionID := c.Param("sessionId")
	err := s.Sessions.ValidateCDPForwardAuth(
		c.Request.Context(),
		sessionID,
		cdpForwardAuthCredential(c),
	)
	if err != nil {
		status, _ := mapForwardAuthError(err)
		c.Status(status)
		return
	}

	c.Status(http.StatusOK)
}

func (s *Server) liveSessionForwardAuth(c *gin.Context) {
	if s.Auth == nil || s.Sessions == nil {
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

func cdpForwardAuthCredential(c *gin.Context) string {
	if isWebSocketUpgrade(c.Request) {
		if token := c.Query("token"); token != "" {
			return ""
		}
		if token := cdpTokenFromForwardedURI(c.GetHeader("X-Forwarded-Uri")); token != "" {
			return ""
		}
		if token, ok := rawTokenFromWebSocketProtocol(c.GetHeader("Sec-WebSocket-Protocol")); ok {
			return "Bearer " + token
		}
		if authorization := c.GetHeader("Authorization"); authorization != "" {
			return authorization
		}
		return ""
	}
	if token := c.Query("token"); token != "" {
		return "Bearer " + token
	}
	if token := cdpTokenFromForwardedURI(c.GetHeader("X-Forwarded-Uri")); token != "" {
		return "Bearer " + token
	}
	if authorization := c.GetHeader("Authorization"); authorization != "" {
		return authorization
	}
	return ""
}

func cdpTokenFromForwardedURI(forwardedURI string) string {
	if forwardedURI == "" {
		return ""
	}
	parsed, err := url.ParseRequestURI(forwardedURI)
	if err != nil {
		return ""
	}
	return parsed.Query().Get("token")
}

func mapForwardAuthError(err error) (int, string) {
	switch {
	case errors.Is(err, session.ErrCDPTokenMissing), errors.Is(err, session.ErrCDPTokenInvalid), errors.Is(err, session.ErrCDPTokenRevoked):
		return http.StatusUnauthorized, err.Error()
	case errors.Is(err, session.ErrNotFound):
		return http.StatusNotFound, err.Error()
	case errors.Is(err, session.ErrNotRunning):
		return http.StatusConflict, err.Error()
	case errors.Is(err, session.ErrExpired):
		return http.StatusGone, err.Error()
	default:
		return http.StatusUnauthorized, "cdp authorization failed"
	}
}

func (s *Server) rotateCDPToken(c *gin.Context) {
	if s.Sessions == nil {
		WriteError(c, errSessionServiceUnavailable)
		return
	}

	view, err := s.Sessions.RotateCDPToken(
		c.Request.Context(),
		tenantIDFromContext(c),
		c.Param("sessionId"),
	)
	if err != nil {
		WriteError(c, err)
		return
	}

	c.JSON(http.StatusOK, sessionMutationResponse{
		Session:  toSessionResponse(view),
		CDPURL:   view.CDPURL,
		CDPToken: view.CDPToken,
	})
}

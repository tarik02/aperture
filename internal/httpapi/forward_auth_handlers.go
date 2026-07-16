package httpapi

import (
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"

	"github.com/aperture/aperture/internal/auth"
	"github.com/aperture/aperture/internal/session"
	"github.com/gin-gonic/gin"
)

const (
	forwardedActorKindHeader = "X-Aperture-Actor-Kind"
	forwardedClientIPHeader  = "X-Aperture-Client-IP"
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
	if s.Sessions == nil {
		c.Status(http.StatusUnauthorized)
		return
	}
	scope, ok := liveSessionForwardAuthScope(c.Param("access"))
	if !ok {
		c.Status(http.StatusNotFound)
		return
	}

	rawToken, rawTokenErr := rawTokenFromRequest(c)
	if rawTokenErr == nil && strings.HasPrefix(rawToken, "cdp_") {
		if err := s.Sessions.ValidateCDPForwardAuth(
			c.Request.Context(),
			c.Param("sessionId"),
			"Bearer "+rawToken,
		); err != nil {
			status, _ := mapForwardAuthError(err)
			c.Status(status)
			return
		}

		writeLiveSessionForwardAuthSuccess(c, "session_capability")
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

	writeLiveSessionForwardAuthSuccess(c, "account")
}

func writeLiveSessionForwardAuthSuccess(c *gin.Context, actorKind string) {
	protocols := make([]string, 0)
	for _, protocol := range strings.Split(c.GetHeader("Sec-WebSocket-Protocol"), ",") {
		protocol = strings.TrimSpace(protocol)
		if protocol == "" || strings.HasPrefix(protocol, "authorization.bearer.") || strings.HasPrefix(protocol, "x-aperture-tenant-id.") {
			continue
		}
		protocols = append(protocols, protocol)
	}

	c.Writer.Header()["Authorization"] = []string{""}
	c.Writer.Header()["Sec-Websocket-Protocol"] = []string{strings.Join(protocols, ", ")}
	c.Header(forwardedActorKindHeader, actorKind)
	clientIP := strings.TrimSpace(c.GetHeader("X-Real-Ip"))
	if net.ParseIP(clientIP) == nil {
		forwarded := strings.Split(c.GetHeader("X-Forwarded-For"), ",")
		for index := len(forwarded) - 1; index >= 0; index-- {
			candidate := strings.TrimSpace(forwarded[index])
			if net.ParseIP(candidate) != nil {
				clientIP = candidate
				break
			}
		}
	}
	if net.ParseIP(clientIP) == nil {
		clientIP, _, _ = net.SplitHostPort(c.Request.RemoteAddr)
	}
	c.Header(forwardedClientIPHeader, clientIP)
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
	if token := cdpTokenFromForwardedURI(c.GetHeader("X-Forwarded-Uri")); token != "" {
		return "Bearer " + token
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
	parts := strings.Split(strings.TrimPrefix(parsed.Path, "/"), "/")
	if len(parts) >= 4 && parts[0] == "sessions" && parts[2] == "cdp" && strings.HasPrefix(parts[3], "cdp_") {
		return parts[3]
	}
	return ""
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
		Session:  toSessionResponse(view, false),
		CDPURL:   view.CDPURL,
		CDPToken: view.CDPToken,
	})
}

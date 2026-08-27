package httpapi

import (
	"context"
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
	forwardedActorKindHeader         = "X-Aperture-Actor-Kind"
	forwardedClientIPHeader          = "X-Aperture-Client-IP"
	forwardedCollaborationRoleHeader = "X-Aperture-Collaboration-Role"
)

func (s *Server) sessionTokenForwardAuth(c *gin.Context) {
	if s.Sessions == nil {
		c.Status(http.StatusUnauthorized)
		return
	}

	sessionID := c.Param("sessionId")
	credential := sessionTokenForwardAuthCredential(c)
	role, err := s.validateCDPForwardAuth(c.Request.Context(), sessionID, credential)
	if err != nil {
		status, _ := mapForwardAuthError(err)
		c.Status(status)
		return
	}
	c.Header(forwardedCollaborationRoleHeader, role)
	c.Status(http.StatusOK)
}

func (s *Server) validateCDPForwardAuth(ctx context.Context, sessionID, credential string) (string, error) {
	raw, _ := strings.CutPrefix(strings.TrimSpace(credential), "Bearer ")
	if strings.HasPrefix(raw, "aps_") {
		if err := s.Sessions.ValidateSessionTokenForwardAuth(ctx, sessionID, credential); err != nil {
			return "", err
		}
		return "owner", nil
	}
	authorized, err := s.Sessions.WakeCollaborationSession(ctx, sessionID, credential)
	if err != nil {
		return "", err
	}
	return string(authorized.Role), nil
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

	if authorization := liveSessionTokenAuthorization(c); authorization != "" {
		role, err := s.authorizeLiveCapability(c.Request.Context(), c.Param("sessionId"), authorization, c.Param("access"))
		if err != nil {
			status, _ := mapForwardAuthError(err)
			c.Status(status)
			return
		}

		writeLiveSessionForwardAuthSuccess(c, "session_capability", role)
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

	role := "owner"
	if c.Param("access") == "read" && !auth.HasScope(principal.Scopes, auth.ScopeSessionsWrite) {
		role = "viewer"
	}
	writeLiveSessionForwardAuthSuccess(c, "account", role)
}

func (s *Server) authorizeLiveCapability(ctx context.Context, sessionID, authorization, access string) (string, error) {
	raw, _ := strings.CutPrefix(strings.TrimSpace(authorization), "Bearer ")
	if strings.HasPrefix(raw, "aps_") {
		if err := s.Sessions.ValidateSessionTokenForwardAuth(ctx, sessionID, authorization); err != nil {
			return "", err
		}
		return "owner", nil
	}
	authorized, err := s.Sessions.WakeCollaborationSession(ctx, sessionID, authorization)
	if err != nil {
		return "", err
	}
	if access == "write" && authorized.Role != session.CollaborationRoleEditor {
		return "", auth.ErrScopeDenied
	}
	if access == "owner" {
		return "", auth.ErrScopeDenied
	}
	return string(authorized.Role), nil
}

func writeLiveSessionForwardAuthSuccess(c *gin.Context, actorKind, collaborationRole string) {
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
	c.Header(forwardedCollaborationRoleHeader, collaborationRole)
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

func liveSessionTokenAuthorization(c *gin.Context) string {
	if authorization := c.GetHeader("Authorization"); isSessionAccessAuthorization(authorization) {
		return authorization
	}
	for _, protocol := range strings.Split(c.GetHeader("Sec-WebSocket-Protocol"), ",") {
		protocol = strings.TrimSpace(protocol)
		if strings.HasPrefix(protocol, "authorization.bearer.aps_") || strings.HasPrefix(protocol, "authorization.bearer.ape_") || strings.HasPrefix(protocol, "authorization.bearer.apv_") {
			return "Bearer " + strings.TrimPrefix(protocol, "authorization.bearer.")
		}
	}
	return ""
}

func isSessionAccessAuthorization(value string) bool {
	value = strings.TrimSpace(value)
	return strings.HasPrefix(value, "Bearer aps_") || strings.HasPrefix(value, "Bearer ape_") || strings.HasPrefix(value, "Bearer apv_")
}

func liveSessionForwardAuthScope(access string) (string, bool) {
	switch access {
	case "read":
		return auth.ScopeSessionsRead, true
	case "collaboration":
		return auth.ScopeSessionsWrite, true
	case "write":
		return auth.ScopeSessionsWrite, true
	case "owner":
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
	if len(parts) >= 4 && parts[0] == "sessions" && parts[2] == "cdp" && isSessionAccessToken(parts[3]) {
		return parts[3]
	}
	return ""
}

func isSessionAccessToken(value string) bool {
	return strings.HasPrefix(value, "aps_") || strings.HasPrefix(value, "ape_") || strings.HasPrefix(value, "apv_")
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

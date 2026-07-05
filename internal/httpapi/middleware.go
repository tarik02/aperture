package httpapi

import (
	"strings"

	"github.com/aperture/aperture/internal/auth"
	"github.com/aperture/aperture/internal/browser"
	"github.com/aperture/aperture/internal/event"
	"github.com/aperture/aperture/internal/gc"
	"github.com/aperture/aperture/internal/session"
	"github.com/aperture/aperture/internal/snapshot"
	"github.com/gin-gonic/gin"
)

// Server holds HTTP handler dependencies.
type Server struct {
	Auth      *auth.Service
	Sessions  *session.Service
	Snapshots *snapshot.Service
	Promotion *snapshot.PromotionService
	Events    *event.Service
	GC        *gc.Service
	Channels  *browser.Registry
	Signaling *SignalCoordinator
	jobToken  string
}

// SetJobToken configures the local job token for internal endpoints.
func (s *Server) SetJobToken(token string) {
	s.jobToken = token
}

func (s *Server) authenticate(c *gin.Context) (auth.Principal, error) {
	rawToken, err := rawTokenFromRequest(c)
	if err != nil {
		return auth.Principal{}, err
	}

	principal, err := s.Auth.Authenticate(c.Request.Context(), rawToken)
	if err != nil {
		return auth.Principal{}, err
	}

	c.Request = c.Request.WithContext(auth.WithPrincipal(c.Request.Context(), principal))
	return principal, nil
}

func rawTokenFromRequest(c *gin.Context) (string, error) {
	header := strings.TrimSpace(c.GetHeader("Authorization"))
	if header != "" {
		token, ok := rawTokenFromAuthorization(header)
		if !ok {
			return "", auth.ErrTokenInvalid
		}
		return token, nil
	}
	if isWebSocketUpgrade(c.Request) {
		if token, ok := rawTokenFromWebSocketProtocol(c.GetHeader("Sec-WebSocket-Protocol")); ok {
			return token, nil
		}
	}
	return "", auth.ErrTokenMissing
}

func rawTokenFromAuthorization(header string) (string, bool) {
	header = strings.TrimSpace(header)
	if header == "" {
		return "", false
	}

	const prefix = "Bearer "
	if !strings.HasPrefix(header, prefix) {
		return "", false
	}

	rawToken := strings.TrimSpace(header[len(prefix):])
	if rawToken == "" {
		return "", false
	}
	return rawToken, true
}

func rawTokenFromWebSocketProtocol(header string) (string, bool) {
	for _, part := range strings.Split(header, ",") {
		part = strings.TrimSpace(part)
		const prefix = "authorization.bearer."
		if strings.HasPrefix(part, prefix) {
			rawToken := strings.TrimSpace(part[len(prefix):])
			if rawToken != "" {
				return rawToken, true
			}
		}
	}
	return "", false
}

func tenantIDFromWebSocketProtocol(header string) string {
	for _, part := range strings.Split(header, ",") {
		part = strings.TrimSpace(part)
		const prefix = "x-aperture-tenant-id."
		if strings.HasPrefix(part, prefix) {
			return strings.TrimSpace(part[len(prefix):])
		}
	}
	return ""
}

func (s *Server) requireAuth(c *gin.Context) {
	principal, err := s.authenticate(c)
	if err != nil {
		WriteError(c, err)
		c.Abort()
		return
	}
	c.Set("principal", principal)
	c.Next()
}

func (s *Server) requireSystemAdmin(c *gin.Context) {
	principal, ok := c.Get("principal")
	if !ok {
		WriteError(c, auth.ErrTokenMissing)
		c.Abort()
		return
	}

	p := principal.(auth.Principal)
	if p.AuthorityType != auth.AuthoritySystemAdmin || !auth.HasScope(p.Scopes, auth.ScopeSystemAdmin) {
		WriteError(c, auth.ErrScopeDenied)
		c.Abort()
		return
	}
	c.Next()
}

func (s *Server) requireTenantWrite(c *gin.Context) {
	principal, ok := c.Get("principal")
	if !ok {
		WriteError(c, auth.ErrTokenMissing)
		c.Abort()
		return
	}

	p := principal.(auth.Principal)
	if p.AuthorityType != auth.AuthorityTenant {
		WriteError(c, auth.ErrScopeDenied)
		c.Abort()
		return
	}
	if !auth.HasScope(p.Scopes, auth.ScopeTenantWrite) {
		WriteError(c, auth.ErrScopeDenied)
		c.Abort()
		return
	}

	if p.TenantID == nil {
		WriteError(c, auth.ErrTenantNotFound)
		c.Abort()
		return
	}

	c.Next()
}

type validatableRequest interface {
	Validate() error
}

func bindJSON(c *gin.Context, dst validatableRequest) error {
	if err := c.ShouldBindJSON(dst); err != nil {
		return errRequestDecode
	}
	if err := dst.Validate(); err != nil {
		return err
	}
	return nil
}

func selectedTenantID(c *gin.Context) string {
	if header := strings.TrimSpace(c.GetHeader(auth.TenantHeader)); header != "" {
		return header
	}
	if isWebSocketUpgrade(c.Request) {
		return tenantIDFromWebSocketProtocol(c.GetHeader("Sec-WebSocket-Protocol"))
	}
	return ""
}

func (s *Server) requireSnapshotsRead(c *gin.Context) {
	if !s.requireSnapshotScope(c, auth.ScopeSnapshotsRead) {
		return
	}
	c.Next()
}

func (s *Server) requireSessionsRead(c *gin.Context) {
	if !s.requireSessionScope(c, auth.ScopeSessionsRead) {
		return
	}
	c.Next()
}

func (s *Server) requireSessionsReadScope(c *gin.Context) {
	if !s.requireScope(c, auth.ScopeSessionsRead) {
		return
	}
	c.Next()
}

func (s *Server) requireSessionsWrite(c *gin.Context) {
	if !s.requireSessionScope(c, auth.ScopeSessionsWrite) {
		return
	}
	c.Next()
}

func (s *Server) requireScope(c *gin.Context, scope string) bool {
	principal, ok := c.Get("principal")
	if !ok {
		WriteError(c, auth.ErrTokenMissing)
		c.Abort()
		return false
	}

	p := principal.(auth.Principal)
	if !auth.HasScope(p.Scopes, scope) {
		WriteError(c, auth.ErrScopeDenied)
		c.Abort()
		return false
	}
	return true
}

func (s *Server) requireSessionScope(c *gin.Context, scope string) bool {
	if !s.requireScope(c, scope) {
		return false
	}

	p := c.MustGet("principal").(auth.Principal)
	tenantID, err := auth.ResolveTenantID(p, selectedTenantID(c))
	if err != nil {
		WriteError(c, err)
		c.Abort()
		return false
	}
	c.Set("tenantId", tenantID)
	return true
}

func tenantIDFromContext(c *gin.Context) string {
	return c.GetString("tenantId")
}

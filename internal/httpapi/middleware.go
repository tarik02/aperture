package httpapi

import (
	"strings"

	"github.com/aperture/aperture/internal/auth"
	"github.com/gin-gonic/gin"
)

// Server holds HTTP handler dependencies.
type Server struct {
	Auth *auth.Service
}

func (s *Server) authenticate(c *gin.Context) (auth.Principal, error) {
	header := strings.TrimSpace(c.GetHeader("Authorization"))
	if header == "" {
		return auth.Principal{}, auth.ErrTokenMissing
	}

	const prefix = "Bearer "
	if !strings.HasPrefix(header, prefix) {
		return auth.Principal{}, auth.ErrTokenInvalid
	}

	rawToken := strings.TrimSpace(header[len(prefix):])
	principal, err := s.Auth.Authenticate(c.Request.Context(), rawToken)
	if err != nil {
		return auth.Principal{}, err
	}

	c.Request = c.Request.WithContext(auth.WithPrincipal(c.Request.Context(), principal))
	return principal, nil
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
	return strings.TrimSpace(c.GetHeader(auth.TenantHeader))
}

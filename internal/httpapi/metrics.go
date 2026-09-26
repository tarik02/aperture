package httpapi

import (
	"time"

	"github.com/gin-gonic/gin"
)

const (
	authMethodAPIToken     = "api_token"
	authMethodWebSession   = "web_session"
	authMethodSessionToken = "session_token"
	authMethodPassword     = "password"
	authMethodPasswordMFA  = "password_mfa"
	authMethodPasskey      = "passkey"
	authMethodOIDC         = "oidc"
)

const (
	apiErrorCodeContextKey = "apiErrorCode"
	// staticRouteLabel names requests no route matched: the web UI's files
	// and SPA paths, and unknown paths. Their raw paths would be unbounded.
	staticRouteLabel = "static"
)

func (s *Server) observeRequest(c *gin.Context) {
	if s.Metrics == nil {
		c.Next()
		return
	}
	done := s.Metrics.RequestStarted()
	defer done()
	started := time.Now()

	c.Next()

	route := c.FullPath()
	if route == "" {
		route = staticRouteLabel
	}
	s.Metrics.ObserveRequest(route, c.Request.Method, c.Writer.Status(), time.Since(started), c.GetString(apiErrorCodeContextKey))
}

// recordLogin counts the outcome of a web login attempt.
func (s *Server) recordLogin(method string, err error) {
	if err == nil {
		s.Metrics.Login(method)
		return
	}
	_, code, _ := mapError(err)
	s.Metrics.AuthFailure(method, code)
}

// recordAuthFailure counts a rejected request authentication.
func (s *Server) recordAuthFailure(method string, err error) {
	_, code, _ := mapError(err)
	s.Metrics.AuthFailure(method, code)
}

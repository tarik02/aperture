package httpapi

import (
	"context"
	"net/http"
	"time"

	"github.com/aperture/aperture/internal/metrics"
	"github.com/aperture/aperture/internal/snapshot"
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

// promote runs a session promotion and records its result, classifying errors
// the API answers with a 4xx status as rejections.
func (s *Server) promote(ctx context.Context, input snapshot.PromoteInput) (*snapshot.SnapshotView, error) {
	started := time.Now()
	view, err := s.Promotion.Promote(ctx, input)
	result := metrics.PromotionSucceeded
	if err != nil {
		result = metrics.PromotionFailed
		if status, _, _ := mapError(err); status < http.StatusInternalServerError {
			result = metrics.PromotionRejected
		}
	}
	s.Metrics.Promotion(result, time.Since(started))
	return view, err
}

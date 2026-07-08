package httpapi

import (
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"

	"github.com/aperture/aperture/internal/auth"
	"github.com/gin-gonic/gin"
)

func (s *Server) proxySessionWrapper(c *gin.Context) {
	if s.Sessions == nil {
		WriteError(c, errSessionServiceUnavailable)
		return
	}

	port, release, err := s.Sessions.AcquireWrapperPort(
		c.Request.Context(),
		tenantIDFromContext(c),
		c.Param("sessionId"),
	)
	if err != nil {
		WriteError(c, err)
		return
	}
	defer release()

	targetPath := c.GetString("wrapperProxyPath")
	if targetPath == "" {
		targetPath = strings.TrimPrefix(c.Request.URL.Path, "/api/sessions/"+c.Param("sessionId"))
	}
	if !strings.HasPrefix(targetPath, "/") {
		targetPath = "/" + targetPath
	}

	target := &url.URL{
		Scheme:   "http",
		Host:     fmt.Sprintf("127.0.0.1:%d", port),
		Path:     targetPath,
		RawQuery: c.Request.URL.RawQuery,
	}
	proxy := httputil.NewSingleHostReverseProxy(&url.URL{
		Scheme: "http",
		Host:   target.Host,
	})
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, proxyErr error) {
		if !c.Writer.Written() {
			WriteError(c, proxyErr)
		}
	}
	proxy.Director = func(outReq *http.Request) {
		outReq.URL.Scheme = target.Scheme
		outReq.URL.Host = target.Host
		outReq.URL.Path = target.Path
		outReq.URL.RawPath = ""
		outReq.URL.RawQuery = target.RawQuery
		outReq.Host = target.Host
		outReq.RequestURI = ""
		outReq.Header = c.Request.Header.Clone()
	}
	proxy.ServeHTTP(c.Writer, c.Request)
}

func (s *Server) tryProxySessionWrapperNoRoute(c *gin.Context) bool {
	rest, ok := strings.CutPrefix(c.Request.URL.Path, "/api/sessions/")
	if !ok {
		return false
	}
	sessionID, targetPath, ok := strings.Cut(rest, "/")
	if !ok || sessionID == "" || targetPath == "" {
		return false
	}

	principal, err := s.authenticate(c)
	if err != nil {
		WriteError(c, err)
		c.Abort()
		return true
	}
	c.Set("principal", principal)

	scope := auth.ScopeSessionsWrite
	if targetPath == "health" || targetPath == "status" {
		scope = auth.ScopeSessionsRead
	}
	if !s.requireSessionScope(c, scope) {
		return true
	}

	c.Params = append(c.Params, gin.Param{Key: "sessionId", Value: sessionID})
	c.Set("wrapperProxyPath", "/"+targetPath)
	s.proxySessionWrapper(c)
	return true
}

func (s *Server) proxyLegacyWebRTCSignal(c *gin.Context) {
	c.Set("wrapperProxyPath", "/webrtc/signal")
	s.proxySessionWrapper(c)
}

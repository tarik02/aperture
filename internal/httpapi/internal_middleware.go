package httpapi

import (
	"net"
	"net/http"
	"strings"

	"github.com/aperture/aperture/internal/jobtoken"
	"github.com/gin-gonic/gin"
)

const jobTokenHeader = "X-Aperture-Job-Token"

func (s *Server) requireLoopback(c *gin.Context) {
	host, _, err := net.SplitHostPort(strings.TrimSpace(c.Request.RemoteAddr))
	if err != nil {
		host = strings.TrimSpace(c.Request.RemoteAddr)
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		c.AbortWithStatus(http.StatusForbidden)
		return
	}
	c.Next()
}

func (s *Server) requireJobToken(c *gin.Context) {
	presented := strings.TrimSpace(c.GetHeader(jobTokenHeader))
	if err := jobtoken.Verify(s.jobToken, presented); err != nil {
		WriteError(c, err)
		c.Abort()
		return
	}
	c.Next()
}

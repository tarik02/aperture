package httpapi

import (
	"net"
	"net/http"
	"strings"

	"github.com/aperture/aperture/internal/deploystate"
	"github.com/aperture/aperture/internal/jobtoken"
	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

const jobTokenHeader = "X-Aperture-Job-Token"

func (s *Server) rejectInactiveInternalJob(c *gin.Context) {
	state, color, role, err := s.deployRole()
	if err != nil {
		WriteInternalError(c, err)
		c.Abort()
		return
	}
	if role == deploystate.RoleActive {
		c.Next()
		return
	}

	if s.Logger != nil {
		s.Logger.Warn("rejecting internal job on inactive api",
			zap.String("path", c.Request.URL.Path),
			zap.String("processColor", color),
			zap.String("activeColor", state.ActiveColor),
		)
	}
	c.JSON(http.StatusConflict, internalErrorBody{Error: "inactive api cannot run internal jobs"})
	c.Abort()
}

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
		WriteInternalError(c, err)
		c.Abort()
		return
	}
	c.Next()
}

package httpapi

import (
	"errors"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/aperture/aperture/internal/paths"
	"github.com/aperture/aperture/internal/sessionfiles"
	"github.com/gin-gonic/gin"
)

func (s *Server) sessionFile(c *gin.Context) {
	if s.Repository == nil || s.jobToken == "" {
		c.Status(http.StatusNotFound)
		return
	}
	sessionID := c.Param("sessionId")
	relative := strings.TrimPrefix(c.Param("relativePath"), "/")
	if _, err := sessionfiles.VerifyToken(s.jobToken, c.Query("token"), sessionID, relative, time.Now()); err != nil {
		c.Status(http.StatusForbidden)
		return
	}
	layout, err := paths.Session(s.Config, sessionID)
	if err != nil {
		c.Status(http.StatusNotFound)
		return
	}
	fullPath, normalized, err := sessionfiles.Resolve(layout, relative)
	if err != nil {
		if errors.Is(err, sessionfiles.ErrNotFound) {
			c.Status(http.StatusNotFound)
		} else {
			c.Status(http.StatusForbidden)
		}
		return
	}
	c.Header("Content-Disposition", sessionfiles.ContentDisposition(filepath.Base(normalized)))
	http.ServeFile(c.Writer, c.Request, fullPath)
}

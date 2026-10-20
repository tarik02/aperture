package httpapi

import (
	"bytes"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/aperture/aperture/internal/db"
	"github.com/aperture/aperture/internal/session"
	"github.com/gin-gonic/gin"
)

type sessionFaviconResponse struct {
	TargetURLTemplate string `json:"targetUrlTemplate"`
	ExpiresAt         string `json:"expiresAt"`
}

// sessionFaviconLinks signs a fresh favicon URL template with a thumbnail token, or returns nil when
// the session has no pages to show. Each page says whether it has a favicon.
func (s *Server) sessionFaviconLinks(sessionRow db.Session) *sessionFaviconResponse {
	if s.Sessions == nil || s.jobToken == "" ||
		(sessionRow.Status != db.SessionStatusRunning && sessionRow.Status != db.SessionStatusSuspended) {
		return nil
	}
	expiresAt := time.Now().Add(s.Config.SignedFileURLTTL).UTC()
	token, err := issueThumbnailToken(s.jobToken, sessionRow.ID, expiresAt)
	if err != nil {
		return nil
	}
	base := strings.TrimRight(s.Config.ExternalBaseURL, "/") + "/sessions/" + url.PathEscape(sessionRow.ID)
	return &sessionFaviconResponse{
		TargetURLTemplate: base + "/targets/{targetId}/favicon?token=" + url.QueryEscape(token),
		ExpiresAt:         expiresAt.Format(time.RFC3339),
	}
}

// getSessionFavicon serves the account API route, authorized like other session reads.
func (s *Server) getSessionFavicon(c *gin.Context) {
	if s.Sessions == nil {
		WriteError(c, errSessionServiceUnavailable)
		return
	}
	favicon, err := s.Sessions.Favicon(c.Request.Context(), tenantIDFromContext(c), c.Param("sessionId"), c.Param("targetId"))
	if err != nil {
		WriteError(c, err)
		return
	}
	writeFavicon(c, favicon)
}

// sessionFavicon serves signed URLs and requests authorized by a session token or an editor or
// viewer capability. It never wakes a suspended session.
func (s *Server) sessionFavicon(c *gin.Context) {
	if s.Sessions == nil {
		WriteError(c, errSessionServiceUnavailable)
		return
	}
	sessionID := c.Param("sessionId")
	targetID := c.Param("targetId")
	var favicon session.Favicon
	var err error
	if token := c.Query("token"); token != "" {
		if verifyThumbnailToken(s.jobToken, token, sessionID, time.Now()) != nil {
			c.Status(http.StatusForbidden)
			return
		}
		favicon, err = s.Sessions.SignedFavicon(c.Request.Context(), sessionID, targetID)
	} else {
		favicon, err = s.Sessions.AuthorizedFavicon(c.Request.Context(), sessionID, c.GetHeader("Authorization"), targetID)
	}
	if errors.Is(err, session.ErrSessionTokenMissing) || errors.Is(err, session.ErrSessionTokenInvalid) {
		c.Status(http.StatusUnauthorized)
		return
	}
	if err != nil {
		WriteError(c, err)
		return
	}
	writeFavicon(c, favicon)
}

// writeFavicon lets a request naming the current version cache the icon for good; other requests
// revalidate it through its ETag.
func writeFavicon(c *gin.Context, favicon session.Favicon) {
	c.Header("Content-Type", favicon.ContentType)
	c.Header("X-Content-Type-Options", "nosniff")
	// Icons may be SVG documents; opened directly they must not run scripts or load anything.
	c.Header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
	c.Header("ETag", `"`+favicon.Version+`"`)
	if c.Query("v") == favicon.Version {
		c.Header("Cache-Control", "private, max-age=31536000, immutable")
	} else {
		c.Header("Cache-Control", "private, no-cache")
	}
	http.ServeContent(c.Writer, c.Request, "", time.Time{}, bytes.NewReader(favicon.Image))
}

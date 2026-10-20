package httpapi

import (
	"errors"
	"net/http"
	"time"

	"github.com/aperture/aperture/internal/auth"
	"github.com/aperture/aperture/internal/browser"
	"github.com/aperture/aperture/internal/session"
	"github.com/gin-gonic/gin"
)

type browserStatusResponse struct {
	SessionID              string                      `json:"sessionId"`
	Status                 string                      `json:"status"`
	Source                 string                      `json:"source"`
	CapturedAt             *time.Time                  `json:"capturedAt,omitempty"`
	RepresentativeTargetID string                      `json:"representativeTargetId,omitempty"`
	Pages                  []browser.PageManifestEntry `json:"pages"`
	ThumbnailAvailable     bool                        `json:"thumbnailAvailable"`
	CDPURL                 string                      `json:"cdpUrl"`
	Media                  sessionMedia                `json:"media"`
}

// browserStatus returns passive page discovery for both account and session-capability callers.
// It does not wake the browser, touch retention, or acquire an activity inhibitor.
func (s *Server) browserStatus(c *gin.Context) {
	if s.Sessions == nil {
		WriteError(c, errSessionServiceUnavailable)
		return
	}

	var overview session.BrowserOverview
	var err error
	if authorization := c.GetHeader("Authorization"); isSessionAccessAuthorization(authorization) {
		overview, err = s.Sessions.AuthorizedBrowserOverview(c.Request.Context(), c.Param("sessionId"), authorization)
	} else {
		if s.Auth == nil {
			c.Status(http.StatusUnauthorized)
			return
		}
		principal, authErr := s.authenticate(c)
		if authErr != nil {
			WriteError(c, authErr)
			return
		}
		c.Set("principal", principal)
		if !s.requireSessionScope(c, auth.ScopeSessionsRead) {
			return
		}
		overview, err = s.Sessions.BrowserOverview(c.Request.Context(), tenantIDFromContext(c), c.Param("sessionId"))
	}
	if errors.Is(err, session.ErrSessionTokenMissing) || errors.Is(err, session.ErrSessionTokenInvalid) || errors.Is(err, session.ErrSessionTokenRevoked) {
		c.Status(http.StatusUnauthorized)
		return
	}
	if err != nil {
		WriteError(c, err)
		return
	}

	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, browserStatusResponse{
		SessionID:              overview.SessionID,
		Status:                 overview.Status,
		Source:                 overview.Source,
		CapturedAt:             overview.CapturedAt,
		RepresentativeTargetID: overview.RepresentativeTargetID,
		Pages:                  overview.Pages,
		ThumbnailAvailable:     overview.ThumbnailAvailable,
		CDPURL:                 overview.CDPURL,
		Media: sessionMedia{
			Mode:           overview.Media.Mode,
			WebRTCProducer: overview.Media.WebRTCProducer,
			ICEServers:     toICEServerResponses(overview.Media.ICEServers),
		},
	})
}

type sessionTabResponse struct {
	TargetID           string `json:"targetId"`
	Title              string `json:"title"`
	URL                string `json:"url"`
	State              string `json:"state"`
	Loading            bool   `json:"loading"`
	Active             bool   `json:"active"`
	ThumbnailAvailable bool   `json:"thumbnailAvailable"`
}

type sessionTabsResponse struct {
	SessionID  string               `json:"sessionId"`
	Status     string               `json:"status"`
	Source     string               `json:"source"`
	CapturedAt *time.Time           `json:"capturedAt,omitempty"`
	Tabs       []sessionTabResponse `json:"tabs"`
}

// listSessionTabs serves the account API tab list. It reads the same passive overview as
// browserStatus, so it never wakes a suspended session.
func (s *Server) listSessionTabs(c *gin.Context) {
	if s.Sessions == nil {
		WriteError(c, errSessionServiceUnavailable)
		return
	}
	overview, err := s.Sessions.TabsOverview(c.Request.Context(), tenantIDFromContext(c), c.Param("sessionId"))
	if err != nil {
		WriteError(c, err)
		return
	}

	tabs := make([]sessionTabResponse, 0, len(overview.Pages))
	for _, page := range overview.Pages {
		tabs = append(tabs, sessionTabResponse{
			TargetID:           page.TargetID,
			Title:              page.Title,
			URL:                page.URL,
			State:              page.State,
			Loading:            overview.Source == "live" && page.Loading,
			Active:             page.TargetID == overview.RepresentativeTargetID,
			ThumbnailAvailable: page.ThumbnailAvailable,
		})
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, sessionTabsResponse{
		SessionID:  overview.SessionID,
		Status:     overview.Status,
		Source:     overview.Source,
		CapturedAt: overview.CapturedAt,
		Tabs:       tabs,
	})
}

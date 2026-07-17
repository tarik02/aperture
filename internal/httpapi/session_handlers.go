package httpapi

import (
	"net/http"
	"strings"

	"github.com/aperture/aperture/internal/auth"
	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/session"
	"github.com/gin-gonic/gin"
)

func toSessionResponse(view *session.SessionView) sessionResponse {
	resp := sessionResponse{
		ID:               view.Session.ID,
		TenantID:         view.Session.TenantID,
		BaseSnapshotName: view.BaseSnapshotName,
		Label:            view.Session.Label,
		Status:           view.Session.Status,
		BrowserChannel:   view.Session.BrowserChannel,
		Media: sessionMedia{
			Mode:           view.Media.Mode,
			WebRTCProducer: view.Media.WebRTCProducer,
			ICEServers:     toICEServerResponses(view.Media.ICEServers),
		},
		CreatedAt:       view.Session.CreatedAt,
		StartedAt:       view.Session.StartedAt,
		StoppedAt:       view.Session.StoppedAt,
		DeletedAt:       view.Session.DeletedAt,
		ExpiresAt:       view.Session.ExpiresAt,
		LastConnectedAt: view.Session.LastConnectedAt,
		SuspendedAt:     view.Session.SuspendedAt,
		Tags:            view.Tags,
	}
	if view.CDPURL != "" {
		resp.CDPURL = view.CDPURL
	}
	if view.SessionToken != "" {
		resp.SessionToken = view.SessionToken

	}
	return resp
}

func toICEServerResponses(servers []config.WebRTCICEServer) []iceServerResponse {
	if len(servers) == 0 {
		return nil
	}
	responses := make([]iceServerResponse, 0, len(servers))
	for _, server := range servers {
		responses = append(responses, iceServerResponse{
			URLs:       append([]string(nil), server.URLs...),
			Username:   server.Username,
			Credential: server.Credential,
		})
	}
	return responses
}

func (s *Server) createSession(c *gin.Context) {
	if s.Sessions == nil {
		WriteError(c, errSessionServiceUnavailable)
		return
	}

	var req createSessionRequest
	if err := bindJSON(c, &req); err != nil {
		WriteError(c, err)
		return
	}

	if req.BaseSnapshotName != nil && strings.TrimSpace(*req.BaseSnapshotName) != "" {
		principal, ok := c.Get("principal")
		if !ok {
			WriteError(c, auth.ErrTokenMissing)
			return
		}
		if !auth.HasScope(principal.(auth.Principal).Scopes, auth.ScopeSnapshotsRead) {
			WriteError(c, auth.ErrScopeDenied)
			return
		}
	}

	view, err := s.Sessions.Create(c.Request.Context(), session.CreateInput{
		TenantID:         tenantIDFromContext(c),
		BaseSnapshotName: req.BaseSnapshotName,
		Label:            req.Label,
		BrowserChannel:   req.Browser.Channel,
		BrowserArgs:      req.Browser.Args,
		Tags:             req.Tags,
	})
	if err != nil {
		WriteError(c, err)
		return
	}

	c.JSON(http.StatusCreated, createSessionResponse{
		Session:      toSessionResponse(view),
		CDPURL:       view.CDPURL,
		SessionToken: view.SessionToken,
	})
}

func (s *Server) getSession(c *gin.Context) {
	if s.Sessions == nil {
		WriteError(c, errSessionServiceUnavailable)
		return
	}

	view, err := s.Sessions.Get(c.Request.Context(), tenantIDFromContext(c), c.Param("sessionId"))
	if err != nil {
		WriteError(c, err)
		return
	}

	c.JSON(http.StatusOK, toSessionResponse(view))
}

func (s *Server) deleteSession(c *gin.Context) {
	if s.Sessions == nil {
		WriteError(c, errSessionServiceUnavailable)
		return
	}

	view, err := s.Sessions.Delete(c.Request.Context(), tenantIDFromContext(c), c.Param("sessionId"))
	if err != nil {
		WriteError(c, err)
		return
	}

	c.JSON(http.StatusOK, sessionMutationResponse{
		Session: toSessionResponse(view),
	})
}

func (s *Server) replaceSessionTags(c *gin.Context) {
	if s.Sessions == nil {
		WriteError(c, errSessionServiceUnavailable)
		return
	}

	var req replaceTagsRequest
	if err := bindJSON(c, &req); err != nil {
		WriteError(c, err)
		return
	}

	view, err := s.Sessions.ReplaceTags(c.Request.Context(), tenantIDFromContext(c), c.Param("sessionId"), req.Tags)
	if err != nil {
		WriteError(c, err)
		return
	}

	c.JSON(http.StatusOK, sessionMutationResponse{
		Session: toSessionResponse(view),
	})
}

func (s *Server) suspendSession(c *gin.Context) {
	if s.Sessions == nil {
		WriteError(c, errSessionServiceUnavailable)
		return
	}

	view, err := s.Sessions.Suspend(c.Request.Context(), tenantIDFromContext(c), c.Param("sessionId"))
	if err != nil {
		WriteError(c, err)
		return
	}

	c.JSON(http.StatusOK, sessionMutationResponse{
		Session:      toSessionResponse(view),
		CDPURL:       view.CDPURL,
		SessionToken: view.SessionToken,
	})
}

func (s *Server) reopenSession(c *gin.Context) {
	if s.Sessions == nil {
		WriteError(c, errSessionServiceUnavailable)
		return
	}

	view, err := s.Sessions.Reopen(c.Request.Context(), tenantIDFromContext(c), c.Param("sessionId"))
	if err != nil {
		WriteError(c, err)
		return
	}

	c.JSON(http.StatusOK, sessionMutationResponse{
		Session:      toSessionResponse(view),
		CDPURL:       view.CDPURL,
		SessionToken: view.SessionToken,
	})
}

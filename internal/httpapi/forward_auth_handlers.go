package httpapi

import (
	"errors"
	"net/http"

	"github.com/aperture/aperture/internal/session"
	"github.com/gin-gonic/gin"
)

func (s *Server) cdpForwardAuth(c *gin.Context) {
	if s.Sessions == nil {
		c.Status(http.StatusUnauthorized)
		return
	}

	sessionID := c.Param("sessionId")
	err := s.Sessions.ValidateCDPForwardAuth(
		c.Request.Context(),
		sessionID,
		c.GetHeader("Authorization"),
	)
	if err != nil {
		status, _ := mapForwardAuthError(err)
		c.Status(status)
		return
	}

	c.Status(http.StatusOK)
}

func mapForwardAuthError(err error) (int, string) {
	switch {
	case errors.Is(err, session.ErrCDPTokenMissing), errors.Is(err, session.ErrCDPTokenInvalid), errors.Is(err, session.ErrCDPTokenRevoked):
		return http.StatusUnauthorized, err.Error()
	case errors.Is(err, session.ErrNotFound):
		return http.StatusNotFound, err.Error()
	case errors.Is(err, session.ErrNotRunning):
		return http.StatusConflict, err.Error()
	case errors.Is(err, session.ErrExpired):
		return http.StatusGone, err.Error()
	default:
		return http.StatusUnauthorized, "cdp authorization failed"
	}
}

func (s *Server) rotateCDPToken(c *gin.Context) {
	if s.Sessions == nil {
		WriteError(c, errSessionServiceUnavailable)
		return
	}

	view, err := s.Sessions.RotateCDPToken(
		c.Request.Context(),
		tenantIDFromContext(c),
		c.Param("sessionId"),
	)
	if err != nil {
		WriteError(c, err)
		return
	}

	c.JSON(http.StatusOK, sessionMutationResponse{
		Session:  toSessionResponse(view),
		CDPURL:   view.CDPURL,
		CDPToken: view.CDPToken,
	})
}

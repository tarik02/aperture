package httpapi

import (
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/aperture/aperture/internal/paths"
	"github.com/aperture/aperture/internal/sessionfiles"
	"github.com/gin-gonic/gin"
)

func (s *Server) createSessionFileDownloadURL(c *gin.Context) {
	if s.Sessions == nil {
		WriteError(c, errSessionServiceUnavailable)
		return
	}
	var request createSessionFileDownloadURLRequest
	if err := bindJSON(c, &request); err != nil {
		WriteError(c, err)
		return
	}
	if _, err := s.Sessions.Get(c.Request.Context(), tenantIDFromContext(c), c.Param("sessionId")); err != nil {
		WriteError(c, err)
		return
	}
	ttlSeconds := 0
	if request.TTLSeconds != nil {
		ttlSeconds = *request.TTLSeconds
	}
	result, err := s.sessionFileDownloadURL(c.Param("sessionId"), request.RelativePath, ttlSeconds)
	if err != nil {
		WriteError(c, err)
		return
	}
	c.JSON(http.StatusOK, result)
}

func (s *Server) sessionFileDownloadURL(sessionID, relativePath string, ttlSeconds int) (sessionFileDownloadURLResponse, error) {
	layout, err := paths.Session(s.Config, sessionID)
	if err != nil {
		return sessionFileDownloadURLResponse{}, err
	}
	_, normalized, err := sessionfiles.Resolve(layout, relativePath)
	if errors.Is(err, sessionfiles.ErrInvalidPath) {
		return sessionFileDownloadURLResponse{}, validationError("relativePath is invalid")
	}
	if errors.Is(err, sessionfiles.ErrNotFound) {
		return sessionFileDownloadURLResponse{}, errSessionFileNotFound
	}
	if err != nil {
		return sessionFileDownloadURLResponse{}, err
	}
	if ttlSeconds < 0 {
		return sessionFileDownloadURLResponse{}, validationError("ttlSeconds must be positive")
	}
	ttl := s.Config.SignedFileURLTTL
	if ttlSeconds > 0 {
		if int64(ttlSeconds) > int64(s.Config.SignedFileURLMaxTTL/time.Second) {
			return sessionFileDownloadURLResponse{}, validationError("ttlSeconds exceeds configured maximum")
		}
		ttl = time.Duration(ttlSeconds) * time.Second
	}
	if ttl <= 0 || ttl > s.Config.SignedFileURLMaxTTL {
		return sessionFileDownloadURLResponse{}, errors.New("signed file url ttl is invalid")
	}
	if s.jobToken == "" {
		return sessionFileDownloadURLResponse{}, errors.New("job token is required")
	}
	expiresAt := time.Now().UTC().Add(ttl)
	token, err := sessionfiles.IssueToken(s.jobToken, sessionID, normalized, expiresAt)
	if err != nil {
		return sessionFileDownloadURLResponse{}, err
	}
	base := strings.TrimRight(s.Config.ExternalBaseURL, "/")
	if base == "" {
		return sessionFileDownloadURLResponse{}, errors.New("external base url is required")
	}
	parts := strings.Split(normalized, "/")
	escaped := make([]string, len(parts))
	for index, part := range parts {
		escaped[index] = url.PathEscape(part)
	}
	return sessionFileDownloadURLResponse{
		URL:       base + "/sessions/" + url.PathEscape(sessionID) + "/files/" + strings.Join(escaped, "/") + "?token=" + url.QueryEscape(token),
		ExpiresAt: expiresAt,
	}, nil
}

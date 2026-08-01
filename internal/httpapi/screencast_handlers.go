package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path/filepath"

	"github.com/aperture/aperture/internal/paths"
	"github.com/aperture/aperture/internal/sessionfiles"
	"github.com/gin-gonic/gin"
)

type wrapperStoppedScreencast struct {
	Path      string `json:"path"`
	StoppedAt string `json:"stoppedAt"`
	SizeBytes int64  `json:"sizeBytes"`
}

func (s *Server) stopSessionScreencast(c *gin.Context) {
	if s.Sessions == nil {
		WriteError(c, errSessionServiceUnavailable)
		return
	}
	file, _, err := s.stopScreencast(c.Request.Context(), tenantIDFromContext(c), c.Param("sessionId"))
	if err != nil {
		WriteError(c, err)
		return
	}
	c.JSON(http.StatusOK, file)
}

func (s *Server) stopScreencast(ctx context.Context, tenantID, sessionID string) (sessionfiles.File, string, error) {
	port, err := s.Sessions.RunningWrapperPort(ctx, tenantID, sessionID)
	if err != nil {
		return sessionfiles.File{}, "", err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d/internal/screencast/stop", port), nil)
	if err != nil {
		return sessionfiles.File{}, "", fmt.Errorf("%w: %w", errBrowserControlFailed, err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return sessionfiles.File{}, "", fmt.Errorf("%w: %w", errBrowserControlFailed, err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode == http.StatusConflict {
		return sessionfiles.File{}, "", errScreencastNotActive
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		message, _ := io.ReadAll(io.LimitReader(response.Body, 64*1024))
		return sessionfiles.File{}, "", fmt.Errorf("%w: wrapper returned %s: %s", errBrowserControlFailed, response.Status, message)
	}
	var stopped wrapperStoppedScreencast
	if err := json.NewDecoder(io.LimitReader(response.Body, 64*1024)).Decode(&stopped); err != nil {
		return sessionfiles.File{}, "", fmt.Errorf("%w: %w", errBrowserControlFailed, err)
	}
	layout, err := paths.Session(s.Config, sessionID)
	if err != nil {
		return sessionfiles.File{}, "", err
	}
	relativePath, err := filepath.Rel(layout.Root, stopped.Path)
	if err != nil {
		return sessionfiles.File{}, "", fmt.Errorf("%w: %w", errBrowserControlFailed, err)
	}
	file, err := sessionfiles.Get(layout, filepath.ToSlash(relativePath))
	if err != nil {
		return sessionfiles.File{}, "", fmt.Errorf("%w: %w", errBrowserControlFailed, err)
	}
	return file, stopped.StoppedAt, nil
}

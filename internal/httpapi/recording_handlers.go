package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path/filepath"

	"github.com/aperture/aperture/internal/paths"
	"github.com/aperture/aperture/internal/sessionfiles"
	"github.com/gin-gonic/gin"
)

type wrapperStoppedRecording struct {
	Path string `json:"path"`
}

func (s *Server) stopSessionRecording(c *gin.Context) {
	if s.Sessions == nil {
		WriteError(c, errSessionServiceUnavailable)
		return
	}
	file, err := s.stopRecording(c.Request.Context(), tenantIDFromContext(c), c.Param("sessionId"), c.Param("recordingId"))
	if err != nil {
		WriteError(c, err)
		return
	}
	c.JSON(http.StatusOK, file)
}

func (s *Server) stopRecording(ctx context.Context, tenantID, sessionID, recordingID string) (sessionfiles.File, error) {
	port, err := s.Sessions.RunningWrapperPort(ctx, tenantID, sessionID)
	if err != nil {
		return sessionfiles.File{}, err
	}
	path := "/recordings/" + url.PathEscape(recordingID)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d%s/stop", port, path), nil)
	if err != nil {
		return sessionfiles.File{}, fmt.Errorf("%w: %w", errBrowserControlFailed, err)
	}
	request.Header.Set("Range", "bytes=0-0")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return sessionfiles.File{}, fmt.Errorf("%w: %w", errBrowserControlFailed, err)
	}
	if response.StatusCode == http.StatusNotFound {
		_ = response.Body.Close()
		return sessionfiles.File{}, errRecordingNotFound
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		message, _ := io.ReadAll(io.LimitReader(response.Body, 64*1024))
		_ = response.Body.Close()
		return sessionfiles.File{}, fmt.Errorf("%w: wrapper returned %s: %s", errBrowserControlFailed, response.Status, message)
	}
	_ = response.Body.Close()
	request, err = http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d%s", port, path), nil)
	if err != nil {
		return sessionfiles.File{}, fmt.Errorf("%w: %w", errBrowserControlFailed, err)
	}
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		return sessionfiles.File{}, fmt.Errorf("%w: %w", errBrowserControlFailed, err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode == http.StatusNotFound {
		return sessionfiles.File{}, errRecordingNotFound
	}
	if response.StatusCode != http.StatusOK {
		message, _ := io.ReadAll(io.LimitReader(response.Body, 64*1024))
		return sessionfiles.File{}, fmt.Errorf("%w: wrapper returned %s: %s", errBrowserControlFailed, response.Status, message)
	}
	var stopped wrapperStoppedRecording
	if err := json.NewDecoder(io.LimitReader(response.Body, 64*1024)).Decode(&stopped); err != nil {
		return sessionfiles.File{}, fmt.Errorf("%w: %w", errBrowserControlFailed, err)
	}
	layout, err := paths.Session(s.Config, sessionID)
	if err != nil {
		return sessionfiles.File{}, err
	}
	relativePath, err := filepath.Rel(layout.Root, stopped.Path)
	if err != nil {
		return sessionfiles.File{}, fmt.Errorf("%w: %w", errBrowserControlFailed, err)
	}
	file, err := sessionfiles.Get(layout, filepath.ToSlash(relativePath))
	if err != nil {
		return sessionfiles.File{}, fmt.Errorf("%w: %w", errBrowserControlFailed, err)
	}
	return file, nil
}

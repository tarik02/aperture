package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/aperture/aperture/internal/pointer"
	"github.com/gin-gonic/gin"
)

// cursorSettings is the running session's cursor state: whether the remote
// cursor is composited into media, and the default motion of pointer gestures.
type cursorSettings struct {
	Visible bool           `json:"visible"`
	Motion  pointer.Motion `json:"motion"`
}

// cursorUpdate changes the settings that are set; nil fields stay as they are.
type cursorUpdate struct {
	Visible *bool           `json:"visible,omitempty"`
	Motion  *pointer.Motion `json:"motion,omitempty"`
}

func (r cursorUpdate) Validate() error {
	if r.Visible == nil && r.Motion == nil {
		return validationError("visible or motion is required")
	}
	if r.Motion != nil {
		if err := r.Motion.Validate(); err != nil {
			return validationError(err.Error())
		}
	}
	return nil
}

func (s *Server) getSessionCursor(c *gin.Context) {
	settings, err := s.sessionCursorSettings(
		c.Request.Context(),
		tenantIDFromContext(c),
		c.Param("sessionId"),
		http.MethodGet,
		nil,
	)
	if err != nil {
		WriteError(c, err)
		return
	}
	c.JSON(http.StatusOK, settings)
}

func (s *Server) setSessionCursor(c *gin.Context) {
	var request cursorUpdate
	if err := bindJSON(c, &request); err != nil {
		WriteError(c, err)
		return
	}
	settings, err := s.sessionCursorSettings(
		c.Request.Context(),
		tenantIDFromContext(c),
		c.Param("sessionId"),
		http.MethodPut,
		&request,
	)
	if err != nil {
		WriteError(c, err)
		return
	}
	c.JSON(http.StatusOK, settings)
}

func (s *Server) sessionCursorSettings(ctx context.Context, tenantID, sessionID, method string, update *cursorUpdate) (cursorSettings, error) {
	if s.Sessions == nil {
		return cursorSettings{}, errSessionServiceUnavailable
	}
	port, err := s.Sessions.RunningWrapperPort(ctx, tenantID, sessionID)
	if err != nil {
		return cursorSettings{}, err
	}
	return cursorSettingsRequest(ctx, port, method, update)
}

func cursorSettingsRequest(ctx context.Context, port int, method string, update *cursorUpdate) (cursorSettings, error) {
	var body io.Reader
	if update != nil {
		encoded, err := json.Marshal(update)
		if err != nil {
			return cursorSettings{}, fmt.Errorf("%w: %w", errBrowserControlFailed, err)
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, fmt.Sprintf("http://127.0.0.1:%d/cursor", port), body)
	if err != nil {
		return cursorSettings{}, fmt.Errorf("%w: %w", errBrowserControlFailed, err)
	}
	if update != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return cursorSettings{}, fmt.Errorf("%w: %w", errBrowserControlFailed, err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		message, _ := io.ReadAll(io.LimitReader(response.Body, 64*1024))
		if response.StatusCode == http.StatusConflict {
			// The wrapper refuses only visibility, and only in a session without a compositor.
			return cursorSettings{}, errCursorNeedsCompositor
		}
		return cursorSettings{}, fmt.Errorf("%w: wrapper returned %s: %s", errBrowserControlFailed, response.Status, message)
	}
	var settings cursorSettings
	if err := json.NewDecoder(io.LimitReader(response.Body, 64*1024)).Decode(&settings); err != nil {
		return cursorSettings{}, fmt.Errorf("%w: %w", errBrowserControlFailed, err)
	}
	return settings, nil
}

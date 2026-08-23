package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/gin-gonic/gin"
)

type cursorVisibility struct {
	Visible bool `json:"visible"`
}

type setCursorVisibilityRequest struct {
	Visible *bool `json:"visible"`
}

func (r setCursorVisibilityRequest) Validate() error {
	if r.Visible == nil {
		return validationError("visible is required")
	}
	return nil
}

func (s *Server) getSessionCursor(c *gin.Context) {
	visibility, err := s.sessionCursorVisibility(
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
	c.JSON(http.StatusOK, visibility)
}

func (s *Server) setSessionCursor(c *gin.Context) {
	var request setCursorVisibilityRequest
	if err := bindJSON(c, &request); err != nil {
		WriteError(c, err)
		return
	}
	visibility, err := s.sessionCursorVisibility(
		c.Request.Context(),
		tenantIDFromContext(c),
		c.Param("sessionId"),
		http.MethodPut,
		request.Visible,
	)
	if err != nil {
		WriteError(c, err)
		return
	}
	c.JSON(http.StatusOK, visibility)
}

func (s *Server) sessionCursorVisibility(ctx context.Context, tenantID, sessionID, method string, visible *bool) (cursorVisibility, error) {
	if s.Sessions == nil {
		return cursorVisibility{}, errSessionServiceUnavailable
	}
	port, err := s.Sessions.RunningWrapperPort(ctx, tenantID, sessionID)
	if err != nil {
		return cursorVisibility{}, err
	}
	return cursorVisibilityRequest(ctx, port, method, visible)
}

func cursorVisibilityRequest(ctx context.Context, port int, method string, visible *bool) (cursorVisibility, error) {
	var body io.Reader
	if visible != nil {
		encoded, err := json.Marshal(cursorVisibility{Visible: *visible})
		if err != nil {
			return cursorVisibility{}, fmt.Errorf("%w: %w", errBrowserControlFailed, err)
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, fmt.Sprintf("http://127.0.0.1:%d/cursor", port), body)
	if err != nil {
		return cursorVisibility{}, fmt.Errorf("%w: %w", errBrowserControlFailed, err)
	}
	if visible != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return cursorVisibility{}, fmt.Errorf("%w: %w", errBrowserControlFailed, err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		message, _ := io.ReadAll(io.LimitReader(response.Body, 64*1024))
		return cursorVisibility{}, fmt.Errorf("%w: wrapper returned %s: %s", errBrowserControlFailed, response.Status, message)
	}
	var visibility cursorVisibility
	if err := json.NewDecoder(io.LimitReader(response.Body, 64*1024)).Decode(&visibility); err != nil {
		return cursorVisibility{}, fmt.Errorf("%w: %w", errBrowserControlFailed, err)
	}
	return visibility, nil
}

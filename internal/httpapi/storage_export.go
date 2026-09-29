package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"

	"github.com/aperture/aperture/internal/browser"
	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

func (s *Server) exportSessionStorageState(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	body, err := io.ReadAll(io.LimitReader(c.Request.Body, browser.MaxStorageExportRequestBytes+1))
	if err != nil {
		WriteError(c, errRequestDecode)
		return
	}
	if len(body) > browser.MaxStorageExportRequestBytes {
		WriteError(c, validationError("storage export request exceeds 256 KiB"))
		return
	}
	if !json.Valid(body) {
		WriteError(c, errRequestDecode)
		return
	}
	if s.Sessions == nil {
		WriteError(c, errSessionServiceUnavailable)
		return
	}
	sessionID := c.Param("sessionId")
	// The API error stays generic; the reason, which the worker has stripped of URLs
	// and paths, is only logged.
	controlFailed := func(reason error) {
		if s.Logger != nil {
			s.Logger.Warn("storage export failed", zap.String("session_id", sessionID), zap.Error(reason))
		}
		WriteError(c, fmt.Errorf("%w: %w", errBrowserControlFailed, reason))
	}
	port, token, release, err := s.Sessions.AcquireRunningWrapperControl(c.Request.Context(), tenantIDFromContext(c), sessionID)
	if err != nil {
		WriteError(c, err)
		return
	}
	defer release()
	request, err := http.NewRequestWithContext(c.Request.Context(), http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d/storage-state", port), bytes.NewReader(body))
	if err != nil {
		controlFailed(err)
		return
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		controlFailed(err)
		return
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		message, _ := io.ReadAll(io.LimitReader(response.Body, 64*1024))
		switch response.StatusCode {
		case http.StatusBadRequest:
			WriteError(c, validationError(wrapperErrorMessage(message)))
		case http.StatusUnprocessableEntity:
			WriteError(c, fmt.Errorf("%w: %s", errStorageExportUnsupported, wrapperErrorMessage(message)))
		default:
			controlFailed(fmt.Errorf("wrapper returned %s: %s", response.Status, wrapperErrorMessage(message)))
		}
		return
	}
	result, err := io.ReadAll(io.LimitReader(response.Body, browser.MaxSessionInitializationBytes+1))
	switch {
	case err != nil:
		controlFailed(fmt.Errorf("read wrapper response: %w", err))
	case len(result) > browser.MaxSessionInitializationBytes:
		controlFailed(errors.New("wrapper response exceeds 64 MiB"))
	case !json.Valid(result):
		controlFailed(errors.New("wrapper returned invalid JSON"))
	default:
		c.Data(http.StatusOK, "application/json", result)
	}
}

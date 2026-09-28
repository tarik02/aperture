package httpapi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/aperture/aperture/internal/browser"
	"github.com/gin-gonic/gin"
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
	port, token, release, err := s.Sessions.AcquireRunningWrapperControl(c.Request.Context(), tenantIDFromContext(c), c.Param("sessionId"))
	if err != nil {
		WriteError(c, err)
		return
	}
	defer release()
	request, err := http.NewRequestWithContext(c.Request.Context(), http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d/storage-state", port), bytes.NewReader(body))
	if err != nil {
		WriteError(c, errBrowserControlFailed)
		return
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		WriteError(c, fmt.Errorf("%w: %w", errBrowserControlFailed, err))
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
			WriteError(c, fmt.Errorf("%w: wrapper returned %s", errBrowserControlFailed, response.Status))
		}
		return
	}
	result, err := io.ReadAll(io.LimitReader(response.Body, browser.MaxSessionInitializationBytes+1))
	if err != nil || len(result) > browser.MaxSessionInitializationBytes || !json.Valid(result) {
		WriteError(c, errBrowserControlFailed)
		return
	}
	c.Data(http.StatusOK, "application/json", result)
}

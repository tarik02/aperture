package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/aperture/aperture/internal/paths"
	"github.com/aperture/aperture/internal/sessionfiles"
	"github.com/gin-gonic/gin"
)

type wrapperRecordingStatus struct {
	RecordingID       string `json:"recordingId"`
	Mode              string `json:"mode"`
	TargetID          string `json:"targetId"`
	CaptureGeneration uint64 `json:"captureGeneration"`
	Status            string `json:"status"`
	StopReason        string `json:"stopReason,omitempty"`
	Path              string `json:"path"`
	StartedAt         string `json:"startedAt"`
	StoppedAt         string `json:"stoppedAt,omitempty"`
	SizeBytes         int64  `json:"sizeBytes,omitempty"`
	FPS               int    `json:"fps"`
	BitrateKbps       int    `json:"bitrateKbps"`
	Codec             string `json:"codec"`
}

type recordingResponse struct {
	RecordingID       string `json:"recordingId"`
	Mode              string `json:"mode"`
	TargetID          string `json:"targetId"`
	CaptureGeneration uint64 `json:"captureGeneration"`
	Status            string `json:"status"`
	StopReason        string `json:"stopReason,omitempty"`
	RelativePath      string `json:"relativePath"`
	StartedAt         string `json:"startedAt"`
	StoppedAt         string `json:"stoppedAt,omitempty"`
	SizeBytes         int64  `json:"sizeBytes,omitempty"`
	FPS               int    `json:"fps"`
	BitrateKbps       int    `json:"bitrateKbps"`
	Codec             string `json:"codec"`
}

type createSessionRecordingRequest struct {
	TargetID    string `json:"targetId"`
	FPS         int    `json:"fps"`
	BitrateKbps int    `json:"bitrateKbps"`
	Codec       string `json:"codec"`
}

func (r createSessionRecordingRequest) Validate() error {
	if strings.TrimSpace(r.TargetID) == "" {
		return validationError("targetId is required")
	}
	if r.Codec != "" && r.Codec != "vp8" && r.Codec != "h264-va" {
		return validationError("codec must be vp8 or h264-va")
	}
	return nil
}

type retargetSessionRecordingRequest struct {
	TargetID string `json:"targetId"`
}

func (r retargetSessionRecordingRequest) Validate() error {
	if strings.TrimSpace(r.TargetID) == "" {
		return validationError("targetId is required")
	}
	return nil
}

type wrapperRecordingRequestError struct {
	StatusCode int
	Status     string
	Message    string
}

func (e *wrapperRecordingRequestError) Error() string {
	return fmt.Sprintf("wrapper returned %s: %s", e.Status, e.Message)
}

func (s *Server) createSessionRecording(c *gin.Context) {
	var input createSessionRecordingRequest
	if err := bindJSON(c, &input); err != nil {
		WriteError(c, err)
		return
	}
	var status wrapperRecordingStatus
	err := s.sessionRecordingRequest(c.Request.Context(), tenantIDFromContext(c), c.Param("sessionId"), http.MethodPost, "/recordings", map[string]any{
		"mode": "tab", "targetId": input.TargetID, "fps": input.FPS, "bitrateKbps": input.BitrateKbps, "codec": input.Codec,
	}, false, &status)
	if err != nil {
		WriteError(c, err)
		return
	}
	response, err := s.recordingResponse(c.Param("sessionId"), status)
	if err != nil {
		WriteError(c, err)
		return
	}
	c.JSON(http.StatusCreated, response)
}

func (s *Server) listSessionRecordings(c *gin.Context) {
	var statuses []wrapperRecordingStatus
	if err := s.sessionRecordingRequest(c.Request.Context(), tenantIDFromContext(c), c.Param("sessionId"), http.MethodGet, "/recordings", nil, false, &statuses); err != nil {
		WriteError(c, err)
		return
	}
	recordings := make([]recordingResponse, 0, len(statuses))
	for _, status := range statuses {
		response, err := s.recordingResponse(c.Param("sessionId"), status)
		if err != nil {
			WriteError(c, err)
			return
		}
		recordings = append(recordings, response)
	}
	c.JSON(http.StatusOK, recordings)
}

func (s *Server) getSessionRecording(c *gin.Context) {
	status, err := s.getRecording(c.Request.Context(), tenantIDFromContext(c), c.Param("sessionId"), c.Param("recordingId"))
	if err != nil {
		WriteError(c, err)
		return
	}
	response, err := s.recordingResponse(c.Param("sessionId"), status)
	if err != nil {
		WriteError(c, err)
		return
	}
	c.JSON(http.StatusOK, response)
}

func (s *Server) retargetSessionRecording(c *gin.Context) {
	var input retargetSessionRecordingRequest
	if err := bindJSON(c, &input); err != nil {
		WriteError(c, err)
		return
	}
	var status wrapperRecordingStatus
	path := "/recordings/" + url.PathEscape(c.Param("recordingId")) + "/retarget"
	if err := s.sessionRecordingRequest(c.Request.Context(), tenantIDFromContext(c), c.Param("sessionId"), http.MethodPost, path, input, false, &status); err != nil {
		WriteError(c, err)
		return
	}
	response, err := s.recordingResponse(c.Param("sessionId"), status)
	if err != nil {
		WriteError(c, err)
		return
	}
	c.JSON(http.StatusOK, response)
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
	path := "/recordings/" + url.PathEscape(recordingID)
	if err := s.sessionRecordingRequest(ctx, tenantID, sessionID, http.MethodPost, path+"/stop", nil, true, nil); err != nil {
		return sessionfiles.File{}, err
	}
	status, err := s.getRecording(ctx, tenantID, sessionID, recordingID)
	if err != nil {
		return sessionfiles.File{}, err
	}
	relativePath, err := s.recordingRelativePath(sessionID, status.Path)
	if err != nil {
		return sessionfiles.File{}, err
	}
	view, err := s.Sessions.Get(ctx, tenantID, sessionID)
	if err != nil {
		return sessionfiles.File{}, err
	}
	scope, err := s.sessionFilesScope(view.Session)
	if err != nil {
		return sessionfiles.File{}, err
	}
	file, err := sessionfiles.Get(scope.layout, relativePath)
	if err != nil {
		return sessionfiles.File{}, fmt.Errorf("%w: %w", errBrowserControlFailed, err)
	}
	return scope.presentFile(file), nil
}

func (s *Server) getRecording(ctx context.Context, tenantID, sessionID, recordingID string) (wrapperRecordingStatus, error) {
	var status wrapperRecordingStatus
	path := "/recordings/" + url.PathEscape(recordingID)
	if err := s.sessionRecordingRequest(ctx, tenantID, sessionID, http.MethodGet, path, nil, false, &status); err != nil {
		return wrapperRecordingStatus{}, err
	}
	return status, nil
}

func (s *Server) sessionRecordingRequest(ctx context.Context, tenantID, sessionID, method, path string, body any, stop bool, output any) error {
	if s.Sessions == nil {
		return errSessionServiceUnavailable
	}
	port, err := s.Sessions.RunningWrapperPort(ctx, tenantID, sessionID)
	if err != nil {
		return err
	}
	if err := requestWrapperRecording(ctx, port, method, path, body, stop, output); err != nil {
		return mapWrapperRecordingRequestError(err)
	}
	return nil
}

func requestWrapperRecording(ctx context.Context, port int, method, path string, body any, stop bool, output any) error {
	var requestBody io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("encode wrapper recording request: %w", err)
		}
		requestBody = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, fmt.Sprintf("http://127.0.0.1:%d%s", port, path), requestBody)
	if err != nil {
		return fmt.Errorf("create wrapper recording request: %w", err)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if stop {
		request.Header.Set("Range", "bytes=0-0")
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return fmt.Errorf("send wrapper recording request: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		message, _ := io.ReadAll(io.LimitReader(response.Body, 64*1024))
		return &wrapperRecordingRequestError{StatusCode: response.StatusCode, Status: response.Status, Message: wrapperRecordingErrorMessage(message)}
	}
	if output == nil {
		return nil
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1024*1024)).Decode(output); err != nil {
		return fmt.Errorf("decode wrapper recording response: %w", err)
	}
	return nil
}

func mapWrapperRecordingRequestError(err error) error {
	var responseErr *wrapperRecordingRequestError
	if !errors.As(err, &responseErr) {
		return fmt.Errorf("%w: %w", errBrowserControlFailed, err)
	}
	switch responseErr.StatusCode {
	case http.StatusNotFound:
		return errRecordingNotFound
	case http.StatusConflict:
		return fmt.Errorf("%w: %s", errRecordingInvalidState, responseErr.Message)
	default:
		return fmt.Errorf("%w: %w", errBrowserControlFailed, err)
	}
}

func wrapperRecordingErrorMessage(body []byte) string {
	var response struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(body, &response) == nil && response.Error != "" {
		return response.Error
	}
	return strings.TrimSpace(string(body))
}

func (s *Server) recordingResponse(sessionID string, status wrapperRecordingStatus) (recordingResponse, error) {
	relativePath, err := s.recordingRelativePath(sessionID, status.Path)
	if err != nil {
		return recordingResponse{}, err
	}
	return recordingResponse{
		RecordingID: status.RecordingID, Mode: status.Mode, TargetID: status.TargetID, CaptureGeneration: status.CaptureGeneration,
		Status: status.Status, StopReason: status.StopReason, StartedAt: status.StartedAt, StoppedAt: status.StoppedAt,
		RelativePath: relativePath, SizeBytes: status.SizeBytes, FPS: status.FPS, BitrateKbps: status.BitrateKbps, Codec: status.Codec,
	}, nil
}

func (s *Server) recordingRelativePath(sessionID, path string) (string, error) {
	layout, err := paths.Session(s.Config, sessionID)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(path) == "" {
		return "", fmt.Errorf("%w: wrapper returned an empty recording path", errBrowserControlFailed)
	}
	relativePath, err := sessionfiles.RelativePath(layout, path)
	if err != nil || !strings.HasPrefix(relativePath, "recordings/") {
		return "", fmt.Errorf("%w: invalid wrapper recording path %q", errBrowserControlFailed, relativePath)
	}
	return relativePath, nil
}

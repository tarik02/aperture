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
	"path"
	"strings"
	"time"

	"github.com/aperture/aperture/internal/browser"
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
	RelativePath      string `json:"relativePath"`
	// TimelineRelativePath is set once a stopped recording has a timeline file.
	TimelineRelativePath string `json:"timelineRelativePath,omitempty"`
	// Path is the host path wrappers reported before they reported relativePath.
	Path        string `json:"path"`
	StartedAt   string `json:"startedAt"`
	StoppedAt   string `json:"stoppedAt,omitempty"`
	SizeBytes   int64  `json:"sizeBytes,omitempty"`
	FPS         int    `json:"fps"`
	BitrateKbps int    `json:"bitrateKbps"`
	Codec       string `json:"codec"`

	browser.RecordingEdit
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

	// TimelineRelativePath names the timeline file of a stopped recording, when it has one.
	TimelineRelativePath string `json:"timelineRelativePath,omitempty"`

	browser.RecordingEdit
}

type createSessionRecordingRequest struct {
	TargetID    string `json:"targetId"`
	FPS         int    `json:"fps"`
	BitrateKbps int    `json:"bitrateKbps"`
	Codec       string `json:"codec"`
	Idle        string `json:"idle"`
	Zoom        any    `json:"zoom"`
	Ripple      bool   `json:"ripple"`
	Capture     string `json:"capture"`

	Burst *browser.RecordingBurst `json:"burst"`
}

func (r createSessionRecordingRequest) Validate() error {
	if strings.TrimSpace(r.TargetID) == "" {
		return validationError("targetId is required")
	}
	if r.Codec != "" && r.Codec != "vp8" && r.Codec != "h264-va" {
		return validationError("codec must be vp8 or h264-va")
	}
	if err := browser.ValidateRecordingEffects(r.Idle, r.Zoom, r.Capture, r.Burst); err != nil {
		return validationError(err.Error())
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
		"idle": input.Idle, "zoom": input.Zoom, "ripple": input.Ripple, "capture": input.Capture, "burst": input.Burst,
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

func (s *Server) stopRecording(ctx context.Context, tenantID, sessionID, recordingID string) (stoppedRecording, error) {
	endpoint := "/recordings/" + url.PathEscape(recordingID)
	if err := s.sessionRecordingRequest(ctx, tenantID, sessionID, http.MethodPost, endpoint+"/stop?render=1", nil, true, nil); err != nil {
		return stoppedRecording{}, err
	}
	status, err := s.getRecording(ctx, tenantID, sessionID, recordingID)
	if err != nil {
		return stoppedRecording{}, err
	}
	edit, err := recordingEdit(status)
	if err != nil {
		return stoppedRecording{}, err
	}
	relativePath, err := s.recordingRelativePath(sessionID, status)
	if err != nil {
		return stoppedRecording{}, err
	}
	view, err := s.Sessions.Get(ctx, tenantID, sessionID)
	if err != nil {
		return stoppedRecording{}, err
	}
	scope, err := s.sessionFilesScope(view.Session)
	if err != nil {
		return stoppedRecording{}, err
	}
	stoppedAt, err := time.Parse(time.RFC3339Nano, status.StoppedAt)
	if err != nil {
		return stoppedRecording{}, fmt.Errorf("%w: invalid recording stop time: %w", errBrowserControlFailed, err)
	}
	// Built from what the wrapper measured when it published the file rather than
	// looked up again, because the file may be moved as soon as it is visible.
	mimeType := "video/webm"
	if status.Codec == "h264-va" {
		mimeType = "video/x-matroska"
	}
	file := scope.presentFile(sessionfiles.File{
		Type:         sessionfiles.EntryFile,
		Name:         path.Base(relativePath),
		RelativePath: relativePath,
		Size:         status.SizeBytes,
		ModifiedAt:   stoppedAt.UTC(),
		MIMEType:     mimeType,
		SandboxPath:  sessionfiles.SandboxPath(relativePath),
	})
	return stoppedRecording{File: file, RecordingEdit: edit}, nil
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
		return &wrapperRecordingRequestError{StatusCode: response.StatusCode, Status: response.Status, Message: wrapperErrorMessage(message)}
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
	case http.StatusUnprocessableEntity:
		return fmt.Errorf("%w: %s", errRecordingCodecUnavailable, responseErr.Message)
	case http.StatusNotImplemented:
		return fmt.Errorf("%w: %s", errRecordingEffectsUnavailable, responseErr.Message)
	default:
		return fmt.Errorf("%w: %w", errBrowserControlFailed, err)
	}
}

func wrapperErrorMessage(body []byte) string {
	var response struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(body, &response) == nil && response.Error != "" {
		return response.Error
	}
	return strings.TrimSpace(string(body))
}

func (s *Server) recordingResponse(sessionID string, status wrapperRecordingStatus) (recordingResponse, error) {
	relativePath, err := s.recordingRelativePath(sessionID, status)
	if err != nil {
		return recordingResponse{}, err
	}
	timelinePath, err := recordingTimelinePath(status)
	if err != nil {
		return recordingResponse{}, err
	}
	edit, err := recordingEdit(status)
	if err != nil {
		return recordingResponse{}, err
	}
	return recordingResponse{
		RecordingEdit: edit,
		RecordingID:   status.RecordingID, Mode: status.Mode, TargetID: status.TargetID, CaptureGeneration: status.CaptureGeneration,
		Status: status.Status, StopReason: status.StopReason, StartedAt: status.StartedAt, StoppedAt: status.StoppedAt,
		RelativePath: relativePath, SizeBytes: status.SizeBytes, FPS: status.FPS, BitrateKbps: status.BitrateKbps, Codec: status.Codec,
		TimelineRelativePath: timelinePath,
	}, nil
}

// recordingTimelinePath validates the timeline path a wrapper reports, which is empty
// until the recording has stopped with one.
func recordingTimelinePath(status wrapperRecordingStatus) (string, error) {
	if status.TimelineRelativePath == "" {
		return "", nil
	}
	return recordingFilePath(status.TimelineRelativePath)
}

func recordingFilePath(reported string) (string, error) {
	relativePath, err := sessionfiles.Normalize(reported)
	if err != nil || !strings.HasPrefix(relativePath, "recordings/") {
		return "", fmt.Errorf("%w: invalid wrapper recording path %q", errBrowserControlFailed, reported)
	}
	return relativePath, nil
}

func (s *Server) recordingRelativePath(sessionID string, status wrapperRecordingStatus) (string, error) {
	if status.RelativePath != "" {
		return recordingFilePath(status.RelativePath)
	}
	layout, err := paths.Session(s.Config, sessionID)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(status.Path) == "" {
		return "", fmt.Errorf("%w: wrapper returned an empty recording path", errBrowserControlFailed)
	}
	relativePath, err := sessionfiles.RelativePath(layout, status.Path)
	if err != nil || !strings.HasPrefix(relativePath, "recordings/") {
		return "", fmt.Errorf("%w: invalid wrapper recording path %q", errBrowserControlFailed, relativePath)
	}
	return relativePath, nil
}

package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/aperture/aperture/internal/paths"
	"github.com/aperture/aperture/internal/recording"
	"github.com/aperture/aperture/internal/sessionfiles"
	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

// recordingEdit is what a stop makes of a recording. Editing says the edit still runs; the other
// fields are filled once it is over. The raw video is always the recording's own path.
type recordingEdit struct {
	Editing              bool                 `json:"editing"`
	EditedRelativePath   string               `json:"editedRelativePath,omitempty"`
	TimelineRelativePath string               `json:"timelineRelativePath,omitempty"`
	EditError            *recording.EditError `json:"editError,omitempty"`
}

// wrapperRecordingStart is the body of a start request to the wrapper.
type wrapperRecordingStart struct {
	Mode        string `json:"mode"`
	TargetID    string `json:"targetId"`
	FPS         int    `json:"fps"`
	BitrateKbps int    `json:"bitrateKbps"`
	Codec       string `json:"codec"`
	recording.Config
}

type wrapperRecordingStatus struct {
	RecordingID       string `json:"recordingId"`
	Mode              string `json:"mode"`
	TargetID          string `json:"targetId"`
	CaptureGeneration uint64 `json:"captureGeneration"`
	Status            string `json:"status"`
	StopReason        string `json:"stopReason,omitempty"`
	RelativePath      string `json:"relativePath"`
	// Path is the host path wrappers reported before they reported relativePath.
	Path        string `json:"path"`
	StartedAt   string `json:"startedAt"`
	StoppedAt   string `json:"stoppedAt,omitempty"`
	SizeBytes   int64  `json:"sizeBytes,omitempty"`
	FPS         int    `json:"fps"`
	BitrateKbps int    `json:"bitrateKbps"`
	Codec       string `json:"codec"`
	recordingEdit
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
	recordingEdit
}

type createSessionRecordingRequest struct {
	TargetID    string `json:"targetId"`
	FPS         int    `json:"fps"`
	BitrateKbps int    `json:"bitrateKbps"`
	Codec       string `json:"codec"`
	recording.Config
}

func (r *createSessionRecordingRequest) Validate() error {
	if strings.TrimSpace(r.TargetID) == "" {
		return validationError("targetId is required")
	}
	if r.Codec != "" && r.Codec != "vp8" && r.Codec != "h264-va" {
		return validationError("codec must be vp8 or h264-va")
	}
	return r.Config.Validate()
}

// checkRecordingConfig rejects a config the instance cannot honour before a session is woken for
// it: the wrapper edits with the ffmpeg this daemon names.
func (s *Server) checkRecordingConfig(cfg *recording.Config) error {
	if err := cfg.Validate(); err != nil {
		return err
	}
	if cfg.Edits() && s.Config.RecordingFFmpegExecutable == "" {
		return recording.ErrFFmpegRequired
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

func (s *Server) createSessionRecording(c *gin.Context) {
	var input createSessionRecordingRequest
	if err := bindJSON(c, &input); err != nil {
		WriteError(c, err)
		return
	}
	if err := s.checkRecordingConfig(&input.Config); err != nil {
		WriteError(c, err)
		return
	}
	var status wrapperRecordingStatus
	err := s.sessionRecordingRequest(c.Request.Context(), tenantIDFromContext(c), c.Param("sessionId"), http.MethodPost, "/recordings", wrapperRecordingStart{
		Mode: "tab", TargetID: input.TargetID, FPS: input.FPS, BitrateKbps: input.BitrateKbps, Codec: input.Codec, Config: input.Config,
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

// stopSessionRecording returns as soon as the raw video is published; the recording is editing
// until its edit is over.
func (s *Server) stopSessionRecording(c *gin.Context) {
	status, err := s.stopRecording(c.Request.Context(), tenantIDFromContext(c), c.Param("sessionId"), c.Param("recordingId"))
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

// stopRecording stops a recording and reads it back: the wrapper's stop answers with the video,
// which the daemon does not need.
func (s *Server) stopRecording(ctx context.Context, tenantID, sessionID, recordingID string) (wrapperRecordingStatus, error) {
	endpoint := "/recordings/" + url.PathEscape(recordingID)
	if err := s.sessionRecordingRequest(ctx, tenantID, sessionID, http.MethodPost, endpoint+"/stop", nil, true, nil); err != nil {
		return wrapperRecordingStatus{}, err
	}
	return s.getRecording(ctx, tenantID, sessionID, recordingID)
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
	return requestWrapperRecording(ctx, port, method, path, body, stop, output)
}

// requestWrapperRecording calls the wrapper's recording API and turns its refusals into the errors
// every surface maps to its own codes: 400 is an invalid request, 404 an unknown recording, 409 a
// recording in the wrong state, 422 a codec the host lacks, anything else a failed browser control.
func requestWrapperRecording(ctx context.Context, port int, method, path string, body any, stop bool, output any) error {
	var requestBody io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("%w: encode wrapper recording request: %w", errBrowserControlFailed, err)
		}
		requestBody = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, fmt.Sprintf("http://127.0.0.1:%d%s", port, path), requestBody)
	if err != nil {
		return fmt.Errorf("%w: create wrapper recording request: %w", errBrowserControlFailed, err)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if stop {
		request.Header.Set("Range", "bytes=0-0")
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return fmt.Errorf("%w: send wrapper recording request: %w", errBrowserControlFailed, err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		message, _ := io.ReadAll(io.LimitReader(response.Body, 64*1024))
		return mapWrapperRecordingStatus(response.StatusCode, wrapperErrorMessage(message))
	}
	if output == nil {
		return nil
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1024*1024)).Decode(output); err != nil {
		return fmt.Errorf("%w: decode wrapper recording response: %w", errBrowserControlFailed, err)
	}
	return nil
}

func mapWrapperRecordingStatus(statusCode int, message string) error {
	switch statusCode {
	case http.StatusBadRequest:
		return fmt.Errorf("%w: %s", recording.ErrInvalid, message)
	case http.StatusNotFound:
		return errRecordingNotFound
	case http.StatusConflict:
		return fmt.Errorf("%w: %s", errRecordingInvalidState, message)
	case http.StatusUnprocessableEntity:
		return fmt.Errorf("%w: %s", errRecordingCodecUnavailable, message)
	default:
		return fmt.Errorf("%w: wrapper returned %d: %s", errBrowserControlFailed, statusCode, message)
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
	return recordingResponse{
		recordingEdit: s.recordingEdit(status), RecordingID: status.RecordingID, Mode: status.Mode, TargetID: status.TargetID, CaptureGeneration: status.CaptureGeneration,
		Status: status.Status, StopReason: status.StopReason, StartedAt: status.StartedAt, StoppedAt: status.StoppedAt,
		RelativePath: relativePath, SizeBytes: status.SizeBytes, FPS: status.FPS, BitrateKbps: status.BitrateKbps, Codec: status.Codec,
	}, nil
}

// recordingFilePath checks a path the wrapper reports: the video and its edit are published
// below recordings/.
func recordingFilePath(relativePath string) (string, error) {
	clean, err := sessionfiles.Normalize(relativePath)
	if err != nil || !strings.HasPrefix(clean, "recordings/") {
		return "", fmt.Errorf("%w: invalid wrapper recording path %q", errBrowserControlFailed, relativePath)
	}
	return clean, nil
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
	if err != nil {
		return "", fmt.Errorf("%w: invalid wrapper recording path %q", errBrowserControlFailed, status.Path)
	}
	return recordingFilePath(relativePath)
}

// recordingEdit takes the edit the wrapper reports. A path it should never produce is dropped
// and logged rather than failing the recording: the video is still there.
func (s *Server) recordingEdit(status wrapperRecordingStatus) recordingEdit {
	edit := status.recordingEdit
	for _, relativePath := range []*string{&edit.EditedRelativePath, &edit.TimelineRelativePath} {
		if *relativePath == "" {
			continue
		}
		clean, err := recordingFilePath(*relativePath)
		if err != nil && s.Logger != nil {
			s.Logger.Warn("dropped recording edit path", zap.String("recordingId", status.RecordingID), zap.Error(err))
		}
		*relativePath = clean
	}
	return edit
}

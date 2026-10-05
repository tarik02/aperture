package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/aperture/aperture/internal/recording"
	"github.com/aperture/aperture/internal/session"
	"github.com/gin-gonic/gin"
)

func (s *Server) captionSessionRecording(c *gin.Context) {
	var input recording.Caption
	if err := bindJSON(c, &input); err != nil {
		WriteError(c, err)
		return
	}
	input.RecordingID = c.Param("recordingId")
	s.writeRecordingAnnotation(c, "caption", input)
}

func (s *Server) focusSessionRecording(c *gin.Context) {
	var input recording.Focus
	if err := bindJSON(c, &input); err != nil {
		WriteError(c, err)
		return
	}
	input.RecordingID = c.Param("recordingId")
	s.writeRecordingAnnotation(c, "focus", input)
}

// resetFocusSessionRecording takes no body: the path names everything a reset needs.
func (s *Server) resetFocusSessionRecording(c *gin.Context) {
	s.writeRecordingAnnotation(c, "reset_focus", recording.ResetFocus{RecordingID: c.Param("recordingId")})
}

func (s *Server) attentionSessionRecording(c *gin.Context) {
	var input recording.Attention
	if err := bindJSON(c, &input); err != nil {
		WriteError(c, err)
		return
	}
	input.RecordingID = c.Param("recordingId")
	s.writeRecordingAnnotation(c, "attention", input)
}

func (s *Server) writeRecordingAnnotation(c *gin.Context, kind string, input any) {
	if err := s.recordingAnnotation(c.Request.Context(), tenantIDFromContext(c), c.Param("sessionId"), kind, input); err != nil {
		WriteError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

// Annotations need an existing running capture; they never wake a suspended browser.
func (s *Server) recordingAnnotation(ctx context.Context, tenantID, sessionID, kind string, input any) error {
	if (kind == "caption" || kind == "focus") && s.Config.RecordingFFmpegExecutable == "" {
		return recording.ErrFFmpegRequired
	}
	port, _, release, err := s.Sessions.AcquireRunningWrapperControl(ctx, tenantID, sessionID)
	if errors.Is(err, session.ErrNotRunning) {
		return fmt.Errorf("%w: no running recording", errRecordingInvalidState)
	}
	if err != nil {
		return err
	}
	defer release()
	return requestWrapperRecording(ctx, port, http.MethodPost, "/recordings/annotations/"+kind, input, false, nil)
}

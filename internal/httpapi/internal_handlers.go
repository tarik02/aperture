package httpapi

import (
	"net"
	"net/http"
	"strings"

	"github.com/aperture/aperture/internal/ids"
	"github.com/aperture/aperture/internal/session"
	"github.com/gin-gonic/gin"
)

const maxSessionUploadEventFiles = 100

type gcJobResponse struct {
	ExpiredSessions    int `json:"expiredSessions"`
	RemovedArtifacts   int `json:"removedArtifacts"`
	CollectedSnapshots int `json:"collectedSnapshots"`
}

type sessionUploadEventFile struct {
	EventID   string `json:"eventId"`
	Path      string `json:"path"`
	SizeBytes int64  `json:"sizeBytes"`
}

type sessionUploadPrepareRequest struct {
	Files     []sessionUploadEventFile `json:"files"`
	ActorKind string                   `json:"actorKind"`
	ClientIP  string                   `json:"clientIp"`
}

func (r sessionUploadPrepareRequest) Validate() error {
	if len(r.Files) == 0 || len(r.Files) > maxSessionUploadEventFiles {
		return validationError("invalid upload files")
	}
	eventIDs := make(map[string]struct{}, len(r.Files))
	for _, file := range r.Files {
		if ids.ValidateUUIDv7(file.EventID) != nil || !strings.HasPrefix(file.Path, "uploads/") || strings.Count(file.Path, "/") != 1 || file.SizeBytes < 0 {
			return validationError("invalid upload event")
		}
		if _, exists := eventIDs[file.EventID]; exists {
			return validationError("duplicate upload event")
		}
		eventIDs[file.EventID] = struct{}{}
	}
	if r.ActorKind != "account" && r.ActorKind != "session_capability" {
		return validationError("invalid upload actor")
	}
	if net.ParseIP(r.ClientIP) == nil {
		return validationError("invalid client ip")
	}
	return nil
}

type sessionUploadEventsRequest struct {
	EventIDs []string `json:"eventIds"`
}

func (r sessionUploadEventsRequest) Validate() error {
	if len(r.EventIDs) == 0 || len(r.EventIDs) > maxSessionUploadEventFiles {
		return validationError("invalid upload events")
	}
	eventIDs := make(map[string]struct{}, len(r.EventIDs))
	for _, eventID := range r.EventIDs {
		if ids.ValidateUUIDv7(eventID) != nil {
			return validationError("invalid upload event")
		}
		if _, exists := eventIDs[eventID]; exists {
			return validationError("duplicate upload event")
		}
		eventIDs[eventID] = struct{}{}
	}
	return nil
}

func (s *Server) prepareSessionUpload(c *gin.Context) {
	if s.Sessions == nil {
		c.JSON(http.StatusInternalServerError, internalErrorBody{Error: "session service unavailable"})
		return
	}

	var req sessionUploadPrepareRequest
	if err := bindJSON(c, &req); err != nil {
		WriteInternalError(c, err)
		return
	}
	files := make([]session.UploadedFileEvent, 0, len(req.Files))
	for _, file := range req.Files {
		files = append(files, session.UploadedFileEvent{EventID: file.EventID, Path: file.Path, SizeBytes: file.SizeBytes})
	}
	if err := s.Sessions.PrepareFilesUploaded(
		c.Request.Context(),
		c.Param("sessionId"),
		c.GetHeader("Authorization"),
		files,
		req.ActorKind,
		req.ClientIP,
	); err != nil {
		status, message := mapForwardAuthError(err)
		c.JSON(status, internalErrorBody{Error: message})
		return
	}

	c.Status(http.StatusNoContent)
}

func (s *Server) listPendingSessionUploads(c *gin.Context) {
	files, err := s.Sessions.ListPendingFileUploads(c.Request.Context(), c.Param("sessionId"), c.GetHeader("Authorization"))
	if err != nil {
		status, message := mapForwardAuthError(err)
		c.JSON(status, internalErrorBody{Error: message})
		return
	}
	response := make([]sessionUploadEventFile, 0, len(files))
	for _, file := range files {
		response = append(response, sessionUploadEventFile{EventID: file.EventID, Path: file.Path, SizeBytes: file.SizeBytes})
	}
	c.JSON(http.StatusOK, map[string]any{"files": response})
}

func (s *Server) finalizeSessionUpload(c *gin.Context) {
	var req sessionUploadEventsRequest
	if err := bindJSON(c, &req); err != nil {
		WriteInternalError(c, err)
		return
	}
	if err := s.Sessions.FinalizeFilesUploaded(c.Request.Context(), c.Param("sessionId"), c.GetHeader("Authorization"), req.EventIDs); err != nil {
		status, message := mapForwardAuthError(err)
		c.JSON(status, internalErrorBody{Error: message})
		return
	}
	c.Status(http.StatusNoContent)
}

func (s *Server) cancelPendingSessionUpload(c *gin.Context) {
	var req sessionUploadEventsRequest
	if err := bindJSON(c, &req); err != nil {
		WriteInternalError(c, err)
		return
	}
	if err := s.Sessions.CancelPendingFileUploads(c.Request.Context(), c.Param("sessionId"), c.GetHeader("Authorization"), req.EventIDs); err != nil {
		status, message := mapForwardAuthError(err)
		c.JSON(status, internalErrorBody{Error: message})
		return
	}
	c.Status(http.StatusNoContent)
}

func (s *Server) runGCJob(c *gin.Context) {
	if s.GC == nil {
		c.JSON(http.StatusInternalServerError, internalErrorBody{Error: "gc service unavailable"})
		return
	}

	result, err := s.GC.Run(c.Request.Context())
	if err != nil {
		WriteInternalError(c, err)
		return
	}

	c.JSON(http.StatusOK, gcJobResponse{
		ExpiredSessions:    result.ExpiredSessions,
		RemovedArtifacts:   result.RemovedArtifacts,
		CollectedSnapshots: result.CollectedSnapshots,
	})
}

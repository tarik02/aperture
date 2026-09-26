package httpapi

import (
	"errors"
	"mime/multipart"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/aperture/aperture/internal/paths"
	"github.com/aperture/aperture/internal/session"
	"github.com/aperture/aperture/internal/sessionfiles"
	"github.com/gin-gonic/gin"
)

func (s *Server) sessionFile(c *gin.Context) {
	if s.Repository == nil || s.jobToken == "" {
		c.Status(http.StatusNotFound)
		return
	}
	sessionID := c.Param("sessionId")
	relative := strings.TrimPrefix(c.Param("relativePath"), "/")
	_, disposition, err := sessionfiles.VerifyToken(s.jobToken, c.Query("token"), sessionID, relative, time.Now())
	if err != nil {
		c.Status(http.StatusForbidden)
		return
	}
	layout, err := paths.Session(s.Config, sessionID)
	if err != nil {
		c.Status(http.StatusNotFound)
		return
	}
	fullPath, normalized, err := sessionfiles.Resolve(layout, relative)
	if err != nil {
		if errors.Is(err, sessionfiles.ErrNotFound) {
			c.Status(http.StatusNotFound)
		} else {
			c.Status(http.StatusForbidden)
		}
		return
	}
	file, err := os.Open(fullPath)
	if err != nil {
		WriteInternalError(c, err)
		return
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil {
		WriteInternalError(c, err)
		return
	}
	metadata := sessionfiles.Describe(fullPath, normalized, "", info)
	c.Header("Content-Type", metadata.MIMEType)
	c.Header("Content-Disposition", sessionfiles.ContentDisposition(disposition, metadata.Name))
	// Session files come from web pages and users. Opened inline under this origin,
	// an HTML or SVG file must not run scripts or be sniffed into another type.
	c.Header("Content-Security-Policy", "sandbox")
	c.Header("X-Content-Type-Options", "nosniff")
	http.ServeContent(c.Writer, c.Request, metadata.Name, info.ModTime(), file)
}

func (s *Server) listSessionFiles(c *gin.Context) {
	layout, ok := s.retainedSessionLayout(c)
	if !ok {
		return
	}
	files, err := sessionfiles.List(layout)
	if err != nil {
		WriteError(c, err)
		return
	}
	c.JSON(http.StatusOK, files)
}

func (s *Server) uploadSessionFiles(c *gin.Context, directory string, parts *multipart.Reader) {
	layout, ok := s.retainedSessionLayout(c)
	if !ok {
		return
	}
	files, err := sessionfiles.Store(layout, directory, parts, sessionfiles.Limits{
		MaxFileBytes:      s.Config.SessionUploadMaxFileBytes,
		StorageQuotaBytes: s.Config.SessionStorageQuotaBytes,
	})
	if err != nil {
		WriteError(c, err)
		return
	}
	events := make([]session.FileEvent, 0, len(files))
	for _, file := range files {
		events = append(events, session.FileEvent{
			Type:    "session.file_uploaded",
			Message: "file uploaded",
			Data:    map[string]any{"path": file.RelativePath, "sizeBytes": file.Size, "actorKind": "account", "clientIp": requestClientIP(c)},
		})
	}
	if err := s.Sessions.RecordFileEvents(c.Request.Context(), tenantIDFromContext(c), layout.SessionID, events); err != nil {
		// An upload that cannot be audited is not kept.
		for _, file := range files {
			_ = sessionfiles.Delete(layout, file.RelativePath)
		}
		WriteError(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"files": files})
}

func (s *Server) deleteSessionFile(c *gin.Context, relativePath string) {
	layout, ok := s.retainedSessionLayout(c)
	if !ok {
		return
	}
	if err := sessionfiles.Delete(layout, relativePath); err != nil {
		WriteError(c, err)
		return
	}
	if err := s.Sessions.RecordFileEvents(c.Request.Context(), tenantIDFromContext(c), layout.SessionID, []session.FileEvent{{
		Type:    "session.file_deleted",
		Message: "file deleted",
		Data:    map[string]any{"path": relativePath, "clientIp": requestClientIP(c)},
	}}); err != nil {
		WriteError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (s *Server) moveSessionFile(c *gin.Context) {
	var request moveSessionFileRequest
	if err := bindJSON(c, &request); err != nil {
		WriteError(c, err)
		return
	}
	layout, ok := s.retainedSessionLayout(c)
	if !ok {
		return
	}
	file, err := sessionfiles.Move(layout, request.From, request.To)
	if err != nil {
		WriteError(c, err)
		return
	}
	if err := s.Sessions.RecordFileEvents(c.Request.Context(), tenantIDFromContext(c), layout.SessionID, []session.FileEvent{{
		Type:    "session.file_moved",
		Message: "file moved",
		Data:    map[string]any{"from": request.From, "to": file.RelativePath, "clientIp": requestClientIP(c)},
	}}); err != nil {
		WriteError(c, err)
		return
	}
	c.JSON(http.StatusOK, file)
}

// retainedSessionLayout resolves the session of a file request. Files are managed
// on disk rather than through the wrapper, so this works in every retained state.
func (s *Server) retainedSessionLayout(c *gin.Context) (paths.SessionLayout, bool) {
	if s.Sessions == nil {
		WriteError(c, errSessionServiceUnavailable)
		return paths.SessionLayout{}, false
	}
	view, err := s.Sessions.Get(c.Request.Context(), tenantIDFromContext(c), c.Param("sessionId"))
	if err != nil {
		WriteError(c, err)
		return paths.SessionLayout{}, false
	}
	layout, err := paths.Session(s.Config, view.Session.ID)
	if err != nil {
		WriteError(c, err)
		return paths.SessionLayout{}, false
	}
	return layout, true
}

// retainedSessionFiles reads the session directory on disk rather than asking the
// wrapper, so files stay listable while the session is suspended or stopped.
func (s *Server) retainedSessionFiles(sessionID string) ([]sessionfiles.File, error) {
	layout, err := paths.Session(s.Config, sessionID)
	if err != nil {
		return nil, err
	}
	return sessionfiles.List(layout)
}

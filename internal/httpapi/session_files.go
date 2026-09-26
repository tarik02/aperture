package httpapi

import (
	"errors"
	"mime"
	"mime/multipart"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/aperture/aperture/internal/browser"
	"github.com/aperture/aperture/internal/db"
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
	c.Header("X-Content-Type-Options", "nosniff")
	if mayRunScripts(metadata.MIMEType) {
		c.Header("Content-Security-Policy", "sandbox")
	}
	http.ServeContent(c.Writer, c.Request, metadata.Name, info.ModTime(), file)
}

func (s *Server) listSessionFiles(c *gin.Context) {
	scope, ok := s.fileRequestScope(c)
	if !ok {
		return
	}
	entries, err := sessionfiles.List(scope.layout)
	if err != nil {
		WriteError(c, err)
		return
	}
	for index, entry := range entries {
		entries[index] = scope.present(entry)
	}
	c.JSON(http.StatusOK, entries)
}

func (s *Server) uploadSessionFiles(c *gin.Context, directory string, parts *multipart.Reader) {
	scope, ok := s.fileRequestScope(c)
	if !ok {
		return
	}
	files, err := sessionfiles.Store(c.Request.Context(), scope.layout, directory, parts, sessionfiles.Limits{
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
	if err := s.Sessions.RecordFileEvents(c.Request.Context(), tenantIDFromContext(c), scope.layout.SessionID, events); err != nil {
		// An upload that cannot be audited is not kept.
		for _, file := range files {
			_, _ = sessionfiles.Delete(scope.layout, file.RelativePath, false)
		}
		WriteError(c, err)
		return
	}
	presented := make([]sessionfiles.Entry, 0, len(files))
	for _, file := range files {
		presented = append(presented, scope.present(file))
	}
	c.JSON(http.StatusCreated, gin.H{"files": presented})
}

func (s *Server) deleteSessionFile(c *gin.Context, relativePath string, recursive bool) {
	scope, ok := s.fileRequestScope(c)
	if !ok {
		return
	}
	entryType, err := sessionfiles.Delete(scope.layout, relativePath, recursive)
	if err != nil {
		WriteError(c, err)
		return
	}
	event := session.FileEvent{
		Type:    "session.file_deleted",
		Message: "file deleted",
		Data:    map[string]any{"path": relativePath, "clientIp": requestClientIP(c)},
	}
	if entryType == sessionfiles.EntryDirectory {
		event.Type = "session.directory_deleted"
		event.Message = "directory deleted"
		event.Data["recursive"] = recursive
	}
	if err := s.Sessions.RecordFileEvents(c.Request.Context(), tenantIDFromContext(c), scope.layout.SessionID, []session.FileEvent{event}); err != nil {
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
	scope, ok := s.fileRequestScope(c)
	if !ok {
		return
	}
	entry, err := sessionfiles.Move(c.Request.Context(), scope.layout, request.From, request.To)
	if err != nil {
		WriteError(c, err)
		return
	}
	event := session.FileEvent{
		Type:    "session.file_moved",
		Message: "file moved",
		Data:    map[string]any{"from": request.From, "to": request.To, "clientIp": requestClientIP(c)},
	}
	if _, ok := entry.(sessionfiles.Directory); ok {
		event.Type = "session.directory_moved"
		event.Message = "directory moved"
	}
	if err := s.Sessions.RecordFileEvents(c.Request.Context(), tenantIDFromContext(c), scope.layout.SessionID, []session.FileEvent{event}); err != nil {
		WriteError(c, err)
		return
	}
	c.JSON(http.StatusOK, scope.present(entry))
}

func (s *Server) createSessionDirectory(c *gin.Context) {
	var request createSessionDirectoryRequest
	if err := bindJSON(c, &request); err != nil {
		WriteError(c, err)
		return
	}
	scope, ok := s.fileRequestScope(c)
	if !ok {
		return
	}
	directory, err := sessionfiles.CreateDirectory(c.Request.Context(), scope.layout, request.RelativePath)
	if err != nil {
		WriteError(c, err)
		return
	}
	if err := s.Sessions.RecordFileEvents(c.Request.Context(), tenantIDFromContext(c), scope.layout.SessionID, []session.FileEvent{{
		Type:    "session.directory_created",
		Message: "directory created",
		Data:    map[string]any{"path": directory.RelativePath, "clientIp": requestClientIP(c)},
	}}); err != nil {
		WriteError(c, err)
		return
	}
	c.JSON(http.StatusCreated, directory)
}

// fileRequestScope resolves the session of a file request. Files are managed
// on disk rather than through the wrapper, so this works in every retained state.
func (s *Server) fileRequestScope(c *gin.Context) (sessionFilesScope, bool) {
	if s.Sessions == nil {
		WriteError(c, errSessionServiceUnavailable)
		return sessionFilesScope{}, false
	}
	view, err := s.Sessions.Get(c.Request.Context(), tenantIDFromContext(c), c.Param("sessionId"))
	if err != nil {
		WriteError(c, err)
		return sessionFilesScope{}, false
	}
	scope, err := s.sessionFilesScope(view.Session)
	if err != nil {
		WriteError(c, err)
		return sessionFilesScope{}, false
	}
	return scope, true
}

func (s *Server) sessionFilesScope(sessionRow db.Session) (sessionFilesScope, error) {
	layout, err := paths.Session(s.Config, sessionRow.ID)
	if err != nil {
		return sessionFilesScope{}, err
	}
	return sessionFilesScope{layout: layout, hideSandboxPaths: startedBeforeFilesRoot(sessionRow)}, nil
}

type sessionFilesScope struct {
	layout paths.SessionLayout
	// hideSandboxPaths is set while the session runs a wrapper started before the
	// files root, whose sandbox does not mount /session/files.
	hideSandboxPaths bool
}

func (scope sessionFilesScope) present(entry sessionfiles.Entry) sessionfiles.Entry {
	if file, ok := entry.(sessionfiles.File); ok {
		return scope.presentFile(file)
	}
	return entry
}

func (scope sessionFilesScope) presentFile(file sessionfiles.File) sessionfiles.File {
	if scope.hideSandboxPaths {
		file.SandboxPath = ""
	}
	return file
}

// startedBeforeFilesRoot reads the runtime env the session's wrapper started from.
// Env files written before the files root carry no FILES_DIR.
func startedBeforeFilesRoot(sessionRow db.Session) bool {
	if sessionRow.RuntimeEnvPath == nil {
		return false
	}
	body, err := os.ReadFile(*sessionRow.RuntimeEnvPath)
	if err != nil {
		return false
	}
	values, err := browser.ParseRuntimeEnv(body)
	if err != nil {
		return false
	}
	return values.FilesDir == ""
}

// mayRunScripts reports content a browser renders as a document that can run
// scripts. Session files come from web pages and users, so such a file opened
// inline under this origin is sandboxed. Media, PDFs, and plain text are not,
// because sandboxing them only disables Chrome's viewers.
func mayRunScripts(mimeType string) bool {
	mediaType, _, err := mime.ParseMediaType(mimeType)
	if err != nil {
		return true
	}
	switch {
	case mediaType == "image/svg+xml":
		return true
	case strings.HasPrefix(mediaType, "image/"), strings.HasPrefix(mediaType, "video/"), strings.HasPrefix(mediaType, "audio/"):
		return false
	case mediaType == "application/pdf", mediaType == "text/plain":
		return false
	default:
		return true
	}
}

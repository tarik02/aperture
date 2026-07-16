package browser

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/aperture/aperture/internal/ids"
	"golang.org/x/sys/unix"
)

const defaultUploadMaxFileBytes int64 = 100 << 20
const defaultSessionStorageQuotaBytes int64 = 1 << 30
const maxUploadFilesPerRequest = 100
const maxUploadFilesPerSession = 1000

type wrapperFile struct {
	Kind         string    `json:"kind"`
	Name         string    `json:"name"`
	Path         string    `json:"path"`
	AbsolutePath string    `json:"absolutePath"`
	SizeBytes    int64     `json:"sizeBytes"`
	ModifiedAt   time.Time `json:"modifiedAt"`
}

type pendingUpload struct {
	eventID string
	file    *os.File
	result  wrapperFile
}

type pendingUploadAudit struct {
	EventID   string `json:"eventId"`
	Path      string `json:"path"`
	SizeBytes int64  `json:"sizeBytes"`
}

func (r *wrapperRuntime) handleFiles(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	files := make([]wrapperFile, 0)
	for _, kind := range []string{"uploads", "downloads", "artifacts"} {
		dir, _ := r.fileDirectory(kind)
		entries, err := os.ReadDir(dir)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			writeWrapperError(w, http.StatusInternalServerError, "list files failed")
			return
		}
		for _, entry := range entries {
			if entry.Type()&os.ModeSymlink != 0 || strings.HasPrefix(entry.Name(), ".upload-") {
				continue
			}
			info, err := entry.Info()
			if err != nil {
				writeWrapperError(w, http.StatusInternalServerError, "list files failed")
				return
			}
			if info.Mode().IsRegular() {
				files = append(files, wrapperFileResponse(kind, entry.Name(), dir, info))
			}
		}
	}

	sort.Slice(files, func(i, j int) bool {
		if files[i].Kind == files[j].Kind {
			return files[i].Name < files[j].Name
		}
		return files[i].Kind < files[j].Kind
	})
	writeWrapperJSON(w, http.StatusOK, map[string]any{"files": files})
}

func (r *wrapperRuntime) handleFileDownload(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodGet && req.Method != http.MethodHead {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	path := strings.TrimPrefix(req.URL.Path, "/files/")
	kind, name, ok := strings.Cut(path, "/")
	if !ok || kind == "" || name == "" || strings.Contains(name, "/") || filepath.Base(name) != name || strings.HasPrefix(name, ".upload-") {
		writeWrapperError(w, http.StatusBadRequest, "invalid file path")
		return
	}
	dir, ok := r.fileDirectory(kind)
	if !ok {
		writeWrapperError(w, http.StatusNotFound, "file not found")
		return
	}
	dirFD, err := unix.Open(dir, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if errors.Is(err, os.ErrNotExist) {
		writeWrapperError(w, http.StatusNotFound, "file not found")
		return
	}
	if err != nil {
		writeWrapperError(w, http.StatusInternalServerError, "open file failed")
		return
	}
	defer unix.Close(dirFD)
	fileFD, err := unix.Openat2(dirFD, name, &unix.OpenHow{
		Flags:   unix.O_RDONLY | unix.O_CLOEXEC,
		Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS,
	})
	if errors.Is(err, os.ErrNotExist) || errors.Is(err, unix.ELOOP) {
		writeWrapperError(w, http.StatusNotFound, "file not found")
		return
	}
	if err != nil {
		writeWrapperError(w, http.StatusInternalServerError, "open file failed")
		return
	}
	file := os.NewFile(uintptr(fileFD), name)
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		writeWrapperError(w, http.StatusInternalServerError, "inspect file failed")
		return
	}
	if !info.Mode().IsRegular() {
		writeWrapperError(w, http.StatusNotFound, "file not found")
		return
	}

	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
	http.ServeContent(w, req, name, info.ModTime(), file)
}

func (r *wrapperRuntime) handleUploads(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	r.uploadMu.Lock()
	defer r.uploadMu.Unlock()

	uploadsDir, _ := r.fileDirectory("uploads")
	if err := ensureRegularDirectory(uploadsDir); err != nil {
		writeWrapperError(w, http.StatusInternalServerError, "uploads directory unavailable")
		return
	}
	uploadsDirFD, err := unix.Open(uploadsDir, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		writeWrapperError(w, http.StatusInternalServerError, "uploads directory unavailable")
		return
	}
	uploadsDirectory := os.NewFile(uintptr(uploadsDirFD), uploadsDir)
	defer uploadsDirectory.Close()
	existingUploads, err := uploadsDirectory.ReadDir(-1)
	if err != nil {
		writeWrapperError(w, http.StatusInternalServerError, "list uploads failed")
		return
	}
	existingUploadCount := 0
	for _, entry := range existingUploads {
		if entry.Type()&os.ModeSymlink == 0 && entry.Type().IsRegular() && !strings.HasPrefix(entry.Name(), ".upload-") {
			existingUploadCount++
		}
	}
	if existingUploadCount >= maxUploadFilesPerSession {
		writeWrapperError(w, http.StatusInsufficientStorage, "session upload file limit exceeded")
		return
	}
	footprint, err := r.sessionFootprint()
	if err != nil {
		writeWrapperError(w, http.StatusInternalServerError, "calculate session footprint failed")
		return
	}
	maxFileBytes := r.values.SessionUploadMaxFileBytes
	if maxFileBytes <= 0 {
		maxFileBytes = defaultUploadMaxFileBytes
	}
	storageQuotaBytes := r.values.SessionStorageQuotaBytes
	if storageQuotaBytes <= 0 {
		storageQuotaBytes = defaultSessionStorageQuotaBytes
	}
	reader, err := req.MultipartReader()
	if err != nil {
		writeWrapperError(w, http.StatusBadRequest, "multipart upload required")
		return
	}

	uploaded := make([]wrapperFile, 0)
	pending := make([]pendingUpload, 0)
	defer func() {
		for _, upload := range pending {
			_ = upload.file.Close()
		}
	}()
	createdNames := make([]string, 0)
	removeCreated := func() {
		for _, upload := range pending {
			_ = upload.file.Close()
		}
		for _, name := range createdNames {
			_ = unix.Unlinkat(uploadsDirFD, name, 0)
		}
	}
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			removeCreated()
			writeWrapperError(w, http.StatusBadRequest, "invalid multipart upload")
			return
		}
		if part.FileName() == "" {
			part.Close()
			continue
		}
		if len(uploaded) >= maxUploadFilesPerRequest || existingUploadCount+len(uploaded) >= maxUploadFilesPerSession {
			part.Close()
			removeCreated()
			writeWrapperError(w, http.StatusInsufficientStorage, "session upload file limit exceeded")
			return
		}

		eventID, err := ids.NewUUIDv7()
		if err != nil {
			part.Close()
			removeCreated()
			writeWrapperError(w, http.StatusInternalServerError, "create upload failed")
			return
		}
		name := sanitizeUploadName(part.FileName())
		extension := filepath.Ext(name)
		stem := strings.TrimSuffix(name, extension)
		var placeholderFD int
		for sequence := 0; ; sequence++ {
			candidate := name
			if sequence > 0 {
				candidate = fmt.Sprintf("%s-%d%s", stem, sequence, extension)
			}
			placeholderFD, err = unix.Openat2(uploadsDirFD, candidate, &unix.OpenHow{
				Flags:   unix.O_WRONLY | unix.O_CREAT | unix.O_EXCL | unix.O_CLOEXEC,
				Mode:    0o600,
				Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS,
			})
			if errors.Is(err, os.ErrExist) {
				continue
			}
			if err != nil {
				part.Close()
				removeCreated()
				writeWrapperError(w, http.StatusInternalServerError, "create upload failed")
				return
			}
			name = candidate
			break
		}
		placeholder := os.NewFile(uintptr(placeholderFD), name)
		if _, err := io.WriteString(placeholder, "aperture-pending:"+eventID); err != nil {
			part.Close()
			_ = placeholder.Close()
			_ = unix.Unlinkat(uploadsDirFD, name, 0)
			removeCreated()
			writeWrapperError(w, http.StatusInternalServerError, "create upload failed")
			return
		}
		if err := placeholder.Close(); err != nil {
			part.Close()
			_ = unix.Unlinkat(uploadsDirFD, name, 0)
			removeCreated()
			writeWrapperError(w, http.StatusInternalServerError, "create upload failed")
			return
		}
		createdNames = append(createdNames, name)
		fileFD, err := unix.Openat2(uploadsDirFD, ".", &unix.OpenHow{
			Flags:   unix.O_WRONLY | unix.O_TMPFILE | unix.O_CLOEXEC,
			Mode:    0o600,
			Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS,
		})
		if err != nil {
			part.Close()
			removeCreated()
			writeWrapperError(w, http.StatusInternalServerError, "create upload failed")
			return
		}
		file := os.NewFile(uintptr(fileFD), name)
		remaining := storageQuotaBytes - footprint
		if remaining < 0 {
			remaining = 0
		}
		limit := maxFileBytes
		if remaining < limit {
			limit = remaining
		}
		written, copyErr := io.Copy(file, io.LimitReader(part, limit+1))
		info, statErr := file.Stat()
		syncErr := file.Sync()
		part.Close()
		if copyErr != nil || statErr != nil || syncErr != nil {
			_ = file.Close()
			removeCreated()
			writeWrapperError(w, http.StatusInternalServerError, "write upload failed")
			return
		}
		if written > maxFileBytes {
			_ = file.Close()
			removeCreated()
			writeWrapperError(w, http.StatusRequestEntityTooLarge, "file exceeds upload limit")
			return
		}
		if written > remaining {
			_ = file.Close()
			removeCreated()
			writeWrapperError(w, http.StatusInsufficientStorage, "session storage quota exceeded")
			return
		}

		footprint += written
		result := wrapperFileResponse("uploads", name, uploadsDir, info)
		uploaded = append(uploaded, result)
		pending = append(pending, pendingUpload{eventID: eventID, file: file, result: result})
	}

	if len(uploaded) == 0 {
		writeWrapperError(w, http.StatusBadRequest, "no files uploaded")
		return
	}
	if err := r.prepareUploads(req, pending); err != nil {
		removeCreated()
		writeWrapperError(w, http.StatusBadGateway, "record upload failed")
		return
	}
	publishFailed := false
	for _, upload := range pending {
		hiddenName := ".upload-" + upload.eventID
		if err := unix.Linkat(int(upload.file.Fd()), "", uploadsDirFD, hiddenName, unix.AT_EMPTY_PATH); err != nil {
			publishFailed = true
			break
		}
		if err := unix.Renameat2(uploadsDirFD, hiddenName, uploadsDirFD, upload.result.Name, unix.RENAME_EXCHANGE); err != nil {
			publishFailed = true
			break
		}
		_ = unix.Unlinkat(uploadsDirFD, hiddenName, 0)
		_ = upload.file.Close()
	}
	if publishFailed {
		if err := r.reconcilePendingUploads(); err != nil {
			writeWrapperError(w, http.StatusInternalServerError, "recover upload failed")
			return
		}
		writeWrapperError(w, http.StatusInternalServerError, "publish upload failed")
		return
	}
	eventIDs := make([]string, 0, len(pending))
	for _, upload := range pending {
		eventIDs = append(eventIDs, upload.eventID)
	}
	if err := r.updateUploadEvents("finalize", eventIDs); err != nil {
		writeWrapperError(w, http.StatusBadGateway, "finalize upload failed")
		return
	}
	writeWrapperJSON(w, http.StatusCreated, map[string]any{"files": uploaded})
}

func (r *wrapperRuntime) prepareUploads(req *http.Request, files []pendingUpload) error {
	auditFiles := make([]pendingUploadAudit, 0, len(files))
	for _, file := range files {
		auditFiles = append(auditFiles, pendingUploadAudit{EventID: file.eventID, Path: file.result.Path, SizeBytes: file.result.SizeBytes})
	}
	return r.uploadAuditRequest(http.MethodPost, "prepare", map[string]any{
		"files":     auditFiles,
		"actorKind": req.Header.Get("X-Aperture-Actor-Kind"),
		"clientIp":  req.Header.Get("X-Aperture-Client-IP"),
	}, nil)
}

func (r *wrapperRuntime) updateUploadEvents(action string, eventIDs []string) error {
	return r.uploadAuditRequest(http.MethodPost, action, map[string]any{"eventIds": eventIDs}, nil)
}

func (r *wrapperRuntime) uploadAuditRequest(method, action string, payload any, result any) error {
	if r.values.InternalAPIURL == "" {
		return fmt.Errorf("upload audit is not configured")
	}
	var body []byte
	var err error
	if payload != nil {
		body, err = json.Marshal(payload)
		if err != nil {
			return err
		}
	}
	for {
		token := r.values.CDPToken
		if r.values.CDPTokenPath != "" {
			tokenBody, err := os.ReadFile(r.values.CDPTokenPath)
			if err != nil {
				return err
			}
			token = strings.TrimSpace(string(tokenBody))
		}
		if token == "" {
			return fmt.Errorf("upload audit token is unavailable")
		}
		attemptCtx, cancel := context.WithTimeout(r.ctx, 5*time.Second)
		auditReq, err := http.NewRequestWithContext(attemptCtx, method, strings.TrimRight(r.values.InternalAPIURL, "/")+"/internal/session-events/"+url.PathEscape(r.values.SessionID)+"/upload/"+action, bytes.NewReader(body))
		if err != nil {
			cancel()
			return err
		}
		auditReq.Header.Set("Authorization", "Bearer "+token)
		auditReq.Header.Set("Content-Type", "application/json")
		response, err := http.DefaultClient.Do(auditReq)
		if err == nil {
			if response.StatusCode >= 200 && response.StatusCode < 300 {
				if result != nil {
					err = json.NewDecoder(response.Body).Decode(result)
				}
				response.Body.Close()
				cancel()
				if err != nil {
					return err
				}
				return nil
			}
			response.Body.Close()
			cancel()
			if response.StatusCode < 500 && response.StatusCode != http.StatusUnauthorized {
				return fmt.Errorf("upload audit returned %s", response.Status)
			}
		} else {
			cancel()
		}
		select {
		case <-r.ctx.Done():
			return context.Cause(r.ctx)
		case <-time.After(time.Second):
		}
	}
}

func (r *wrapperRuntime) reconcilePendingUploads() error {
	var response struct {
		Files []pendingUploadAudit `json:"files"`
	}
	if err := r.uploadAuditRequest(http.MethodGet, "pending", nil, &response); err != nil {
		return err
	}
	uploadsDir, _ := r.fileDirectory("uploads")
	if err := ensureRegularDirectory(uploadsDir); err != nil {
		return err
	}
	uploadsDirFD, err := unix.Open(uploadsDir, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	defer unix.Close(uploadsDirFD)
	finalize := make([]string, 0, len(response.Files))
	cancel := make([]string, 0, len(response.Files))
	for _, upload := range response.Files {
		kind, name, ok := strings.Cut(upload.Path, "/")
		if !ok || kind != "uploads" || name == "" || strings.Contains(name, "/") || filepath.Base(name) != name || strings.HasPrefix(name, ".upload-") {
			cancel = append(cancel, upload.EventID)
			continue
		}
		hiddenName := ".upload-" + upload.EventID
		marker := "aperture-pending:" + upload.EventID
		var hiddenStat unix.Stat_t
		hiddenExists := false
		if unix.Fstatat(uploadsDirFD, hiddenName, &hiddenStat, unix.AT_SYMLINK_NOFOLLOW) == nil && hiddenStat.Mode&unix.S_IFMT == unix.S_IFREG && hiddenStat.Size == upload.SizeBytes {
			hiddenFD, err := unix.Openat2(uploadsDirFD, hiddenName, &unix.OpenHow{
				Flags:   unix.O_RDONLY | unix.O_CLOEXEC,
				Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS,
			})
			if err != nil {
				return err
			}
			hiddenFile := os.NewFile(uintptr(hiddenFD), hiddenName)
			content, err := io.ReadAll(io.LimitReader(hiddenFile, int64(len(marker)+1)))
			_ = hiddenFile.Close()
			if err != nil {
				return err
			}
			hiddenExists = string(content) != marker
		}
		var finalStat unix.Stat_t
		finalExists := unix.Fstatat(uploadsDirFD, name, &finalStat, unix.AT_SYMLINK_NOFOLLOW) == nil && finalStat.Mode&unix.S_IFMT == unix.S_IFREG
		reservation := false
		if finalExists {
			finalFD, err := unix.Openat2(uploadsDirFD, name, &unix.OpenHow{
				Flags:   unix.O_RDONLY | unix.O_CLOEXEC,
				Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS,
			})
			if err != nil {
				return err
			}
			finalFile := os.NewFile(uintptr(finalFD), name)
			content, err := io.ReadAll(io.LimitReader(finalFile, int64(len(marker)+1)))
			_ = finalFile.Close()
			if err != nil {
				return err
			}
			reservation = string(content) == marker
		}
		if hiddenExists {
			if finalExists {
				err = unix.Renameat2(uploadsDirFD, hiddenName, uploadsDirFD, name, unix.RENAME_EXCHANGE)
			} else {
				err = unix.Renameat(uploadsDirFD, hiddenName, uploadsDirFD, name)
			}
			if err != nil {
				return err
			}
			_ = unix.Unlinkat(uploadsDirFD, hiddenName, 0)
			finalStat = hiddenStat
			finalExists = true
			reservation = false
		}
		if finalExists && finalStat.Size == upload.SizeBytes && !reservation {
			finalize = append(finalize, upload.EventID)
			continue
		}
		_ = unix.Unlinkat(uploadsDirFD, name, 0)
		_ = unix.Unlinkat(uploadsDirFD, hiddenName, 0)
		cancel = append(cancel, upload.EventID)
	}
	if len(finalize) > 0 {
		if err := r.updateUploadEvents("finalize", finalize); err != nil {
			return err
		}
	}
	if len(cancel) > 0 {
		if err := r.updateUploadEvents("cancel", cancel); err != nil {
			return err
		}
	}
	entriesFD, err := unix.Dup(uploadsDirFD)
	if err != nil {
		return err
	}
	entriesDirectory := os.NewFile(uintptr(entriesFD), uploadsDir)
	entries, err := entriesDirectory.ReadDir(-1)
	_ = entriesDirectory.Close()
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".upload-") {
			_ = unix.Unlinkat(uploadsDirFD, entry.Name(), 0)
		}
	}
	return nil
}

func (r *wrapperRuntime) fileDirectory(kind string) (string, bool) {
	switch kind {
	case "uploads":
		return filepath.Join(r.values.ArtifactsDir, "uploads"), true
	case "downloads":
		return r.values.DownloadsDir, true
	case "artifacts":
		return r.values.ArtifactsDir, true
	default:
		return "", false
	}
}

func (r *wrapperRuntime) sessionFootprint() (int64, error) {
	var size int64
	for _, root := range []string{r.values.UpperDir, r.values.DownloadsDir, r.values.CacheDir, r.values.ArtifactsDir} {
		if root == "" {
			continue
		}
		err := filepath.WalkDir(root, func(_ string, entry os.DirEntry, err error) error {
			if errors.Is(err, os.ErrNotExist) {
				return nil
			}
			if err != nil {
				return err
			}
			if entry.Type()&os.ModeSymlink != 0 {
				if entry.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			info, err := entry.Info()
			if err != nil {
				return err
			}
			if info.Mode().IsRegular() {
				size += info.Size()
			}
			return nil
		})
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return 0, err
		}
	}
	return size, nil
}

func wrapperFileResponse(kind, name, dir string, info os.FileInfo) wrapperFile {
	return wrapperFile{
		Kind:         kind,
		Name:         name,
		Path:         filepath.ToSlash(filepath.Join(kind, name)),
		AbsolutePath: filepath.Join(dir, name),
		SizeBytes:    info.Size(),
		ModifiedAt:   info.ModTime(),
	}
}

func ensureRegularDirectory(path string) error {
	if err := os.MkdirAll(path, 0o700); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("not a regular directory")
	}
	return nil
}

func sanitizeUploadName(name string) string {
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	name = strings.Map(func(char rune) rune {
		if unicode.IsLetter(char) || unicode.IsDigit(char) || char == '.' || char == '-' || char == '_' {
			return char
		}
		return '_'
	}, name)
	name = strings.Trim(name, ".")
	if name == "" {
		return "upload"
	}
	return name
}

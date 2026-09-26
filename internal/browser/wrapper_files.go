package browser

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/aperture/aperture/internal/ids"
	"github.com/aperture/aperture/internal/paths"
	"github.com/aperture/aperture/internal/sessionfiles"
	"golang.org/x/sys/unix"
)

const defaultUploadMaxFileBytes int64 = 100 << 20
const defaultSessionStorageQuotaBytes int64 = 1 << 30

type pendingUpload struct {
	eventID string
	file    *os.File
	name    string
	info    os.FileInfo
}

type pendingUploadAudit struct {
	EventID   string `json:"eventId"`
	Path      string `json:"path"`
	SizeBytes int64  `json:"sizeBytes"`
}

// uploadRejection is an upload failure and the response it maps to.
type uploadRejection struct {
	status  int
	message string
}

func (e uploadRejection) Error() string { return e.message }

type uploadLimits struct {
	maxFileBytes      int64
	storageQuotaBytes int64
}

func (r *wrapperRuntime) handleUploads(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	uploadsDir := paths.SessionFiles(r.values.FilesDir).Uploads
	if err := ensureRegularDirectory(uploadsDir); err != nil {
		writeWrapperError(w, http.StatusInternalServerError, "uploads directory unavailable")
		return
	}
	uploadsDirFD, err := unix.Open(uploadsDir, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		writeWrapperError(w, http.StatusInternalServerError, "uploads directory unavailable")
		return
	}
	defer func() { _ = unix.Close(uploadsDirFD) }()
	limits := uploadLimits{
		maxFileBytes:      r.values.SessionUploadMaxFileBytes,
		storageQuotaBytes: r.values.SessionStorageQuotaBytes,
	}
	if limits.maxFileBytes <= 0 {
		limits.maxFileBytes = defaultUploadMaxFileBytes
	}
	if limits.storageQuotaBytes <= 0 {
		limits.storageQuotaBytes = defaultSessionStorageQuotaBytes
	}

	release, err := sessionfiles.AcquireUploadSlot(r.values.FilesDir)
	if err != nil {
		writeWrapperError(w, http.StatusTooManyRequests, "too many uploads in progress for this session")
		return
	}
	defer release()
	pending, err := r.stageUploads(req, uploadsDirFD, limits)
	defer func() {
		for _, upload := range pending {
			_ = upload.file.Close()
		}
	}()
	if err == nil {
		err = r.commitUploads(req, uploadsDirFD, pending, limits)
	}
	var rejection uploadRejection
	if errors.As(err, &rejection) {
		writeWrapperError(w, rejection.status, rejection.message)
		return
	}
	if err != nil {
		writeWrapperError(w, http.StatusInternalServerError, "upload failed")
		return
	}
	uploaded := make([]sessionfiles.File, 0, len(pending))
	for _, upload := range pending {
		relative := "uploads/" + upload.name
		uploaded = append(uploaded, sessionfiles.Describe(filepath.Join(uploadsDir, upload.name), relative, sessionfiles.SandboxPath(relative), upload.info))
	}
	writeWrapperJSON(w, http.StatusCreated, map[string]any{"files": uploaded})
}

// stageUploads streams every file part into an unlinked temporary file without
// holding any lock, so a slow client delays only its own upload. The limits are
// checked again when the files are committed.
func (r *wrapperRuntime) stageUploads(req *http.Request, uploadsDirFD int, limits uploadLimits) ([]pendingUpload, error) {
	existingUploadCount, err := countVisibleUploads(uploadsDirFD)
	if err != nil {
		return nil, uploadRejection{http.StatusInternalServerError, "list uploads failed"}
	}
	if existingUploadCount >= sessionfiles.MaxUploadFilesPerDirectory {
		return nil, uploadRejection{http.StatusInsufficientStorage, "session upload file limit exceeded"}
	}
	footprint, err := sessionfiles.Footprint(r.values.UpperDir, r.values.FilesDir, r.values.CacheDir)
	if err != nil {
		return nil, uploadRejection{http.StatusInternalServerError, "calculate session footprint failed"}
	}
	reader, err := req.MultipartReader()
	if err != nil {
		return nil, uploadRejection{http.StatusBadRequest, "multipart upload required"}
	}

	pending := make([]pendingUpload, 0)
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return pending, uploadRejection{http.StatusBadRequest, "invalid multipart upload"}
		}
		if part.FileName() == "" {
			_ = part.Close()
			continue
		}
		if len(pending) >= sessionfiles.MaxUploadFilesPerRequest || existingUploadCount+len(pending) >= sessionfiles.MaxUploadFilesPerDirectory {
			_ = part.Close()
			return pending, uploadRejection{http.StatusInsufficientStorage, "session upload file limit exceeded"}
		}
		eventID, err := ids.NewUUIDv7()
		if err != nil {
			_ = part.Close()
			return pending, err
		}
		fileFD, err := unix.Openat2(uploadsDirFD, ".", &unix.OpenHow{
			Flags:   unix.O_WRONLY | unix.O_TMPFILE | unix.O_CLOEXEC,
			Mode:    0o600,
			Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS,
		})
		if err != nil {
			_ = part.Close()
			return pending, uploadRejection{http.StatusInternalServerError, "create upload failed"}
		}
		name := sessionfiles.SanitizeName(part.FileName())
		file := os.NewFile(uintptr(fileFD), name)
		remaining := max(limits.storageQuotaBytes-footprint, 0)
		limit := min(limits.maxFileBytes, remaining)
		written, copyErr := io.Copy(file, io.LimitReader(part, limit+1))
		info, statErr := file.Stat()
		syncErr := file.Sync()
		_ = part.Close()
		if copyErr != nil || statErr != nil || syncErr != nil {
			_ = file.Close()
			return pending, uploadRejection{http.StatusInternalServerError, "write upload failed"}
		}
		if written > limits.maxFileBytes {
			_ = file.Close()
			return pending, uploadRejection{http.StatusRequestEntityTooLarge, "file exceeds upload limit"}
		}
		if written > remaining {
			_ = file.Close()
			return pending, uploadRejection{http.StatusInsufficientStorage, "session storage quota exceeded"}
		}
		footprint += written
		pending = append(pending, pendingUpload{eventID: eventID, file: file, name: name, info: info})
	}
	if len(pending) == 0 {
		return pending, uploadRejection{http.StatusBadRequest, "no files uploaded"}
	}
	return pending, nil
}

// commitUploads reserves the upload names, records the uploads, and publishes them.
// Only the final limit check and publishing hold the session files lock.
func (r *wrapperRuntime) commitUploads(req *http.Request, uploadsDirFD int, pending []pendingUpload, limits uploadLimits) error {
	// Reconciling pending uploads after a failed publish would cancel another
	// request's prepared uploads, so committing is serialized within the wrapper.
	r.uploadMu.Lock()
	defer r.uploadMu.Unlock()

	createdNames := make([]string, 0, len(pending))
	removeCreated := func() {
		for _, name := range createdNames {
			_ = unix.Unlinkat(uploadsDirFD, name, 0)
		}
	}
	for index := range pending {
		name, err := reserveUploadName(uploadsDirFD, pending[index].name, pending[index].eventID)
		if err != nil {
			removeCreated()
			return uploadRejection{http.StatusInternalServerError, "create upload failed"}
		}
		createdNames = append(createdNames, name)
		pending[index].name = name
	}
	eventIDs := make([]string, 0, len(pending))
	for _, upload := range pending {
		eventIDs = append(eventIDs, upload.eventID)
	}
	if err := r.prepareUploads(req, pending); err != nil {
		removeCreated()
		return uploadRejection{http.StatusBadGateway, "record upload failed"}
	}
	cancelPrepared := func() {
		removeCreated()
		_ = r.updateUploadEvents("cancel", eventIDs)
	}

	unlockFiles, err := sessionfiles.Lock(req.Context(), r.values.FilesDir)
	if err != nil {
		cancelPrepared()
		return uploadRejection{http.StatusServiceUnavailable, "session files are busy"}
	}
	if err := checkCommittedUploadLimits(r.values, uploadsDirFD, pending, limits); err != nil {
		unlockFiles()
		cancelPrepared()
		return err
	}
	for _, upload := range pending {
		hiddenName := ".upload-" + upload.eventID
		err := unix.Linkat(int(upload.file.Fd()), "", uploadsDirFD, hiddenName, unix.AT_EMPTY_PATH)
		if err == nil {
			err = unix.Renameat2(uploadsDirFD, hiddenName, uploadsDirFD, upload.name, unix.RENAME_EXCHANGE)
		}
		if err != nil {
			unlockFiles()
			if err := r.reconcilePendingUploads(); err != nil {
				return uploadRejection{http.StatusInternalServerError, "recover upload failed"}
			}
			return uploadRejection{http.StatusInternalServerError, "publish upload failed"}
		}
		_ = unix.Unlinkat(uploadsDirFD, hiddenName, 0)
	}
	unlockFiles()

	if err := r.updateUploadEvents("finalize", eventIDs); err != nil {
		return uploadRejection{http.StatusBadGateway, "finalize upload failed"}
	}
	return nil
}

// checkCommittedUploadLimits repeats the limit checks under the session files lock,
// where usage by other uploads that were published meanwhile is visible. The
// reserved names already count as entries.
func checkCommittedUploadLimits(values RuntimeEnvValues, uploadsDirFD int, pending []pendingUpload, limits uploadLimits) error {
	entries, err := sessionfiles.CountEntries(values.FilesDir)
	if err != nil {
		return err
	}
	uploads, err := countVisibleUploads(uploadsDirFD)
	if err != nil {
		return err
	}
	if entries > sessionfiles.MaxEntriesPerSession || uploads > sessionfiles.MaxUploadFilesPerDirectory {
		return uploadRejection{http.StatusInsufficientStorage, "session upload file limit exceeded"}
	}
	footprint, err := sessionfiles.Footprint(values.UpperDir, values.FilesDir, values.CacheDir)
	if err != nil {
		return err
	}
	for _, upload := range pending {
		footprint += upload.info.Size()
	}
	if footprint > limits.storageQuotaBytes {
		return uploadRejection{http.StatusInsufficientStorage, "session storage quota exceeded"}
	}
	return nil
}

// reserveUploadName creates a placeholder under name, or under a numbered variant
// when it is taken, and returns the name it got.
func reserveUploadName(uploadsDirFD int, name, eventID string) (string, error) {
	extension := filepath.Ext(name)
	stem := strings.TrimSuffix(name, extension)
	for sequence := 0; ; sequence++ {
		candidate := name
		if sequence > 0 {
			candidate = fmt.Sprintf("%s-%d%s", stem, sequence, extension)
		}
		fd, err := unix.Openat2(uploadsDirFD, candidate, &unix.OpenHow{
			Flags:   unix.O_WRONLY | unix.O_CREAT | unix.O_EXCL | unix.O_CLOEXEC,
			Mode:    0o600,
			Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS,
		})
		if errors.Is(err, os.ErrExist) {
			continue
		}
		if err != nil {
			return "", err
		}
		placeholder := os.NewFile(uintptr(fd), candidate)
		_, writeErr := io.WriteString(placeholder, sessionfiles.PendingUploadMarker+eventID)
		closeErr := placeholder.Close()
		if err := errors.Join(writeErr, closeErr); err != nil {
			_ = unix.Unlinkat(uploadsDirFD, candidate, 0)
			return "", err
		}
		return candidate, nil
	}
}

func countVisibleUploads(uploadsDirFD int) (int, error) {
	// A fresh open, unlike Dup, gets its own read offset.
	fd, err := unix.Openat(uploadsDirFD, ".", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return 0, err
	}
	directory := os.NewFile(uintptr(fd), "uploads")
	defer func() { _ = directory.Close() }()
	entries, err := directory.ReadDir(-1)
	if err != nil {
		return 0, err
	}
	count := 0
	for _, entry := range entries {
		if entry.Type()&os.ModeSymlink == 0 && entry.Type().IsRegular() && !strings.HasPrefix(entry.Name(), ".upload-") {
			count++
		}
	}
	return count, nil
}

func (r *wrapperRuntime) prepareUploads(req *http.Request, files []pendingUpload) error {
	auditFiles := make([]pendingUploadAudit, 0, len(files))
	for _, file := range files {
		auditFiles = append(auditFiles, pendingUploadAudit{EventID: file.eventID, Path: "uploads/" + file.name, SizeBytes: file.info.Size()})
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
		token := r.values.SessionToken
		if r.values.SessionTokenPath != "" {
			tokenBody, err := os.ReadFile(r.values.SessionTokenPath)
			if err != nil {
				return err
			}
			token = strings.TrimSpace(string(tokenBody))
		}
		if token == "" {
			return fmt.Errorf("upload audit session token is unavailable")
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
				_ = response.Body.Close()
				cancel()
				if err != nil {
					return err
				}
				return nil
			}
			_ = response.Body.Close()
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
	uploadsDir := paths.SessionFiles(r.values.FilesDir).Uploads
	if err := ensureRegularDirectory(uploadsDir); err != nil {
		return err
	}
	uploadsDirFD, err := unix.Open(uploadsDir, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	defer func() { _ = unix.Close(uploadsDirFD) }()
	finalize := make([]string, 0, len(response.Files))
	cancel := make([]string, 0, len(response.Files))
	for _, upload := range response.Files {
		kind, name, ok := strings.Cut(upload.Path, "/")
		if !ok || kind != "uploads" || name == "" || strings.Contains(name, "/") || filepath.Base(name) != name || strings.HasPrefix(name, ".upload-") {
			cancel = append(cancel, upload.EventID)
			continue
		}
		hiddenName := ".upload-" + upload.EventID
		marker := sessionfiles.PendingUploadMarker + upload.EventID
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

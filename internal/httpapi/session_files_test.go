package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/aperture/aperture/internal/auth"
	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/paths"
	"github.com/aperture/aperture/internal/session"
)

func TestSessionFileMutationsRejectPurgedSession(t *testing.T) {
	t.Parallel()

	env := newSessionTestEnv(t, func(cfg *config.Config) {
		cfg.SessionUploadMaxFileBytes = 1 << 20
		cfg.SessionStorageQuotaBytes = 16 << 20
		cfg.SignedFileURLTTL = time.Minute
		cfg.SignedFileURLMaxTTL = time.Hour
	})
	env.server.SetJobToken("session-files-test-job-token")
	created, err := env.server.Sessions.Create(context.Background(), session.CreateInput{
		TenantID:       env.tenantID,
		BrowserChannel: "chromium",
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	base := "/api/sessions/" + created.Session.ID

	uploadBody, contentType := sessionFileMultipart(t)
	upload := httptest.NewRequest(http.MethodPost, base+"/files", bytes.NewReader(uploadBody))
	upload.Header.Set("Authorization", "Bearer "+env.admin)
	upload.Header.Set(auth.TenantHeader, env.tenantID)
	upload.Header.Set("Content-Type", contentType)
	uploadRec := httptest.NewRecorder()
	env.router.ServeHTTP(uploadRec, upload)
	if uploadRec.Code != http.StatusCreated {
		t.Fatalf("upload status = %d, want 201, body = %s", uploadRec.Code, uploadRec.Body.String())
	}

	directoryRec := env.do(t, http.MethodPost, base+"/files/directories", env.admin, env.tenantID, map[string]any{
		"relativePath": "uploads/invoices",
	})
	if directoryRec.Code != http.StatusCreated {
		t.Fatalf("directory status = %d, want 201, body = %s", directoryRec.Code, directoryRec.Body.String())
	}
	urlRec := env.do(t, http.MethodPost, base+"/files/download-url", env.admin, env.tenantID, map[string]any{
		"relativePath": "uploads/invoice.txt",
	})
	if urlRec.Code != http.StatusOK {
		t.Fatalf("download URL status = %d, want 200, body = %s", urlRec.Code, urlRec.Body.String())
	}

	deleteRec := env.do(t, http.MethodDelete, base, env.admin, env.tenantID, nil)
	if deleteRec.Code != http.StatusOK {
		t.Fatalf("delete status = %d, want 200, body = %s", deleteRec.Code, deleteRec.Body.String())
	}

	for _, request := range []struct {
		name   string
		method string
		path   string
		body   any
	}{
		{name: "list", method: http.MethodGet, path: "/files"},
		{name: "directory", method: http.MethodPost, path: "/files/directories", body: map[string]any{"relativePath": "uploads/recreated"}},
		{name: "move", method: http.MethodPost, path: "/files/move", body: map[string]any{"from": "uploads/invoice.txt", "to": "uploads/recreated/invoice.txt"}},
		{name: "delete file", method: http.MethodDelete, path: "/files?relativePath=uploads/invoice.txt"},
		{name: "download URL", method: http.MethodPost, path: "/files/download-url", body: map[string]any{"relativePath": "uploads/invoice.txt"}},
	} {
		t.Run(request.name, func(t *testing.T) {
			rec := env.do(t, request.method, base+request.path, env.admin, env.tenantID, request.body)
			if rec.Code != http.StatusGone {
				t.Fatalf("status = %d, want 410, body = %s", rec.Code, rec.Body.String())
			}
			var body errorBody
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatalf("decode error: %v", err)
			}
			if body.Error.Code != "session_expired" {
				t.Fatalf("error code = %q, want session_expired", body.Error.Code)
			}
		})
	}

	purgedUpload := httptest.NewRequest(http.MethodPost, base+"/files?directory=recreated", bytes.NewReader(uploadBody))
	purgedUpload.Header = upload.Header.Clone()
	purgedUploadRec := httptest.NewRecorder()
	env.router.ServeHTTP(purgedUploadRec, purgedUpload)
	if purgedUploadRec.Code != http.StatusGone {
		t.Fatalf("purged upload status = %d, want 410, body = %s", purgedUploadRec.Code, purgedUploadRec.Body.String())
	}
	layout, err := paths.Session(env.server.Config, created.Session.ID)
	if err != nil {
		t.Fatalf("session paths: %v", err)
	}
	for _, root := range []string{layout.Root, filepath.Dir(layout.Files.Root), layout.Artifacts} {
		if _, err := os.Stat(root); !os.IsNotExist(err) {
			t.Fatalf("purged session path %s exists or cannot be checked: %v", root, err)
		}
	}
}

func TestSessionDeletionWaitsForFileUpload(t *testing.T) {
	t.Parallel()

	env := newSessionTestEnv(t, func(cfg *config.Config) {
		cfg.SessionUploadMaxFileBytes = 1 << 20
		cfg.SessionStorageQuotaBytes = 16 << 20
	})
	created, err := env.server.Sessions.Create(context.Background(), session.CreateInput{
		TenantID:       env.tenantID,
		BrowserChannel: "chromium",
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	base := "/api/sessions/" + created.Session.ID
	payload, contentType := sessionFileMultipart(t)
	started := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once
	finishUpload := func() { releaseOnce.Do(func() { close(release) }) }
	defer finishUpload()
	reader := &blockingSessionFileBody{reader: bytes.NewReader(payload), started: started, release: release}
	upload := httptest.NewRequest(http.MethodPost, base+"/files", reader)
	upload.Header.Set("Authorization", "Bearer "+env.admin)
	upload.Header.Set(auth.TenantHeader, env.tenantID)
	upload.Header.Set("Content-Type", contentType)
	uploadRec := httptest.NewRecorder()
	uploadDone := make(chan struct{})
	go func() {
		env.router.ServeHTTP(uploadRec, upload)
		close(uploadDone)
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("upload did not start reading its body")
	}

	deletion := httptest.NewRequest(http.MethodDelete, base, nil)
	deletion.Header.Set("Authorization", "Bearer "+env.admin)
	deletion.Header.Set(auth.TenantHeader, env.tenantID)
	deleteRec := httptest.NewRecorder()
	deleteDone := make(chan struct{})
	go func() {
		env.router.ServeHTTP(deleteRec, deletion)
		close(deleteDone)
	}()
	deletedDuringUpload := false
	select {
	case <-deleteDone:
		deletedDuringUpload = true
	case <-time.After(100 * time.Millisecond):
	}
	finishUpload()
	select {
	case <-uploadDone:
	case <-time.After(5 * time.Second):
		t.Fatal("upload did not finish")
	}
	select {
	case <-deleteDone:
	case <-time.After(5 * time.Second):
		t.Fatal("deletion did not finish after upload")
	}
	if deletedDuringUpload {
		t.Fatal("deletion completed while the upload was still streaming")
	}
	if uploadRec.Code != http.StatusCreated {
		t.Fatalf("upload status = %d, want 201, body = %s", uploadRec.Code, uploadRec.Body.String())
	}
	if deleteRec.Code != http.StatusOK {
		t.Fatalf("delete status = %d, want 200, body = %s", deleteRec.Code, deleteRec.Body.String())
	}
	layout, err := paths.Session(env.server.Config, created.Session.ID)
	if err != nil {
		t.Fatalf("session paths: %v", err)
	}
	if _, err := os.Stat(filepath.Dir(layout.Files.Root)); !os.IsNotExist(err) {
		t.Fatalf("upload storage survived deletion: %v", err)
	}
}

func TestSessionUploadsCanStreamConcurrently(t *testing.T) {
	t.Parallel()
	env := newSessionTestEnv(t, func(cfg *config.Config) {
		cfg.SessionUploadMaxFileBytes = 1 << 20
		cfg.SessionStorageQuotaBytes = 16 << 20
	})
	created, err := env.server.Sessions.Create(context.Background(), session.CreateInput{
		TenantID: env.tenantID, BrowserChannel: "chromium",
	})
	if err != nil {
		t.Fatal(err)
	}
	payload, contentType := sessionFileMultipart(t)
	release := make(chan struct{})
	var releaseOnce sync.Once
	finish := func() { releaseOnce.Do(func() { close(release) }) }
	defer finish()
	results := make(chan *httptest.ResponseRecorder, 2)
	for range 2 {
		started := make(chan struct{})
		reader := &blockingSessionFileBody{reader: bytes.NewReader(payload), started: started, release: release}
		request := httptest.NewRequest(http.MethodPost, "/api/sessions/"+created.Session.ID+"/files", reader)
		request.Header.Set("Authorization", "Bearer "+env.admin)
		request.Header.Set(auth.TenantHeader, env.tenantID)
		request.Header.Set("Content-Type", contentType)
		go func() {
			recorder := httptest.NewRecorder()
			env.router.ServeHTTP(recorder, request)
			results <- recorder
		}()
		select {
		case <-started:
		case <-time.After(5 * time.Second):
			t.Fatal("a concurrent upload could not begin streaming")
		}
	}
	finish()
	names := make([]string, 0, 2)
	for range 2 {
		select {
		case recorder := <-results:
			if recorder.Code != http.StatusCreated {
				t.Fatalf("upload status = %d, body = %s", recorder.Code, recorder.Body.String())
			}
			var body struct {
				Files []struct{ Name string } `json:"files"`
			}
			if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if len(body.Files) != 1 {
				t.Fatalf("uploaded files = %#v, want one", body.Files)
			}
			names = append(names, body.Files[0].Name)
		case <-time.After(5 * time.Second):
			t.Fatal("concurrent upload did not finish")
		}
	}
	slices.Sort(names)
	if !slices.Equal(names, []string{"invoice-1.txt", "invoice.txt"}) {
		t.Fatalf("uploaded names = %q", names)
	}
}

func sessionFileMultipart(t *testing.T) ([]byte, string) {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("files", "invoice.txt")
	if err != nil {
		t.Fatalf("create multipart part: %v", err)
	}
	if _, err := io.WriteString(part, "invoice contents"); err != nil {
		t.Fatalf("write multipart part: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("finish multipart body: %v", err)
	}
	return body.Bytes(), writer.FormDataContentType()
}

type blockingSessionFileBody struct {
	reader  io.Reader
	started chan struct{}
	release chan struct{}
	once    sync.Once
}

func (r *blockingSessionFileBody) Read(buffer []byte) (int, error) {
	r.once.Do(func() {
		close(r.started)
		<-r.release
	})
	return r.reader.Read(buffer)
}

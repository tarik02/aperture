package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/aperture/aperture/internal/auth"
	"github.com/aperture/aperture/internal/browser"
	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/db"
	"github.com/aperture/aperture/internal/recording"
)

const testRecordingID = "550e8400-e29b-41d4-a716-446655440000"

// fakeWrapper stands in for a session's wrapper: it records what the daemon asks and answers
// with one recording, or with the status it is told to refuse with.
type fakeWrapper struct {
	server  *httptest.Server
	mu      sync.Mutex
	calls   []fakeWrapperCall
	refuse  int    // status to answer every call with, when not 0
	message string // its message
}

type fakeWrapperCall struct {
	Method, Path string
	Body         map[string]any
}

func newFakeWrapper(t *testing.T) *fakeWrapper {
	t.Helper()
	w := &fakeWrapper{}
	w.server = httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, req *http.Request) {
		call := fakeWrapperCall{Method: req.Method, Path: req.URL.Path}
		_ = json.NewDecoder(req.Body).Decode(&call.Body)
		w.mu.Lock()
		w.calls = append(w.calls, call)
		refuse, message := w.refuse, w.message
		w.mu.Unlock()
		if refuse != 0 {
			rw.WriteHeader(refuse)
			_ = json.NewEncoder(rw).Encode(map[string]string{"error": message})
			return
		}
		rec := map[string]any{
			"recordingId": testRecordingID, "mode": "tab", "targetId": "T1", "captureGeneration": 1,
			"status": "running", "relativePath": "recordings/recording-" + testRecordingID + ".webm", "path": "recordings/recording-" + testRecordingID + ".webm",
			"startedAt": "2026-10-04T10:00:00Z", "fps": 60, "bitrateKbps": 6000, "codec": "vp8", "editing": false,
		}
		switch {
		case strings.HasSuffix(req.URL.Path, "/stop"):
			_, _ = rw.Write([]byte("v")) // the wrapper's stop answers with the video
		case strings.Contains(req.URL.Path, "/annotations/"):
			rw.WriteHeader(http.StatusNoContent)
		case req.Method == http.MethodPost:
			rw.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(rw).Encode(rec)
		default:
			// The recording was stopped and still edits; one of its paths is one the wrapper should never report.
			rec["status"], rec["stopReason"], rec["stoppedAt"], rec["sizeBytes"], rec["editing"] = "stopped", "requested", "2026-10-04T10:01:00Z", 1234, true
			rec["timelineRelativePath"] = "../escaped.json"
			_ = json.NewEncoder(rw).Encode(rec)
		}
	}))
	t.Cleanup(w.server.Close)
	return w
}

func (w *fakeWrapper) requests() []fakeWrapperCall {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]fakeWrapperCall(nil), w.calls...)
}

func (w *fakeWrapper) refuseWith(status int, message string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.refuse, w.message = status, message
}

// recordingTestEnv is a session test env with a running session whose wrapper is a fake.
type recordingTestEnv struct {
	*testEnv
	sessionID string
	token     string
	wrapper   *fakeWrapper
}

func newRecordingTestEnv(t *testing.T, ffmpeg string) *recordingTestEnv {
	t.Helper()
	env := newSessionTestEnv(t, func(cfg *config.Config) { cfg.RecordingFFmpegExecutable = ffmpeg })
	token, err := env.service.CreateToken(context.Background(), auth.CreateTokenInput{
		AuthorityType: auth.AuthorityTenant, TenantID: &env.tenantID, Name: "recorder", Scopes: []string{auth.ScopeSessionsWrite},
	})
	if err != nil {
		t.Fatal(err)
	}
	created := env.do(t, http.MethodPost, "/api/sessions", token.Raw, "", map[string]any{"browser": map[string]any{"channel": "chromium", "args": []string{}}})
	if created.Code != http.StatusCreated {
		t.Fatalf("create session: %d %s", created.Code, created.Body.String())
	}
	var response createSessionResponse
	if err := json.Unmarshal(created.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	wrapper := newFakeWrapper(t)
	// The session's runtime env names its wrapper port; point it at the fake.
	row, err := env.repo.GetSessionByID(context.Background(), response.Session.ID)
	if err != nil || row == nil || row.RuntimeEnvPath == nil {
		t.Fatalf("session row = %+v, %v", row, err)
	}
	body, err := os.ReadFile(*row.RuntimeEnvPath)
	if err != nil {
		t.Fatal(err)
	}
	values, err := browser.ParseRuntimeEnv(body)
	if err != nil {
		t.Fatal(err)
	}
	values.WrapperPort = wrapper.server.Listener.Addr().(*net.TCPAddr).Port
	if err := browser.WriteRuntimeEnv(*row.RuntimeEnvPath, values); err != nil {
		t.Fatal(err)
	}
	return &recordingTestEnv{testEnv: env, sessionID: response.Session.ID, token: token.Raw, wrapper: wrapper}
}

// suspend marks the session suspended as the monitor would; the fake runner has nothing to stop.
func (env *recordingTestEnv) suspend(t *testing.T) {
	t.Helper()
	row, err := env.repo.GetSessionByID(context.Background(), env.sessionID)
	if err != nil {
		t.Fatal(err)
	}
	row.Status = db.SessionStatusSuspended
	if err := env.repo.UpdateSession(context.Background(), row); err != nil {
		t.Fatal(err)
	}
}

func (env *recordingTestEnv) status(t *testing.T) string {
	t.Helper()
	row, err := env.repo.GetSessionByID(context.Background(), env.sessionID)
	if err != nil {
		t.Fatal(err)
	}
	return row.Status
}

func (env *recordingTestEnv) recordings(t *testing.T, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	return env.do(t, method, "/api/sessions/"+env.sessionID+"/recordings"+path, env.token, "", body)
}

func errorCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var body errorBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body %s: %v", rec.Body.String(), err)
	}
	return body.Error.Code
}

func TestRecordingStartIsCheckedBeforeTheWrapperAndTheWake(t *testing.T) {
	t.Parallel()
	env := newRecordingTestEnv(t, "/usr/bin/ffmpeg")
	env.suspend(t)
	rec := env.recordings(t, http.MethodPost, "", map[string]any{"targetId": "T1", "capture": "bursts", "idle": "cut"})
	if rec.Code != http.StatusBadRequest || errorCode(t, rec) != "validation_failed" {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if calls := env.wrapper.requests(); len(calls) != 0 || env.status(t) != db.SessionStatusSuspended {
		t.Fatalf("wrapper saw %v, session is %s", calls, env.status(t))
	}
}

func TestRecordingEditsNeedFFmpegOnTheInstance(t *testing.T) {
	t.Parallel()
	env := newRecordingTestEnv(t, "")
	rec := env.recordings(t, http.MethodPost, "", map[string]any{"targetId": "T1", "idle": "cut"})
	if rec.Code != http.StatusBadRequest || errorCode(t, rec) != "validation_failed" || !strings.Contains(rec.Body.String(), "recording_ffmpeg_executable") {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	// Pace and motion only steer the automation, so they need no ffmpeg; the start reaches the
	// wrapper with the config filled, a natural motion with its seed.
	rec = env.recordings(t, http.MethodPost, "", map[string]any{"targetId": "T1", "pace": "slow", "motion": "natural"})
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	calls := env.wrapper.requests()
	if len(calls) != 1 || calls[0].Path != "/recordings" || calls[0].Body["pace"] != "slow" || calls[0].Body["capture"] != "continuous" {
		t.Fatalf("wrapper saw %+v", calls)
	}
	if motion, _ := calls[0].Body["motion"].(map[string]any); motion["type"] != "natural" || motion["seed"] == nil {
		t.Fatalf("wrapper saw %+v", calls)
	}
}

func TestRecordingStopReturnsTheEditingRecording(t *testing.T) {
	t.Parallel()
	env := newRecordingTestEnv(t, "/usr/bin/ffmpeg")
	rec := env.recordings(t, http.MethodPost, "/"+testRecordingID+"/stop", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var response recordingResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.RecordingID != testRecordingID || response.Status != "stopped" || !response.Editing || response.RelativePath != "recordings/recording-"+testRecordingID+".webm" {
		t.Fatalf("response = %+v", response)
	}
	// The escaped timeline path is dropped, not an error.
	if response.TimelineRelativePath != "" || response.EditedRelativePath != "" {
		t.Fatalf("edit paths = %q, %q", response.EditedRelativePath, response.TimelineRelativePath)
	}
	calls := env.wrapper.requests()
	if len(calls) != 2 || calls[0].Method != http.MethodPost || !strings.HasSuffix(calls[0].Path, "/stop") || calls[1].Method != http.MethodGet {
		t.Fatalf("wrapper saw %+v", calls)
	}
}

func TestWrapperRefusalsMapToRecordingErrors(t *testing.T) {
	t.Parallel()
	for status, want := range map[int]error{
		http.StatusBadRequest: recording.ErrInvalid, http.StatusNotFound: errRecordingNotFound,
		http.StatusConflict: errRecordingInvalidState, http.StatusUnprocessableEntity: errRecordingCodecUnavailable,
		http.StatusInternalServerError: errBrowserControlFailed,
	} {
		if err := mapWrapperRecordingStatus(status, "why"); !errors.Is(err, want) {
			t.Errorf("%d: %v", status, err)
		}
	}
	env := newRecordingTestEnv(t, "/usr/bin/ffmpeg")
	env.wrapper.refuseWith(http.StatusConflict, "recording capacity is exhausted")
	rec := env.recordings(t, http.MethodPost, "", map[string]any{"targetId": "T1"})
	if rec.Code != http.StatusConflict || errorCode(t, rec) != "recording_invalid_state" {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

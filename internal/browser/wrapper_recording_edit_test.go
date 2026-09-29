package browser

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aperture/aperture/internal/paths"
	"github.com/aperture/aperture/internal/recording/edit"
	"github.com/aperture/aperture/internal/recording/timeline"
)

// fakeEdits stands in for ffmpeg: it records what it was asked and answers with
// a scripted result.
type fakeEdits struct {
	mu      sync.Mutex
	calls   []edit.RunOptions
	timelns []*timeline.Timeline
	// run decides the outcome; the default writes a small edited video.
	run func(ctx context.Context, options edit.RunOptions, tl *timeline.Timeline) (*edit.Result, error)
}

func (f *fakeEdits) install(t *testing.T) {
	t.Helper()
	original := runRecordingEdit
	runRecordingEdit = func(ctx context.Context, options edit.RunOptions, tl *timeline.Timeline) (*edit.Result, error) {
		f.mu.Lock()
		f.calls = append(f.calls, options)
		f.timelns = append(f.timelns, tl)
		run := f.run
		f.mu.Unlock()
		if run != nil {
			return run(ctx, options, tl)
		}
		output := filepath.Join(options.WorkDir, edit.OutputName)
		if err := os.WriteFile(output, []byte("edited video"), 0o600); err != nil {
			return nil, err
		}
		return &edit.Result{Output: output, Plan: &edit.Plan{Warnings: []string{"a warning"}}}, nil
	}
	t.Cleanup(func() { runRecordingEdit = original })
}

func (f *fakeEdits) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

type editFixture struct {
	session   *liveSession
	runtime   *wrapperRuntime
	recording *wrapperRecording
	root      string
	raw       string
	// closeSession ends the wrapper's context, as closing the session does.
	closeSession context.CancelFunc
}

// newEditFixture makes a live session with one stopped recording that has a
// timeline with a caption (an effect to apply), or none.
func newEditFixture(t *testing.T, captioned bool) *editFixture {
	t.Helper()
	root := t.TempDir()
	files := paths.SessionFiles(root)
	if err := os.MkdirAll(files.Recordings, 0o755); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	runtime := &wrapperRuntime{ctx: ctx, values: RuntimeEnvValues{FilesDir: root, RecordingFFmpegExecutable: "/usr/bin/ffmpeg", RecordingEditThreads: 2, RecordingEditTimeout: time.Minute}}
	session := &liveSession{runtime: runtime, recordings: map[string]*wrapperRecording{}}
	raw := filepath.Join(files.Recordings, "recording-x.webm")
	if err := os.WriteFile(raw, []byte("raw video"), 0o644); err != nil {
		t.Fatal(err)
	}

	started := time.Now().Add(-10 * time.Second)
	builder := timeline.NewBuilder(timeline.Limits{})
	builder.BeginSegment(timeline.SegmentInput{TargetID: "t", CaptureID: "c", Width: 1280, Height: 720, Started: started})
	builder.EndSegment(0, started.Add(8*time.Second))
	if captioned {
		builder.AddCaption(timeline.CaptionInput{Tool: "browser_type", Text: "Type", Start: started.Add(time.Second), End: started.Add(2 * time.Second)})
	}
	built, err := builder.Build(timeline.BuildOptions{Recording: timeline.Recording{ID: "x", Video: "recordings/recording-x.webm", FPS: 30}})
	if err != nil {
		t.Fatal(err)
	}
	collector := &recordingTimeline{builder: builder}
	collector.setBuilt(built)
	recording := &wrapperRecording{
		ID: "x", Mode: wrapperRecordingModeTab, Status: wrapperRecordingStopped, StopReason: "requested", Path: raw, filesRoot: root,
		operationMu: &sync.Mutex{}, timeline: collector, Codec: "vp8", FPS: 30,
	}
	recording.setStoppedEdit(edit.Wanted(built))
	session.recordings["x"] = recording
	return &editFixture{session: session, runtime: runtime, recording: recording, root: root, raw: raw, closeSession: cancel}
}

func (f *editFixture) files() []string {
	entries, _ := os.ReadDir(filepath.Join(f.root, "recordings"))
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	return names
}

func TestEditingAStoppedRecordingPublishesTheEditedVideoNextToTheRaw(t *testing.T) {
	fake := &fakeEdits{}
	fake.install(t)
	fixture := newEditFixture(t, true)

	status := fixture.session.editStoppedRecording(context.Background(), *fixture.recording)
	if status.EditedRelativePath != "recordings/recording-x.edited.mp4" || status.EditError != nil {
		t.Fatalf("status %+v", status)
	}
	if len(status.EditWarnings) != 1 || status.EditWarnings[0] != "a warning" {
		t.Errorf("warnings %v", status.EditWarnings)
	}
	edited, err := os.ReadFile(filepath.Join(fixture.root, "recordings", "recording-x.edited.mp4"))
	if err != nil || string(edited) != "edited video" {
		t.Errorf("edited video %q err %v", edited, err)
	}
	if raw, _ := os.ReadFile(fixture.raw); string(raw) != "raw video" {
		t.Errorf("the raw video changed: %q", raw)
	}
	// The hidden work directory is gone.
	if names := fixture.files(); len(names) != 2 {
		t.Errorf("files %v, want the raw and the edited video", names)
	}
	call := fake.calls[0]
	if call.Source != fixture.raw || call.FFmpeg != "/usr/bin/ffmpeg" || call.Threads != 2 || call.MaxTime != time.Minute {
		t.Errorf("run options %+v", call)
	}
	if !strings.HasPrefix(filepath.Base(call.WorkDir), editWorkPrefix) || filepath.Dir(call.WorkDir) != filepath.Join(fixture.root, "recordings") {
		t.Errorf("work dir %s", call.WorkDir)
	}

	// Stopping again does not edit again, and reports the same.
	again := fixture.session.editStoppedRecording(context.Background(), *fixture.recording)
	if fake.count() != 1 || again.EditedRelativePath != status.EditedRelativePath {
		t.Errorf("calls %d, status %+v", fake.count(), again)
	}
	// The status a client reads carries it.
	body, err := json.Marshal(again)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["editedRelativePath"] != "recordings/recording-x.edited.mp4" || decoded["editWarnings"] == nil || decoded["editError"] != nil {
		t.Errorf("status JSON %s", body)
	}
}

func TestEditedVideoNamesAreNeverTaken(t *testing.T) {
	(&fakeEdits{}).install(t)
	fixture := newEditFixture(t, true)
	taken := filepath.Join(fixture.root, "recordings", "recording-x.edited.mp4")
	if err := os.WriteFile(taken, []byte("the user's file"), 0o644); err != nil {
		t.Fatal(err)
	}
	status := fixture.session.editStoppedRecording(context.Background(), *fixture.recording)
	if status.EditedRelativePath != "recordings/recording-x.edited-1.mp4" {
		t.Errorf("status %+v", status)
	}
	if content, _ := os.ReadFile(taken); string(content) != "the user's file" {
		t.Errorf("an existing file was replaced: %q", content)
	}
}

func TestEditedVideoOfANumberedRawVideoIsNumberedToo(t *testing.T) {
	(&fakeEdits{}).install(t)
	fixture := newEditFixture(t, true)
	numbered := filepath.Join(fixture.root, "recordings", "recording-x-1.webm")
	if err := os.Rename(fixture.raw, numbered); err != nil {
		t.Fatal(err)
	}
	fixture.recording.Path = numbered
	status := fixture.session.editStoppedRecording(context.Background(), *fixture.recording)
	if status.EditedRelativePath != "recordings/recording-x-1.edited.mp4" {
		t.Errorf("status %+v", status)
	}
}

func TestARecordingWithNothingToApplyIsNotEdited(t *testing.T) {
	fake := &fakeEdits{}
	fake.install(t)
	fixture := newEditFixture(t, false)
	status := fixture.session.editStoppedRecording(context.Background(), *fixture.recording)
	if fake.count() != 0 || status.EditedRelativePath != "" || status.EditError != nil || status.EditWarnings != nil {
		t.Errorf("calls %d, status %+v", fake.count(), status)
	}
	if names := fixture.files(); len(names) != 1 {
		t.Errorf("files %v", names)
	}
}

func TestAFailedEditKeepsTheRawRecordingAndSaysWhy(t *testing.T) {
	fake := &fakeEdits{run: func(_ context.Context, options edit.RunOptions, _ *timeline.Timeline) (*edit.Result, error) {
		// A half written output must not be published.
		_ = os.WriteFile(filepath.Join(options.WorkDir, edit.OutputName), []byte("partial"), 0o600)
		return nil, &edit.Error{Code: edit.CodeFFmpegFailed, Message: "ffmpeg failed: bad frames"}
	}}
	fake.install(t)
	fixture := newEditFixture(t, true)
	status := fixture.session.editStoppedRecording(context.Background(), *fixture.recording)
	if status.EditedRelativePath != "" || status.EditError == nil || status.EditError.Code != "ffmpeg_failed" || !strings.Contains(status.EditError.Message, "bad frames") {
		t.Fatalf("status %+v", status)
	}
	if names := fixture.files(); len(names) != 1 || names[0] != "recording-x.webm" {
		t.Errorf("files %v", names)
	}
	// A failure is final: a second stop does not try again.
	fixture.session.editStoppedRecording(context.Background(), *fixture.recording)
	if fake.count() != 1 {
		t.Errorf("calls %d", fake.count())
	}
	// And is what a client reads.
	body, _ := json.Marshal(status)
	if !strings.Contains(string(body), `"editError":{"code":"ffmpeg_failed"`) {
		t.Errorf("status JSON %s", body)
	}
}

func TestAnUnexpectedEditFailureIsReportedAsInternal(t *testing.T) {
	fake := &fakeEdits{run: func(context.Context, edit.RunOptions, *timeline.Timeline) (*edit.Result, error) {
		return nil, errors.New("disk on fire")
	}}
	fake.install(t)
	fixture := newEditFixture(t, true)
	status := fixture.session.editStoppedRecording(context.Background(), *fixture.recording)
	if status.EditError == nil || status.EditError.Code != "internal" {
		t.Errorf("status %+v", status)
	}
}

func TestACancelledEditIsRetriedByTheNextStop(t *testing.T) {
	calls := 0
	fake := &fakeEdits{}
	fake.run = func(ctx context.Context, options edit.RunOptions, _ *timeline.Timeline) (*edit.Result, error) {
		calls++
		if calls == 1 {
			<-ctx.Done()
			return nil, &edit.Error{Code: edit.CodeCanceled, Message: "the edit was cancelled"}
		}
		output := filepath.Join(options.WorkDir, edit.OutputName)
		_ = os.WriteFile(output, []byte("edited video"), 0o600)
		return &edit.Result{Output: output, Plan: &edit.Plan{}}, nil
	}
	fake.install(t)
	fixture := newEditFixture(t, true)

	// The caller gives up while the edit renders.
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan wrapperRecording, 1)
	go func() { done <- fixture.session.editStoppedRecording(ctx, *fixture.recording) }()
	time.Sleep(50 * time.Millisecond)
	cancel()
	status := <-done
	if status.EditedRelativePath != "" || status.EditError != nil {
		t.Fatalf("a cancelled edit leaves no trace: %+v", status)
	}
	if names := fixture.files(); len(names) != 1 {
		t.Errorf("files %v: the work directory is removed", names)
	}
	status = fixture.session.editStoppedRecording(context.Background(), *fixture.recording)
	if status.EditedRelativePath != "recordings/recording-x.edited.mp4" || calls != 2 {
		t.Errorf("status %+v after %d calls", status, calls)
	}
}

func TestClosingTheSessionEndsTheEdit(t *testing.T) {
	started := make(chan struct{})
	fake := &fakeEdits{run: func(ctx context.Context, _ edit.RunOptions, _ *timeline.Timeline) (*edit.Result, error) {
		close(started)
		<-ctx.Done()
		return nil, &edit.Error{Code: edit.CodeCanceled, Message: "cancelled"}
	}}
	fake.install(t)
	fixture := newEditFixture(t, true)
	done := make(chan struct{})
	go func() {
		fixture.session.editStoppedRecording(context.Background(), *fixture.recording)
		close(done)
	}()
	<-started
	fixture.closeSession()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the edit did not stop when the session closed")
	}
	if names := fixture.files(); len(names) != 1 {
		t.Errorf("files %v", names)
	}
}

func TestEditingIsUnavailableWithoutFFmpeg(t *testing.T) {
	// The real runner refuses without an ffmpeg.
	fixture := newEditFixture(t, true)
	fixture.runtime.values.RecordingFFmpegExecutable = ""
	status := fixture.session.editStoppedRecording(context.Background(), *fixture.recording)
	if status.EditError == nil || status.EditError.Code != "unavailable" || status.EditedRelativePath != "" {
		t.Errorf("status %+v", status)
	}
}

func TestStoppingOnRequestEditsBeforeAnswering(t *testing.T) {
	fake := &fakeEdits{}
	fake.install(t)
	fixture := newEditFixture(t, true)
	request := httptest.NewRequest(http.MethodPost, "/recordings/x/stop", bytes.NewReader(nil))
	recorder := httptest.NewRecorder()
	fixture.session.handleRecording(recorder, request)
	if recorder.Code != http.StatusOK && recorder.Code != http.StatusPartialContent {
		t.Fatalf("status %d: %s", recorder.Code, recorder.Body.String())
	}
	if fake.count() != 1 {
		t.Errorf("the edit did not run before the answer: %d calls", fake.count())
	}
	get := httptest.NewRecorder()
	fixture.session.handleRecording(get, httptest.NewRequest(http.MethodGet, "/recordings/x", nil))
	var status map[string]any
	if err := json.Unmarshal(get.Body.Bytes(), &status); err != nil || status["editedRelativePath"] != "recordings/recording-x.edited.mp4" || status["relativePath"] != "recordings/recording-x.webm" {
		t.Errorf("status %s err %v", get.Body.String(), err)
	}
}

func TestSweepRecordingEditsRemovesOnlyWorkDirectories(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{".edit-a", ".edit-b/nested"} {
		if err := os.MkdirAll(filepath.Join(dir, name), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"recording-a.webm", "recording-a.edited.mp4", ".edit-file"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Join(dir, ".recording-c"), 0o755); err != nil {
		t.Fatal(err)
	}
	sweepRecordingEdits(dir)
	entries, _ := os.ReadDir(dir)
	var names []string
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	if strings.Join(names, ",") != ".edit-file,.recording-c,recording-a.edited.mp4,recording-a.webm" {
		t.Errorf("left %v", names)
	}
}

func TestStartingWithEffectsChecksTheRequestAndTheHost(t *testing.T) {
	root := t.TempDir()
	runtime := &wrapperRuntime{ctx: context.Background(), values: RuntimeEnvValues{FilesDir: root}}
	session := &liveSession{runtime: runtime, recordings: map[string]*wrapperRecording{}}
	start := func(body string) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		session.handleRecordings(recorder, httptest.NewRequest(http.MethodPost, "/recordings", strings.NewReader(body)))
		return recorder
	}
	if recorder := start(`{"mode":"tab","targetId":"t","idle":"sideways"}`); recorder.Code != http.StatusBadRequest {
		t.Errorf("a bad idle mode: %d %s", recorder.Code, recorder.Body.String())
	}
	if recorder := start(`{"mode":"tab","targetId":"t","zoom":9}`); recorder.Code != http.StatusBadRequest {
		t.Errorf("a bad zoom: %d %s", recorder.Code, recorder.Body.String())
	}
	if recorder := start(`{"mode":"tab","targetId":"t","ripple":true}`); recorder.Code != http.StatusNotImplemented || !strings.Contains(recorder.Body.String(), "ffmpeg") {
		t.Errorf("effects without ffmpeg: %d %s", recorder.Code, recorder.Body.String())
	}
	// With an ffmpeg the request is accepted as far as the missing target registry.
	runtime.values.RecordingFFmpegExecutable = "/usr/bin/ffmpeg"
	if recorder := start(`{"mode":"tab","targetId":"t","ripple":true,"idle":"cut","zoom":1.8}`); recorder.Code != http.StatusConflict || !strings.Contains(recorder.Body.String(), "registry") {
		t.Errorf("valid effects: %d %s", recorder.Code, recorder.Body.String())
	}
}

package browser

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aperture/aperture/internal/recording"
	"github.com/google/uuid"
)

// stoppableRecording is a running recording whose capture pipeline is gone and whose one segment
// holds a second of video, so stopping it publishes the segment as the raw video.
func stoppableRecording(t *testing.T, session *liveSession, id string, config recording.Config) *wrapperRecording {
	t.Helper()
	rec := &wrapperRecording{ID: id, Status: wrapperRecordingRunning, FPS: 30, Codec: "vp8", config: config, operationMu: &sync.Mutex{}}
	rec.journal = newRecordingJournal(t.TempDir())
	rec.segmentDir = t.TempDir()
	rec.Path = filepath.Join(t.TempDir(), id+".webm")
	segment := newRecordingSegment(filepath.Join(rec.segmentDir, "segment-0000.webm"), wrapperTargetSnapshot{TargetID: "T1", Viewport: compositorViewport{Width: 320, Height: 240, ContentWidth: 320, ContentHeight: 240, CanvasWidth: 320, CanvasHeight: 240}})
	segment.clock = newFrameClock(30)
	for _, pts := range []string{"0:00:00.000000000", "0:00:01.000000000"} {
		_, _ = segment.clock.Write([]byte("/GstPipeline:pipeline0/GstIdentity:aperture_frames: last-message = chain ******* (aperture_frames:sink) (4 bytes, dts: none, pts: " + pts + ", duration: none)\n"))
	}
	rec.segments = []*recordingSegment{segment}
	if err := os.WriteFile(segment.path, []byte("not really video"), 0o600); err != nil {
		t.Fatal(err)
	}
	session.recordings[id] = rec
	session.setRecordingStatusLocked(rec, rec.Status)
	return rec
}

// waitForEdit polls until the recording's edit has ended.
func waitForEdit(t *testing.T, session *liveSession, id string) wrapperRecording {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		status, _ := session.recording(id)
		if !status.Editing {
			return status
		}
		if time.Now().After(deadline) {
			t.Fatalf("the edit of %s did not end", id)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestStopReturnsBeforeTheEditEnds(t *testing.T) {
	session := newJournalSession(t)
	rec := stoppableRecording(t, session, "r1", recording.Config{Capture: "continuous"})
	release := make(chan struct{})
	session.finalize = func(ctx context.Context, rec *wrapperRecording, video *os.File, raw string) (string, string, *recording.EditError) {
		select {
		case <-release:
		case <-ctx.Done():
		}
		return session.finalizeRecording(ctx, rec, video, raw)
	}
	status, err := session.stopRecordingRequested("r1", "requested")
	if err != nil || status.Status != wrapperRecordingStopped || !status.Editing || status.StopReason != "requested" || status.SizeBytes == 0 || status.StoppedAt == nil {
		t.Fatalf("stop = %+v, %v", status, err)
	}
	// The raw video is published and served while the edit runs, which keeps the session awake.
	session.runtime.mu.Lock()
	editing := session.editingRecordingCountLocked()
	session.runtime.mu.Unlock()
	if _, err := os.Stat(rec.Path); err != nil || editing != 1 {
		t.Fatalf("raw video: %v, editing %d", err, editing)
	}
	response := httptest.NewRecorder()
	session.handleRecording(response, httptest.NewRequest(http.MethodGet, "/recordings/r1/content", nil))
	if response.Code != http.StatusOK || response.Body.String() != "not really video" {
		t.Fatalf("content: %d %q", response.Code, response.Body.String())
	}
	// A second stop reports the recording as it is, without waiting for the edit.
	again := make(chan wrapperRecording, 1)
	go func() { status, _ := session.stopRecordingRequested("r1", "requested"); again <- status }()
	select {
	case status := <-again:
		if !status.Editing || status.Status != wrapperRecordingStopped {
			t.Fatalf("second stop = %+v", status)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("a second stop waited for the edit")
	}
	close(release)
	status = waitForEdit(t, session, "r1")
	if status.EditError != nil || status.TimelinePath != strings.TrimSuffix(rec.Path, ".webm")+".timeline.json" || status.EditedPath != "" {
		t.Fatalf("after the edit: %+v", status)
	}
	if _, err := os.Stat(rec.segmentDir); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("the work directory remains: %v", err)
	}
}

func TestCancelEndsARunningEdit(t *testing.T) {
	session := newJournalSession(t)
	// Any executable will do: ffmpeg is never started under a cancelled context.
	session.runtime.values.RecordingFFmpegExecutable = os.Args[0]
	rec := stoppableRecording(t, session, "r2", recording.Config{Capture: "continuous", Idle: "cut"})
	session.finalize = func(ctx context.Context, rec *wrapperRecording, video *os.File, raw string) (string, string, *recording.EditError) {
		<-ctx.Done()
		return session.finalizeRecording(ctx, rec, video, raw)
	}
	if status, err := session.stopRecordingRequested("r2", "requested"); err != nil || !status.Editing {
		t.Fatalf("stop = %+v, %v", status, err)
	}
	result, err := session.handleSessionCommand(&liveSessionClient{role: "owner"}, liveSessionClientMessage{Type: "recording.cancel", RecordingID: "r2"})
	if err != nil || result.Recording == nil || result.Recording.Editing {
		t.Fatalf("cancel = %+v, %v", result, err)
	}
	status := waitForEdit(t, session, "r2")
	if status.EditError == nil || status.EditError.Code != "cancelled" || !strings.Contains(status.EditError.Message, "on request") || status.Status != wrapperRecordingStopped {
		t.Fatalf("after cancel: %+v", status)
	}
	if _, err := os.Stat(rec.Path); err != nil {
		t.Errorf("the raw video is gone: %v", err)
	}
}

func TestSessionCloseCancelsEdits(t *testing.T) {
	session := newJournalSession(t)
	session.runtime.values.RecordingFFmpegExecutable = os.Args[0]
	stoppableRecording(t, session, "r3", recording.Config{Capture: "continuous", Idle: "speed"})
	session.finalize = func(ctx context.Context, rec *wrapperRecording, video *os.File, raw string) (string, string, *recording.EditError) {
		<-ctx.Done()
		return session.finalizeRecording(ctx, rec, video, raw)
	}
	if _, err := session.stopRecordingRequested("r3", "requested"); err != nil {
		t.Fatal(err)
	}
	session.stopAllRecordings("session_closed")
	status, _ := session.recording("r3")
	if status.Editing || status.EditError == nil || status.EditError.Code != "cancelled" || !strings.Contains(status.EditError.Message, "closing") {
		t.Fatalf("after close: %+v", status)
	}
}

func TestViewerRecordingsCannotCaptureBursts(t *testing.T) {
	session := newJournalSession(t)
	_, err := session.startRecording(wrapperRecordingRequest{Mode: wrapperRecordingModeViewer, ClientID: uuid.NewString(), Config: recording.Config{Capture: "bursts"}})
	if !errors.Is(err, recording.ErrInvalid) {
		t.Fatalf("err = %v", err)
	}
}

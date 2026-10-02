package browser

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func newJournalSession(t *testing.T, recordings ...*wrapperRecording) *liveSession {
	t.Helper()
	runtime := newWrapperRuntime(RuntimeEnvValues{}, "")
	runtime.ctx = context.Background()
	session := &liveSession{runtime: runtime, recordings: map[string]*wrapperRecording{}, gate: make(chan struct{}, 1)}
	for _, recording := range recordings {
		recording.journal = newRecordingJournal(t.TempDir())
		recording.segmentDir = t.TempDir()
		session.recordings[recording.ID] = recording
		session.setRecordingStatusLocked(recording, recording.Status)
	}
	return session
}

func readJournal(t *testing.T, recording *wrapperRecording) string {
	t.Helper()
	raw, _ := os.ReadFile(recording.journal.path)
	return string(raw)
}

func TestFrameClockPlacesTheFirstFrameOnTheWallClock(t *testing.T) {
	clock := newFrameClock(50)
	line := func(pts string) string {
		return "/GstPipeline:pipeline0/GstIdentity:aperture_frames: last-message = chain ******* (aperture_frames:sink) (4 bytes, dts: none, pts: " + pts + ", duration: none)\n"
	}
	// Reports arrive in arbitrary chunks, among lines of other elements and unset times.
	_, _ = clock.Write([]byte("caps = video/x-raw\n" + line("99:99:99.999999999") + line("0:00:00.040000000")[:30]))
	select {
	case <-clock.ready:
		t.Fatal("first frame was reported before a complete line")
	default:
	}
	_, _ = clock.Write([]byte(line("0:00:00.040000000")[30:] + line("0:00:01.040000000")))
	first, duration := clock.span()
	if first.IsZero() || time.Since(first) > time.Second || duration != time.Second+20*time.Millisecond {
		t.Fatalf("span = %v, %v", first, duration)
	}
	if err := clock.waitForFirstFrame(context.Background(), func() {}, nil); err != nil {
		t.Fatal(err)
	}
	// The facts a finished capture leaves for the finalizer.
	segment := newRecordingSegment("segment-0000.webm", wrapperTargetSnapshot{TargetID: "T1", Viewport: compositorViewport{Width: 640, Height: 360, ContentWidth: 1281, ContentHeight: 720, CanvasWidth: 1280, CanvasHeight: 768}})
	segment.clock = clock
	recording := &wrapperRecording{segmentDir: t.TempDir(), segments: []*recordingSegment{segment}, journal: newRecordingJournal(t.TempDir())}
	if err := writeCaptureFacts(recording); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(filepath.Join(recording.segmentDir, captureFactsFile))
	for _, want := range []string{`"targetId":"T1"`, `"durationMs":1020`, `"width":1280,"height":720`, `"viewportWidth":640,"viewportHeight":360`, fmt.Sprintf(`"firstFrameMs":%d`, first.UnixMilli())} {
		if !strings.Contains(string(raw), want) {
			t.Errorf("capture facts lack %s: %s", want, raw)
		}
	}
}

func TestJournalTakesPartOnlyWhileTheRecordingRuns(t *testing.T) {
	running := &wrapperRecording{ID: "running", Status: wrapperRecordingRunning}
	stopping := &wrapperRecording{ID: "stopping", Status: wrapperRecordingRunning, finalizing: true}
	failed := &wrapperRecording{ID: "failed", Status: wrapperRecordingFailed}
	session := newJournalSession(t, running, stopping, failed)
	session.journal("call", time.Now().Add(-time.Second), map[string]any{"tool": "browser_click", "ok": true})
	if got := readJournal(t, running); !strings.Contains(got, `"kind":"call"`) || !strings.Contains(got, `"tool":"browser_click"`) || !strings.HasSuffix(got, "\n") {
		t.Fatalf("running journal = %q", got)
	}
	if got := readJournal(t, stopping) + readJournal(t, failed); got != "" {
		t.Fatalf("journal written for recordings that do not run: %q", got)
	}
}

func TestJournalIsBounded(t *testing.T) {
	journal := newRecordingJournal(t.TempDir())
	line := []byte(strings.Repeat("x", 1<<20) + "\n")
	for range 6 {
		journal.append(line)
	}
	if info, _ := os.Stat(journal.path); info.Size() > recordingJournalBudget || journal.droppedEntries() == 0 {
		t.Fatalf("journal size %d, dropped %d", info.Size(), journal.droppedEntries())
	}
}

func TestRecordingWhoseCaptureDiedStopsCountingForTheCadence(t *testing.T) {
	recording := &wrapperRecording{ID: "r", Status: wrapperRecordingRunning, presentation: true, cmd: &exec.Cmd{}}
	done := make(chan error, 1)
	recording.done = done
	session := newJournalSession(t, recording)
	if got := session.automationCadence(); got != cadencePresentation {
		t.Fatalf("cadence while recording = %v", got)
	}
	done <- errors.New("pipeline exited")
	session.refreshRecordings()
	if got := session.automationCadence(); got != cadenceImmediate || recording.StopReason != "pipeline_exited" {
		t.Fatalf("cadence after the pipeline died = %v (%q)", got, recording.StopReason)
	}
}

func TestAnnotationsTargetTheOneRunningRecordingAndHoldTheGate(t *testing.T) {
	session := newJournalSession(t)
	caption := annotationRequest{Text: "  Open the menu ", DurationMS: 1500}
	if err := session.annotate(context.Background(), "caption", caption); err == nil || !strings.Contains(err.Error(), "no running recording") {
		t.Fatalf("err = %v", err)
	}
	first := &wrapperRecording{ID: "first", Status: wrapperRecordingRunning, TargetID: "T1"}
	second := &wrapperRecording{ID: "second", Status: wrapperRecordingRunning, TargetID: "T1"}
	session = newJournalSession(t, first)
	if err := session.annotate(context.Background(), "caption", caption); err != nil {
		t.Fatal(err)
	}
	if got := readJournal(t, first); !strings.Contains(got, `"kind":"caption"`) || !strings.Contains(got, `"text":"Open the menu"`) || !strings.Contains(got, `"durationMs":1500`) {
		t.Fatalf("journal = %q", got)
	}
	session = newJournalSession(t, first, second)
	if err := session.annotate(context.Background(), "caption", caption); err == nil || !strings.Contains(err.Error(), "recordingId") {
		t.Fatalf("ambiguous err = %v", err)
	}
	caption.RecordingID = "second"
	if err := session.annotate(context.Background(), "caption", caption); err != nil || readJournal(t, second) == "" {
		t.Fatalf("err = %v, journal = %q", err, readJournal(t, second))
	}
	for _, request := range []annotationRequest{
		{Zoom: 1, Rect: &annotationRect{Width: 10, Height: 10}},                  // no zoom
		{Zoom: 2, DurationMS: 10001, Rect: &annotationRect{Width: 1, Height: 1}}, // too long
		{Zoom: 2, Rect: &annotationRect{Width: 1, Height: 1}, Selector: "#a"},    // two places
		{Zoom: 2, DurationMS: 200},                                               // no place
	} {
		request.RecordingID = "second"
		if err := session.annotate(context.Background(), "focus", request); !errors.Is(err, errAnnotationInvalid) {
			t.Errorf("focus %+v: err = %v", request, err)
		}
	}
	// Focus blocks for its duration with the gate held, so a browser call waits for it.
	focus := annotationRequest{RecordingID: "second", Zoom: 2, DurationMS: 200, Rect: &annotationRect{X: 1, Y: 2, Width: 30, Height: 40}}
	started := time.Now()
	finished := make(chan error, 1)
	go func() { finished <- session.annotate(context.Background(), "focus", focus) }()
	time.Sleep(50 * time.Millisecond)
	release, err := session.acquireGate(context.Background())
	if err != nil || time.Since(started) < 200*time.Millisecond {
		t.Fatalf("a browser call got in during focus after %v (%v)", time.Since(started), err)
	}
	release()
	if err := <-finished; err != nil || !strings.Contains(readJournal(t, second), `"rect":{"x":1,"y":2,"width":30,"height":40}`) {
		t.Fatalf("err = %v, journal = %q", err, readJournal(t, second))
	}
}

func TestFirstFrameWaitRepaintsAndEndsWithThePipeline(t *testing.T) {
	clock := newFrameClock(60)
	repaints := make(chan struct{}, 1)
	exited := make(chan error, 1)
	go func() {
		<-repaints
		exited <- errors.New("exit status 1")
	}()
	err := clock.waitForFirstFrame(context.Background(), func() {
		select {
		case repaints <- struct{}{}:
		default:
		}
	}, exited)
	if !errors.Is(err, errCapturePipelineExited) {
		t.Fatalf("err = %v", err)
	}
}

package browser

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/aperture/aperture/internal/pointer"
)

func ptr[T any](value T) *T { return &value }

func TestRecordingRequestValidation(t *testing.T) {
	tab := wrapperRecordingRequest{Mode: wrapperRecordingModeTab}
	for name, test := range map[string]struct {
		request wrapperRecordingRequest
		wantErr string
	}{
		"continuous by default": {request: tab},
		"bursts":                {request: wrapperRecordingRequest{Mode: wrapperRecordingModeTab, Capture: wrapperRecordingCaptureBursts}},
		"unknown capture":       {request: wrapperRecordingRequest{Mode: wrapperRecordingModeTab, Capture: "sometimes"}, wantErr: "capture must be"},
		"viewer bursts": {
			request: wrapperRecordingRequest{Mode: wrapperRecordingModeViewer, Capture: wrapperRecordingCaptureBursts}, wantErr: "tab recordings",
		},
		"burst without bursts": {
			request: wrapperRecordingRequest{Mode: wrapperRecordingModeTab, Burst: &wrapperBurstRequest{TailMs: ptr(100)}}, wantErr: "burst needs capture bursts",
		},
		"lead out of range": {
			request: wrapperRecordingRequest{Mode: wrapperRecordingModeTab, Capture: wrapperRecordingCaptureBursts, Burst: &wrapperBurstRequest{LeadMs: ptr(10001)}}, wantErr: "leadMs",
		},
		"negative settle": {
			request: wrapperRecordingRequest{Mode: wrapperRecordingModeTab, Capture: wrapperRecordingCaptureBursts, Burst: &wrapperBurstRequest{SettleMs: ptr(-1)}}, wantErr: "settleMs",
		},
		"max tail below tail": {
			request: wrapperRecordingRequest{Mode: wrapperRecordingModeTab, Capture: wrapperRecordingCaptureBursts, Burst: &wrapperBurstRequest{TailMs: ptr(2000), MaxTailMs: ptr(1000)}}, wantErr: "maxTailMs",
		},
		"tail above the default max tail": {
			request: wrapperRecordingRequest{Mode: wrapperRecordingModeTab, Capture: wrapperRecordingCaptureBursts, Burst: &wrapperBurstRequest{TailMs: ptr(5000)}}, wantErr: "maxTailMs",
		},
		"zero timings": {
			request: wrapperRecordingRequest{Mode: wrapperRecordingModeTab, Capture: wrapperRecordingCaptureBursts, Burst: &wrapperBurstRequest{LeadMs: ptr(0), TailMs: ptr(0), SettleMs: ptr(0), MaxTailMs: ptr(0)}},
		},
		"invalid motion": {
			request: wrapperRecordingRequest{Mode: wrapperRecordingModeTab, Motion: &pointer.Motion{Kind: "warp"}}, wantErr: "motion",
		},
	} {
		t.Run(name, func(t *testing.T) {
			_, _, err := validateRecordingRequest(test.request)
			if test.wantErr == "" {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			if !errors.Is(err, errWrapperRecordingInvalid) || !strings.Contains(err.Error(), test.wantErr) {
				t.Fatalf("error %v, want one about %q", err, test.wantErr)
			}
		})
	}
	_, config, err := validateRecordingRequest(wrapperRecordingRequest{Mode: wrapperRecordingModeTab, Capture: wrapperRecordingCaptureBursts, Burst: &wrapperBurstRequest{TailMs: ptr(900)}})
	if err != nil || config.Tail != 900*time.Millisecond || config.Lead != burstDefaultLead || config.Settle != burstDefaultSettle || config.MaxTail != burstDefaultMaxTail {
		t.Fatalf("config %+v, %v", config, err)
	}
}

// newBurstsTestSession makes a session with one running bursts recording whose
// captures are scripted, saved below a temporary files root.
func newBurstsTestSession(t *testing.T) (*liveSession, *wrapperRecording, *fakeBurstBackend) {
	t.Helper()
	root := t.TempDir()
	segmentDir := filepath.Join(root, "recordings", ".recording-x")
	if err := os.MkdirAll(segmentDir, 0o700); err != nil {
		t.Fatal(err)
	}
	runtime := &wrapperRuntime{}
	session := &liveSession{runtime: runtime, recordings: map[string]*wrapperRecording{}}
	runtime.liveSession = session
	backend := newFakeBurstBackend()
	recording := &wrapperRecording{
		ID: "x", Mode: wrapperRecordingModeTab, Capture: wrapperRecordingCaptureBursts, TargetID: "t1", Status: wrapperRecordingRunning,
		Codec: "vp8", Path: filepath.Join(root, "recordings", "recording-x.webm"), filesRoot: root, segmentDir: segmentDir,
		StartedAt: time.Now(), operationMu: &sync.Mutex{},
	}
	recording.bursts = newRecordingBursts(context.Background(), defaultBurstConfig(), backend, func() { session.burstRecordings.Add(-1) })
	session.burstRecordings.Add(1)
	session.recordings["x"] = recording
	return session, recording, backend
}

func TestStoppingABurstsRecordingWithoutBurstsFailsIt(t *testing.T) {
	session, recording, _ := newBurstsTestSession(t)
	status, err := session.stopRecording("x", "requested")
	if !errors.Is(err, errWrapperRecordingNoBursts) || !errors.Is(err, errWrapperRecordingEmpty) {
		t.Fatalf("error %v", err)
	}
	if status.Status != wrapperRecordingFailed || status.StopReason != "no_bursts" || status.TimelinePath != "" {
		t.Fatalf("status %+v", status)
	}
	if _, statErr := os.Stat(recording.segmentDir); !os.IsNotExist(statErr) {
		t.Fatalf("the segment directory was kept: %v", statErr)
	}
	if session.burstRecordings.Load() != 0 {
		t.Fatal("the recording still counts as a bursts recording")
	}
}

func TestStoppingABurstsRecordingSaysWhyNothingWasRecorded(t *testing.T) {
	session, _, _ := newBurstsTestSession(t)
	if _, err := session.stopRecording("x", "requested"); err == nil || !strings.Contains(err.Error(), "no browser action ran") {
		t.Fatalf("error %v", err)
	}
	session, recording, backend := newBurstsTestSession(t)
	backend.notReady = true
	if _, err := recording.bursts.begin(context.Background(), burstAction{Tool: "browser_type", Kind: burstActionChange}); !errors.Is(err, errBurstUnavailable) {
		t.Fatal(err)
	}
	_, err := session.stopRecording("x", "requested")
	if !errors.Is(err, errWrapperRecordingNoBursts) || !strings.Contains(err.Error(), "1 actions or bursts were skipped") || !strings.Contains(err.Error(), "not ready") {
		t.Fatalf("error %v", err)
	}
}

func TestStoppingABurstsRecordingPublishesItsBursts(t *testing.T) {
	session, recording, _ := newBurstsTestSession(t)
	segment := filepath.Join(recording.segmentDir, "segment-0000.webm")
	if err := os.WriteFile(segment, []byte("video"), 0o600); err != nil {
		t.Fatal(err)
	}
	recording.segments = []string{segment}
	status, err := session.stopRecording("x", "requested")
	if err != nil || status.Status != wrapperRecordingStopped || status.StopReason != "requested" || status.SizeBytes != 5 {
		t.Fatalf("status %+v, %v", status, err)
	}
	if body, err := os.ReadFile(status.Path); err != nil || string(body) != "video" {
		t.Fatalf("published %q, %v", body, err)
	}
}

func TestClosingAPageDoesNotStopABurstsRecording(t *testing.T) {
	session, recording, backend := newBurstsTestSession(t)
	handle, err := recording.bursts.begin(context.Background(), burstAction{Tool: "browser_type", Kind: burstActionChange, TargetID: "t1"})
	if err != nil || handle == nil {
		t.Fatal(err)
	}
	session.stopTabRecordings("t1")
	// The burst closes in the background, so as not to hold up the registry.
	for deadline := time.Now().Add(2 * time.Second); backend.segment(0).closeReason() == "" && time.Now().Before(deadline); {
		time.Sleep(5 * time.Millisecond)
	}
	if backend.segmentCount() != 1 || backend.segment(0).closeReason() != "target_closed" {
		t.Fatalf("segments %d", backend.segmentCount())
	}
	if recording.Status != wrapperRecordingRunning {
		t.Fatalf("status %q", recording.Status)
	}
	recording.bursts.shutdown(false)
}

func TestRecordingMotionPrecedence(t *testing.T) {
	session, recording, _ := newBurstsTestSession(t)
	runtime := session.runtime
	runtime.pointer.setSessionMotion(pointer.Motion{Kind: pointer.KindFast})
	spec := pointerGestureSpec{}
	if got := runtime.resolvePointerMotion(spec, "t1"); got.Kind != pointer.KindFast {
		t.Fatalf("session setting: %+v", got)
	}
	recording.Motion = &pointer.Motion{Kind: pointer.KindSpeed, Speed: 300}
	if got := runtime.resolvePointerMotion(spec, "t1"); got.Kind != pointer.KindSpeed {
		t.Fatalf("recording setting: %+v", got)
	}
	// Only a recording of the page counts, and only while it runs.
	if got := runtime.resolvePointerMotion(spec, "t2"); got.Kind != pointer.KindFast {
		t.Fatalf("another page: %+v", got)
	}
	// The newest recording of the page wins.
	newer := &wrapperRecording{ID: "y", TargetID: "t1", Status: wrapperRecordingRunning, StartedAt: recording.StartedAt.Add(time.Second), Motion: &pointer.Motion{Kind: pointer.KindDuration, Duration: time.Second}}
	session.recordings["y"] = newer
	if got := runtime.resolvePointerMotion(spec, "t1"); got.Kind != pointer.KindDuration {
		t.Fatalf("newest recording: %+v", got)
	}
	newer.Status = wrapperRecordingStopped
	if got := runtime.resolvePointerMotion(spec, "t1"); got.Kind != pointer.KindSpeed {
		t.Fatalf("stopped recording still counts: %+v", got)
	}
	spec.Motion = &pointer.Motion{Kind: pointer.KindInstant}
	if got := runtime.resolvePointerMotion(spec, "t1"); got.Kind != pointer.KindInstant {
		t.Fatalf("tool parameter: %+v", got)
	}
}

func TestBurstActionsCostNothingWithoutABurstsRecording(t *testing.T) {
	// No live session, and one without bursts recordings: the call is left alone
	// without touching the browser.
	for _, runtime := range []*wrapperRuntime{{}, {liveSession: &liveSession{}}} {
		ctx := context.Background()
		gotCtx, ticket := runtime.beginBurstAction(ctx, "browser_click", nil, 0)
		if ticket != nil || gotCtx != ctx {
			t.Fatalf("ticket %v", ticket)
		}
		ticket.end(errors.New("nil tickets ignore this"))
		ticket.actionEnded(time.Now(), 1)
	}
	// Reading tools open no bursts even when there is a bursts recording.
	session, _, _ := newBurstsTestSession(t)
	if _, ticket := session.runtime.beginBurstAction(context.Background(), "browser_snapshot", nil, 0); ticket != nil {
		t.Fatalf("ticket %v", ticket)
	}
}

func TestBurstActionFindsItsPageWithinTheIdentifyDeadline(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		session, recording, backend := newBurstsTestSession(t)
		runtime := session.runtime
		runtime.burstIdentify = func(ctx context.Context) string {
			_ = sleepContext(ctx, time.Second)
			return "t2"
		}
		started := time.Now()
		_, ticket := runtime.beginBurstAction(context.Background(), "browser_type", map[string]any{}, 0)
		if ticket == nil || ticket.resolvedTarget() != "t2" || len(ticket.entries) != 1 {
			t.Fatalf("ticket %+v", ticket)
		}
		if waited := time.Since(started); waited != time.Second+backend.firstFrame {
			t.Fatalf("begin took %v", waited)
		}
		if backend.segment(0).target.TargetID != "t2" || recording.bursts.pending != 0 {
			t.Fatalf("recorded %s, %d pending", backend.segment(0).target.TargetID, recording.bursts.pending)
		}
		ticket.end(nil)
		recording.bursts.shutdown(false)
	})
}

func TestBurstActionWhoseIdentificationHangsFallsBackAfterTheDeadline(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		session, recording, backend := newBurstsTestSession(t)
		runtime := session.runtime
		// A Playwright call that queued, or a page that never answers: the probe
		// only ends with its context.
		runtime.burstIdentify = func(ctx context.Context) string {
			<-ctx.Done()
			return ""
		}
		started := time.Now()
		_, ticket := runtime.beginBurstAction(context.Background(), "browser_type", map[string]any{}, 0)
		if ticket == nil || ticket.resolvedTarget() != "" || len(ticket.entries) != 1 {
			t.Fatalf("ticket %+v", ticket)
		}
		if waited := time.Since(started); waited != burstIdentifyTimeout+backend.firstFrame {
			t.Fatalf("begin took %v, want the identify deadline plus the first frame", waited)
		}
		// The action is recorded on the page the recording falls back to.
		if backend.segmentCount() != 1 || backend.segment(0).target.TargetID != "t1" || recording.bursts.pending != 0 {
			t.Fatalf("%d segments, %d pending", backend.segmentCount(), recording.bursts.pending)
		}
		ticket.end(nil)
		recording.bursts.shutdown(false)
	})
}

func TestBurstActionCancelledWhileFindingItsPageFreesItsBursts(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		session, recording, backend := newBurstsTestSession(t)
		runtime := session.runtime
		runtime.burstIdentify = func(ctx context.Context) string {
			<-ctx.Done()
			return ""
		}
		// A burst is tailing off when the action arrives, and the request is
		// cancelled while it waits: the burst must not be held open by it.
		action := burstAction{Tool: "browser_type", Kind: burstActionChange, TargetID: "t1"}
		handle, err := recording.bursts.begin(context.Background(), action)
		if err != nil || handle == nil {
			t.Fatal(err)
		}
		recording.bursts.end(handle, time.Now(), nil)
		ctx, cancel := context.WithCancel(context.Background())
		time.AfterFunc(300*time.Millisecond, cancel)
		started := time.Now()
		_, ticket := runtime.beginBurstAction(ctx, "browser_type", map[string]any{}, 0)
		if waited := time.Since(started); waited != 300*time.Millisecond {
			t.Fatalf("the cancelled request waited %v", waited)
		}
		// The handler ends the ticket of the action that the cancelled request ran.
		ticket.end(context.Canceled)
		if recording.bursts.pending != 0 {
			t.Fatalf("%d actions still pending", recording.bursts.pending)
		}
		time.Sleep(3 * time.Second)
		if backend.segment(0).closeReason() != "settled" || recording.bursts.status().State != "idle" {
			t.Fatalf("closed %q, status %+v", backend.segment(0).closeReason(), recording.bursts.status())
		}
		recording.bursts.shutdown(false)
	})
}

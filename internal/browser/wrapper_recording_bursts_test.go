package browser

import (
	"context"
	"errors"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/aperture/aperture/internal/recording/timeline"
)

// fakeBurstSegment is a segment whose pipeline is a timer.
type fakeBurstSegment struct {
	backend   *fakeBurstBackend
	index     int
	target    wrapperTargetSnapshot
	opened    time.Time
	anchor    time.Time
	firstOnce sync.Once
	first     chan struct{}
	exitOnce  sync.Once
	exited    chan struct{}

	closedAt  time.Time
	reason    string
	discarded bool
}

func (s *fakeBurstSegment) FirstFrame() <-chan struct{} { return s.first }
func (s *fakeBurstSegment) Anchor() time.Time           { return s.anchor }
func (s *fakeBurstSegment) Exited() <-chan struct{}     { return s.exited }

func (s *fakeBurstSegment) closedTime() time.Time {
	s.backend.mu.Lock()
	defer s.backend.mu.Unlock()
	return s.closedAt
}

func (s *fakeBurstSegment) closeReason() string {
	s.backend.mu.Lock()
	defer s.backend.mu.Unlock()
	return s.reason
}

func (s *fakeBurstSegment) wasDiscarded() bool {
	s.backend.mu.Lock()
	defer s.backend.mu.Unlock()
	return s.discarded
}

func (s *fakeBurstSegment) exit() { s.exitOnce.Do(func() { close(s.exited) }) }

func (s *fakeBurstSegment) Close(reason string) error {
	time.Sleep(s.backend.closeDelay)
	s.backend.mu.Lock()
	defer s.backend.mu.Unlock()
	s.closedAt = time.Now()
	s.reason = reason
	s.exit()
	return s.backend.closeErr
}

func (s *fakeBurstSegment) Discard() {
	s.backend.mu.Lock()
	defer s.backend.mu.Unlock()
	s.discarded = true
	s.exit()
}

// fakeBurstBackend scripts the pipelines and the screen a controller sees.
type fakeBurstBackend struct {
	mu sync.Mutex
	// firstFrame is how long a pipeline takes to produce its first frame.
	firstFrame time.Duration
	closeDelay time.Duration
	openErr    error
	closeErr   error
	idleErr    error
	// changingUntil is when the screen stops changing; before it, the screen is
	// always changing. The zero value is a screen that never changed.
	changingUntil time.Time
	notReady      bool
	// readyAt is when a page becomes ready, for pages that are not from the start,
	// and gone the pages that are not ready any more.
	readyAt   map[string]time.Time
	gone      map[string]bool
	refreshed int
	// width is the width of every page's viewport.
	width int
	// firstFrames is how long the first pipelines take to produce a frame,
	// instead of firstFrame.
	firstFrames []time.Duration

	segments []*fakeBurstSegment
	actions  []timeline.ActionInput
	status   wrapperBurstStatus
	target_  string
	failedBy []string
}

func newFakeBurstBackend() *fakeBurstBackend {
	return &fakeBurstBackend{firstFrame: 100 * time.Millisecond}
}

func (f *fakeBurstBackend) target(id string) (wrapperTargetSnapshot, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if id == "" {
		id = "t1"
	}
	ready := !f.notReady && !f.gone[id]
	if at, delayed := f.readyAt[id]; delayed && time.Now().Before(at) {
		ready = false
	}
	return wrapperTargetSnapshot{TargetID: id, CaptureID: "capture-" + id, Generation: 1, Viewport: compositorViewport{Width: f.width}}, ready
}

func (f *fakeBurstBackend) setWidth(width int) {
	f.mu.Lock()
	f.width = width
	f.mu.Unlock()
}

func (f *fakeBurstBackend) refreshTargets(context.Context) {
	f.mu.Lock()
	f.refreshed++
	f.mu.Unlock()
}

func (f *fakeBurstBackend) open(ctx context.Context, target wrapperTargetSnapshot, _ uint64) (burstSegment, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.openErr != nil {
		return nil, f.openErr
	}
	firstFrame := f.firstFrame
	if len(f.segments) < len(f.firstFrames) {
		firstFrame = f.firstFrames[len(f.segments)]
	}
	segment := &fakeBurstSegment{
		backend: f, index: len(f.segments), target: target, opened: time.Now(),
		anchor: time.Now().Add(firstFrame), first: make(chan struct{}), exited: make(chan struct{}),
	}
	time.AfterFunc(firstFrame, func() { segment.firstOnce.Do(func() { close(segment.first) }) })
	f.segments = append(f.segments, segment)
	return segment, nil
}

func (f *fakeBurstBackend) idleFor(_ context.Context, _ string) (time.Duration, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.idleErr != nil {
		return 0, f.idleErr
	}
	if f.changingUntil.IsZero() {
		return time.Hour, nil
	}
	return max(0, time.Since(f.changingUntil)), nil
}

func (f *fakeBurstBackend) noteAction(action timeline.ActionInput) {
	f.mu.Lock()
	f.actions = append(f.actions, action)
	f.mu.Unlock()
}

func (f *fakeBurstBackend) publish(status wrapperBurstStatus, targetID string) {
	f.mu.Lock()
	f.status = status
	if targetID != "" {
		f.target_ = targetID
	}
	f.mu.Unlock()
}

func (f *fakeBurstBackend) changed() {}

func (f *fakeBurstBackend) failed(reason string, _ error) {
	f.mu.Lock()
	f.failedBy = append(f.failedBy, reason)
	f.mu.Unlock()
}

func (f *fakeBurstBackend) segment(index int) *fakeBurstSegment {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.segments[index]
}

func (f *fakeBurstBackend) segmentCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.segments)
}

// runAction begins an action, lets it take duration, ends it, and returns when
// its effect ended.
func runAction(t *testing.T, b *recordingBursts, action burstAction, duration time.Duration, actionErr error) (*burstHandle, time.Time) {
	t.Helper()
	handle, err := b.begin(context.Background(), action)
	if err != nil || handle == nil {
		t.Fatalf("begin %s: %v, %v", action.Tool, handle, err)
	}
	time.Sleep(duration)
	end := time.Now()
	handle.gestureEnd = end
	b.end(handle, end, actionErr)
	return handle, end
}

var (
	clickAction         = burstAction{Tool: "browser_click", Kind: burstActionPointer}
	typeAction          = burstAction{Tool: "browser_type", Kind: burstActionChange}
	errCompositorSilent = errors.New("the compositor is not answering")
)

func TestBurstSingleClickRecordsLeadActionAndTail(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		backend := newFakeBurstBackend()
		b := newRecordingBursts(context.Background(), defaultBurstConfig(), backend, nil)
		started := time.Now()
		handle, err := b.begin(context.Background(), clickAction)
		if err != nil || handle == nil {
			t.Fatalf("begin: %v %v", handle, err)
		}
		// The action waits for the first frame, then for the lead after it.
		if waited := time.Since(started); waited != backend.firstFrame+defaultBurstConfig().Lead {
			t.Fatalf("begin took %v, want first frame plus lead", waited)
		}
		time.Sleep(200 * time.Millisecond)
		gestureEnd := time.Now()
		handle.gestureEnd = gestureEnd
		b.end(handle, gestureEnd, nil)
		if state := b.status().State; state != "burst" {
			t.Fatalf("state after the action %q", state)
		}
		time.Sleep(2 * time.Second)
		segment := backend.segment(0)
		if segment.closeReason() != "settled" || segment.closedTime().Sub(gestureEnd) != defaultBurstConfig().Tail {
			t.Fatalf("closed %q after %v", segment.closeReason(), segment.closedTime().Sub(gestureEnd))
		}
		status := b.status()
		if status.State != "idle" || status.Count != 1 || status.Capped != 0 || status.Skipped != 0 {
			t.Fatalf("status %+v", status)
		}
		if len(backend.actions) != 1 || backend.actions[0].Tool != "browser_click" || backend.actions[0].Kind != "pointer" {
			t.Fatalf("actions %+v", backend.actions)
		}
		if lead := backend.actions[0].Start.Sub(segment.anchor); lead != defaultBurstConfig().Lead {
			t.Fatalf("the action started %v after the first frame", lead)
		}
		b.shutdown(false)
	})
}

func TestBurstStaysOpenWhileTheScreenChanges(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		backend := newFakeBurstBackend()
		b := newRecordingBursts(context.Background(), defaultBurstConfig(), backend, nil)
		_, end := runAction(t, b, typeAction, 100*time.Millisecond, nil)
		backend.mu.Lock()
		backend.changingUntil = end.Add(2 * time.Second)
		backend.mu.Unlock()
		time.Sleep(10 * time.Second)
		segment := backend.segment(0)
		// It closes once the screen has been still for the settle time, on a poll.
		settledAt := end.Add(2*time.Second + defaultBurstConfig().Settle)
		if delay := segment.closedTime().Sub(settledAt); segment.closeReason() != "settled" || delay < 0 || delay > recordingSampleInterval {
			t.Fatalf("closed %q at %v, settled at %v", segment.closeReason(), segment.closedTime().Sub(end), settledAt.Sub(end))
		}
		b.shutdown(false)
	})
}

func TestBurstThatNeverSettlesClosesAtMaxTail(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		backend := newFakeBurstBackend()
		backend.changingUntil = time.Now().Add(time.Hour)
		b := newRecordingBursts(context.Background(), defaultBurstConfig(), backend, nil)
		_, end := runAction(t, b, typeAction, 100*time.Millisecond, nil)
		time.Sleep(10 * time.Second)
		segment := backend.segment(0)
		if delay := segment.closedTime().Sub(end.Add(defaultBurstConfig().MaxTail)); segment.closeReason() != "max_tail" || delay < 0 || delay > recordingSampleInterval {
			t.Fatalf("closed %q %v after the action", segment.closeReason(), segment.closedTime().Sub(end))
		}
		if status := b.status(); status.Capped != 1 || status.Count != 1 {
			t.Fatalf("status %+v", status)
		}
		b.shutdown(false)
	})
}

func TestBurstHoldLongerThanTailKeepsItOpen(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		backend := newFakeBurstBackend()
		b := newRecordingBursts(context.Background(), defaultBurstConfig(), backend, nil)
		action := clickAction
		action.Hold = 2 * time.Second
		handle, err := b.begin(context.Background(), action)
		if err != nil {
			t.Fatal(err)
		}
		gestureEnd := time.Now()
		handle.gestureEnd = gestureEnd
		// The call blocks for the hold before it returns.
		time.Sleep(action.Hold + 150*time.Millisecond)
		b.end(handle, time.Now(), nil)
		time.Sleep(5 * time.Second)
		if closed := backend.segment(0).closedTime().Sub(gestureEnd); closed < action.Hold+150*time.Millisecond {
			t.Fatalf("closed %v after the gesture, before the hold ended", closed)
		}
		b.shutdown(false)
	})
}

func TestBurstHoldLongerThanMaxTailWins(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		backend := newFakeBurstBackend()
		backend.changingUntil = time.Now().Add(time.Hour)
		config := defaultBurstConfig()
		config.MaxTail = time.Second
		b := newRecordingBursts(context.Background(), config, backend, nil)
		action := typeAction
		action.Hold = 3 * time.Second
		handle, err := b.begin(context.Background(), action)
		if err != nil {
			t.Fatal(err)
		}
		gestureEnd := time.Now()
		handle.gestureEnd = gestureEnd
		time.Sleep(action.Hold)
		b.end(handle, time.Now(), nil)
		time.Sleep(10 * time.Second)
		segment := backend.segment(0)
		if closed := segment.closedTime().Sub(gestureEnd); segment.closeReason() != "max_tail" || closed < action.Hold || closed > action.Hold+recordingSampleInterval {
			t.Fatalf("closed %q %v after the gesture, hold %v", segment.closeReason(), closed, action.Hold)
		}
		b.shutdown(false)
	})
}

func TestBurstActionInTheTailExtendsTheBurst(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		backend := newFakeBurstBackend()
		b := newRecordingBursts(context.Background(), defaultBurstConfig(), backend, nil)
		runAction(t, b, typeAction, 50*time.Millisecond, nil)
		time.Sleep(300 * time.Millisecond)
		// Inside the tail a pointer action neither opens a segment nor waits for a lead.
		started := time.Now()
		_, end := runAction(t, b, clickAction, 50*time.Millisecond, nil)
		if time.Since(started) != 50*time.Millisecond {
			t.Fatalf("the second action waited %v", time.Since(started)-50*time.Millisecond)
		}
		time.Sleep(5 * time.Second)
		if backend.segmentCount() != 1 {
			t.Fatalf("%d segments", backend.segmentCount())
		}
		if closed := backend.segment(0).closedTime().Sub(end); closed != defaultBurstConfig().Tail {
			t.Fatalf("closed %v after the last action", closed)
		}
		if status := b.status(); status.Count != 1 {
			t.Fatalf("status %+v", status)
		}
		b.shutdown(false)
	})
}

func TestBurstActionWhileClosingWaitsAndOpensANewBurst(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		backend := newFakeBurstBackend()
		backend.closeDelay = 2 * time.Second
		b := newRecordingBursts(context.Background(), defaultBurstConfig(), backend, nil)
		_, end := runAction(t, b, typeAction, 50*time.Millisecond, nil)
		// Wait until the burst is closing.
		time.Sleep(defaultBurstConfig().Tail + time.Second)
		if b.status().State != "burst" || backend.segment(0).closedTime().After(end) {
			t.Fatal("the first burst should still be closing")
		}
		started := time.Now()
		handle, err := b.begin(context.Background(), clickAction)
		if err != nil || handle == nil {
			t.Fatalf("begin: %v %v", handle, err)
		}
		waited := time.Since(started)
		// It waited for the close (one more second), then opened a burst with a lead.
		if waited < time.Second+backend.firstFrame+defaultBurstConfig().Lead {
			t.Fatalf("waited only %v", waited)
		}
		if backend.segmentCount() != 2 {
			t.Fatalf("%d segments", backend.segmentCount())
		}
		if status := b.status(); status.Count != 2 {
			t.Fatalf("status %+v", status)
		}
		b.end(handle, time.Now(), nil)
		b.shutdown(false)
	})
}

func TestBurstFailedActionHasNoTail(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		backend := newFakeBurstBackend()
		b := newRecordingBursts(context.Background(), defaultBurstConfig(), backend, nil)
		_, end := runAction(t, b, clickAction, 50*time.Millisecond, errors.New("no such element"))
		time.Sleep(5 * time.Second)
		if closed := backend.segment(0).closedTime().Sub(end); closed > recordingSampleInterval {
			t.Fatalf("closed %v after the failed action", closed)
		}
		b.shutdown(false)
	})
}

func TestBurstThatCannotOpenLetsTheActionRun(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		backend := newFakeBurstBackend()
		backend.openErr = errors.New("pipeline did not start")
		b := newRecordingBursts(context.Background(), defaultBurstConfig(), backend, nil)
		handle, err := b.begin(context.Background(), typeAction)
		if handle != nil || !errors.Is(err, errBurstUnavailable) {
			t.Fatalf("begin: %v %v", handle, err)
		}
		status := b.status()
		if status.State != "idle" || status.Skipped != 1 || status.Count != 0 || status.LastError == "" {
			t.Fatalf("status %+v", status)
		}
		// The next action can open a burst once the pipeline works again.
		backend.mu.Lock()
		backend.openErr = nil
		backend.mu.Unlock()
		runAction(t, b, typeAction, 10*time.Millisecond, nil)
		if b.status().Count != 1 {
			t.Fatalf("status %+v", b.status())
		}
		b.shutdown(false)
	})
}

func TestBurstThatKeepsFailingToOpenFailsTheRecording(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		backend := newFakeBurstBackend()
		backend.openErr = errors.New("pipeline did not start")
		b := newRecordingBursts(context.Background(), defaultBurstConfig(), backend, nil)
		for range burstMaxFailures {
			_, _ = b.begin(context.Background(), typeAction)
		}
		if len(backend.failedBy) != 1 || backend.failedBy[0] != "pipeline_failed" {
			t.Fatalf("failed %v", backend.failedBy)
		}
		b.shutdown(false)
	})
}

func TestBurstNotReadyPageSkipsTheAction(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		backend := newFakeBurstBackend()
		backend.notReady = true
		b := newRecordingBursts(context.Background(), defaultBurstConfig(), backend, nil)
		if handle, err := b.begin(context.Background(), typeAction); handle != nil || !errors.Is(err, errBurstUnavailable) {
			t.Fatalf("begin: %v %v", handle, err)
		}
		if status := b.status(); status.Skipped != 1 {
			t.Fatalf("status %+v", status)
		}
		b.shutdown(false)
	})
}

func TestBurstCancelledDuringLeadIsDiscarded(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		backend := newFakeBurstBackend()
		b := newRecordingBursts(context.Background(), defaultBurstConfig(), backend, nil)
		ctx, cancel := context.WithCancel(context.Background())
		time.AfterFunc(backend.firstFrame+100*time.Millisecond, cancel)
		handle, err := b.begin(ctx, clickAction)
		if handle != nil || !errors.Is(err, context.Canceled) {
			t.Fatalf("begin: %v %v", handle, err)
		}
		if !backend.segment(0).wasDiscarded() {
			t.Fatal("the empty segment was kept")
		}
		if status := b.status(); status.State != "idle" || status.Skipped != 0 || status.Count != 0 {
			t.Fatalf("status %+v", status)
		}
		b.shutdown(false)
	})
}

func TestBurstNonPointerActionSkipsTheLeadButWaitsForTheFirstFrame(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		backend := newFakeBurstBackend()
		b := newRecordingBursts(context.Background(), defaultBurstConfig(), backend, nil)
		started := time.Now()
		handle, err := b.begin(context.Background(), typeAction)
		if err != nil || handle == nil {
			t.Fatal(err)
		}
		if waited := time.Since(started); waited != backend.firstFrame {
			t.Fatalf("waited %v", waited)
		}
		b.end(handle, time.Now(), nil)
		b.shutdown(false)
	})
}

func TestBurstWaitingOnlyHoldsAnOpenBurst(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		backend := newFakeBurstBackend()
		b := newRecordingBursts(context.Background(), defaultBurstConfig(), backend, nil)
		wait := burstAction{Tool: "browser_wait_for", Kind: burstActionObserve}
		if handle, err := b.begin(context.Background(), wait); handle != nil || err != nil || backend.segmentCount() != 0 {
			t.Fatalf("an idle wait opened a burst: %v %v", handle, err)
		}
		runAction(t, b, typeAction, 10*time.Millisecond, nil)
		// Waiting during the tail keeps the burst open for as long as it lasts.
		handle, _ := b.begin(context.Background(), wait)
		if handle == nil {
			t.Fatal("a wait during a burst was not part of it")
		}
		time.Sleep(5 * time.Second)
		if backend.segment(0).closeReason() != "" {
			t.Fatal("the burst closed under the wait")
		}
		b.end(handle, time.Now(), nil)
		time.Sleep(5 * time.Second)
		if backend.segmentCount() != 1 || backend.segment(0).closeReason() != "settled" {
			t.Fatalf("segments %d, reason %q", backend.segmentCount(), backend.segment(0).closeReason())
		}
		b.shutdown(false)
	})
}

func TestBurstStopInEachState(t *testing.T) {
	t.Run("idle", func(t *testing.T) {
		synctest.Test(t, func(t *testing.T) {
			stopped := 0
			b := newRecordingBursts(context.Background(), defaultBurstConfig(), newFakeBurstBackend(), func() { stopped++ })
			b.shutdown(true)
			b.shutdown(true)
			if stopped != 1 {
				t.Fatalf("stopped %d times", stopped)
			}
			if handle, err := b.begin(context.Background(), typeAction); handle != nil || err != nil {
				t.Fatalf("a stopped recording took an action: %v %v", handle, err)
			}
		})
	})
	t.Run("opening", func(t *testing.T) {
		synctest.Test(t, func(t *testing.T) {
			backend := newFakeBurstBackend()
			b := newRecordingBursts(context.Background(), defaultBurstConfig(), backend, nil)
			done := make(chan struct{})
			go func() {
				defer close(done)
				handle, err := b.begin(context.Background(), clickAction)
				if handle != nil || err != nil {
					t.Errorf("begin: %v %v", handle, err)
				}
			}()
			time.Sleep(backend.firstFrame / 2)
			b.shutdown(false)
			<-done
			if !backend.segment(0).wasDiscarded() || backend.segment(0).closeReason() != "" {
				t.Fatal("the opening segment was kept")
			}
		})
	})
	t.Run("active", func(t *testing.T) {
		synctest.Test(t, func(t *testing.T) {
			backend := newFakeBurstBackend()
			b := newRecordingBursts(context.Background(), defaultBurstConfig(), backend, nil)
			handle, _ := b.begin(context.Background(), typeAction)
			b.shutdown(true)
			if backend.segment(0).closeReason() != "stopped" {
				t.Fatalf("closed %q", backend.segment(0).closeReason())
			}
			// The action that was running has nothing left to tell.
			b.end(handle, time.Now(), nil)
		})
	})
	t.Run("tail, requested", func(t *testing.T) {
		synctest.Test(t, func(t *testing.T) {
			backend := newFakeBurstBackend()
			b := newRecordingBursts(context.Background(), defaultBurstConfig(), backend, nil)
			_, end := runAction(t, b, typeAction, 10*time.Millisecond, nil)
			b.shutdown(true)
			segment := backend.segment(0)
			// A requested stop lets the tail finish, so the result is in the video.
			if segment.closeReason() != "settled" || segment.closedTime().Sub(end) != defaultBurstConfig().Tail {
				t.Fatalf("closed %q %v after the action", segment.closeReason(), segment.closedTime().Sub(end))
			}
		})
	})
	t.Run("tail, immediate", func(t *testing.T) {
		synctest.Test(t, func(t *testing.T) {
			backend := newFakeBurstBackend()
			b := newRecordingBursts(context.Background(), defaultBurstConfig(), backend, nil)
			_, end := runAction(t, b, typeAction, 10*time.Millisecond, nil)
			b.shutdown(false)
			if segment := backend.segment(0); segment.closeReason() != "stopped" || segment.closedTime().Sub(end) != 0 {
				t.Fatalf("closed %q %v after the action", segment.closeReason(), segment.closedTime().Sub(end))
			}
		})
	})
}

func TestBurstFollowsTheAutomationToAnotherPage(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		backend := newFakeBurstBackend()
		b := newRecordingBursts(context.Background(), defaultBurstConfig(), backend, nil)
		first := typeAction
		first.TargetID = "t1"
		runAction(t, b, first, 10*time.Millisecond, nil)
		second := typeAction
		second.TargetID = "t2"
		handle, err := b.begin(context.Background(), second)
		if err != nil || handle == nil {
			t.Fatal(err)
		}
		if backend.segmentCount() != 2 || backend.segment(0).closeReason() != "target_changed" || backend.segment(1).target.TargetID != "t2" {
			t.Fatalf("segments %d, first closed %q", backend.segmentCount(), backend.segment(0).closeReason())
		}
		b.end(handle, time.Now(), nil)
		backend.mu.Lock()
		got := backend.target_
		backend.mu.Unlock()
		if got != "t2" {
			t.Fatalf("the recording reports page %q", got)
		}
		b.shutdown(false)
	})
}

func TestBurstEndsWhenItsPageCloses(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		backend := newFakeBurstBackend()
		b := newRecordingBursts(context.Background(), defaultBurstConfig(), backend, nil)
		action := typeAction
		action.TargetID = "t1"
		handle, _ := b.begin(context.Background(), action)
		b.targetClosed("other")
		if backend.segment(0).closeReason() != "" {
			t.Fatal("another page's closing ended the burst")
		}
		b.targetClosed("t1")
		synctest.Wait()
		if backend.segment(0).closeReason() != "target_closed" || b.status().State != "idle" {
			t.Fatalf("closed %q, status %+v", backend.segment(0).closeReason(), b.status())
		}
		b.end(handle, time.Now(), nil)
		// The recording goes on: the next action opens a new burst.
		runAction(t, b, action, 10*time.Millisecond, nil)
		if backend.segmentCount() != 2 {
			t.Fatalf("%d segments", backend.segmentCount())
		}
		b.shutdown(false)
	})
}

func TestBurstPipelineExitClosesTheBurstAndRepeatedFailuresFailTheRecording(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		backend := newFakeBurstBackend()
		b := newRecordingBursts(context.Background(), defaultBurstConfig(), backend, nil)
		for range burstMaxFailures {
			if _, err := b.begin(context.Background(), typeAction); err != nil {
				t.Fatal(err)
			}
			backend.segment(backend.segmentCount() - 1).exit()
			// The exit counts as a failure once the page is still there after a grace.
			time.Sleep(burstExitGrace + time.Second)
			if b.status().State != "idle" {
				t.Fatalf("status %+v", b.status())
			}
		}
		for index := range backend.segmentCount() {
			if reason := backend.segment(index).closeReason(); reason != "pipeline_failed" {
				t.Fatalf("segment %d closed %q", index, reason)
			}
		}
		if len(backend.failedBy) != 1 {
			t.Fatalf("failed %v", backend.failedBy)
		}
		b.shutdown(false)
	})
}

func TestBurstWithoutCompositorAnswersSettlesBlind(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		backend := newFakeBurstBackend()
		backend.idleErr = errCompositorSilent
		b := newRecordingBursts(context.Background(), defaultBurstConfig(), backend, nil)
		_, end := runAction(t, b, typeAction, 10*time.Millisecond, nil)
		time.Sleep(10 * time.Second)
		segment := backend.segment(0)
		// Without answers it assumes the screen settled a settle time after the action,
		// or at the end of the tail, whichever is later.
		if closed := segment.closedTime().Sub(end); segment.closeReason() != "settled" || closed < defaultBurstConfig().Tail || closed > defaultBurstConfig().Tail+recordingSampleInterval*burstBlindAfter+time.Second {
			t.Fatalf("closed %q %v after the action", segment.closeReason(), closed)
		}
		b.shutdown(false)
	})
}

func TestBurstCaptureReplacedDuringAnActionContinuesInANewSegment(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		backend := newFakeBurstBackend()
		b := newRecordingBursts(context.Background(), defaultBurstConfig(), backend, nil)
		action := typeAction
		action.TargetID = "t1"
		handle, err := b.begin(context.Background(), action)
		if err != nil {
			t.Fatal(err)
		}
		// The page was resized while the action ran.
		time.Sleep(50 * time.Millisecond)
		backend.setWidth(800)
		changed, _ := backend.target("t1")
		b.replaceTarget(changed)
		synctest.Wait()
		if backend.segmentCount() != 2 || backend.segment(0).closeReason() != "target_changed" {
			t.Fatalf("segments %d, first closed %q", backend.segmentCount(), backend.segment(0).closeReason())
		}
		if status := b.status(); status.Count != 1 || status.State != "burst" {
			t.Fatalf("status %+v", status)
		}
		// The action ends and the burst tails off on the new segment.
		b.end(handle, time.Now(), nil)
		time.Sleep(5 * time.Second)
		if backend.segment(1).closeReason() != "settled" {
			t.Fatalf("second segment closed %q", backend.segment(1).closeReason())
		}
		b.shutdown(false)
	})
}

func TestBurstWaitsForAPageThatIsNotReadyYet(t *testing.T) {
	t.Run("becomes ready", func(t *testing.T) {
		synctest.Test(t, func(t *testing.T) {
			backend := newFakeBurstBackend()
			backend.readyAt = map[string]time.Time{"t2": time.Now().Add(700 * time.Millisecond)}
			b := newRecordingBursts(context.Background(), defaultBurstConfig(), backend, nil)
			action := typeAction
			action.TargetID = "t2"
			started := time.Now()
			handle, err := b.begin(context.Background(), action)
			if err != nil || handle == nil {
				t.Fatalf("begin: %v %v", handle, err)
			}
			if waited := time.Since(started); waited < 700*time.Millisecond || waited > 700*time.Millisecond+burstTargetPoll+backend.firstFrame {
				t.Fatalf("begin took %v", waited)
			}
			if backend.segmentCount() != 1 || backend.segment(0).target.TargetID != "t2" || b.status().Skipped != 0 {
				t.Fatalf("segments %d, status %+v", backend.segmentCount(), b.status())
			}
			if backend.refreshed == 0 {
				t.Fatal("the registry was not asked to sync")
			}
			b.end(handle, time.Now(), nil)
			b.shutdown(false)
		})
	})
	t.Run("never", func(t *testing.T) {
		synctest.Test(t, func(t *testing.T) {
			backend := newFakeBurstBackend()
			backend.gone = map[string]bool{"t2": true}
			b := newRecordingBursts(context.Background(), defaultBurstConfig(), backend, nil)
			action := typeAction
			action.TargetID = "t2"
			started := time.Now()
			handle, err := b.begin(context.Background(), action)
			if handle != nil || !errors.Is(err, errBurstUnavailable) {
				t.Fatalf("begin: %v %v", handle, err)
			}
			if waited := time.Since(started); waited < burstTargetReadyTimeout || waited > burstTargetReadyTimeout+time.Second {
				t.Fatalf("begin waited %v", waited)
			}
			if b.status().Skipped != 1 {
				t.Fatalf("status %+v", b.status())
			}
			b.shutdown(false)
		})
	})
	t.Run("ends with the caller", func(t *testing.T) {
		synctest.Test(t, func(t *testing.T) {
			backend := newFakeBurstBackend()
			backend.gone = map[string]bool{"t2": true}
			b := newRecordingBursts(context.Background(), defaultBurstConfig(), backend, nil)
			ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
			defer cancel()
			action := typeAction
			action.TargetID = "t2"
			if handle, err := b.begin(ctx, action); handle != nil || !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("begin: %v %v", handle, err)
			}
			b.shutdown(false)
		})
	})
	t.Run("while another page is recorded", func(t *testing.T) {
		synctest.Test(t, func(t *testing.T) {
			backend := newFakeBurstBackend()
			b := newRecordingBursts(context.Background(), defaultBurstConfig(), backend, nil)
			first := typeAction
			first.TargetID = "t1"
			runAction(t, b, first, 10*time.Millisecond, nil)
			backend.mu.Lock()
			backend.readyAt = map[string]time.Time{"t2": time.Now().Add(400 * time.Millisecond)}
			backend.mu.Unlock()
			second := typeAction
			second.TargetID = "t2"
			handle, err := b.begin(context.Background(), second)
			if err != nil || handle == nil || backend.segmentCount() != 2 || backend.segment(1).target.TargetID != "t2" {
				t.Fatalf("begin: %v %v, %d segments", handle, err, backend.segmentCount())
			}
			b.end(handle, time.Now(), nil)
			b.shutdown(false)
		})
	})
}

func TestBurstFollowMovesInTheBackgroundAndActionsWaitForIt(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		backend := newFakeBurstBackend()
		backend.readyAt = map[string]time.Time{"t2": time.Now().Add(time.Second)}
		b := newRecordingBursts(context.Background(), defaultBurstConfig(), backend, nil)
		action := burstAction{Tool: "browser_tabs", Kind: burstActionChange, TargetID: "t1"}
		handle, err := b.begin(context.Background(), action)
		if err != nil || handle == nil {
			t.Fatal(err)
		}
		// The tool call returns at once: the move runs on, and holds the tail back.
		before := time.Now()
		b.startFollow(handle, func() string { time.Sleep(200 * time.Millisecond); return "t2" })
		b.end(handle, time.Now(), nil)
		if time.Since(before) != 0 {
			t.Fatal("the tool call waited for the move")
		}
		if state := b.status().State; state != "burst" || backend.segmentCount() != 1 {
			t.Fatalf("state %q, %d segments", state, backend.segmentCount())
		}
		// The next action waits for the move and joins the burst on the new page.
		next := typeAction
		next.TargetID = "t2"
		nextHandle, err := b.begin(context.Background(), next)
		if err != nil || nextHandle == nil {
			t.Fatalf("begin: %v %v", nextHandle, err)
		}
		if backend.segmentCount() != 2 || backend.segment(0).closeReason() != "target_changed" || backend.segment(1).target.TargetID != "t2" {
			t.Fatalf("%d segments, first closed %q", backend.segmentCount(), backend.segment(0).closeReason())
		}
		if status := b.status(); status.Count != 1 {
			t.Fatalf("status %+v", status)
		}
		b.end(nextHandle, time.Now(), nil)
		time.Sleep(5 * time.Second)
		if backend.segment(1).closeReason() != "settled" || b.status().State != "idle" {
			t.Fatalf("second segment closed %q", backend.segment(1).closeReason())
		}
		b.shutdown(false)
	})
}

func TestBurstFollowWithoutAnotherPageStartsTheTail(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		backend := newFakeBurstBackend()
		b := newRecordingBursts(context.Background(), defaultBurstConfig(), backend, nil)
		handle, err := b.begin(context.Background(), burstAction{Tool: "browser_tabs", Kind: burstActionChange, TargetID: "t1"})
		if err != nil || handle == nil {
			t.Fatal(err)
		}
		b.startFollow(handle, func() string { return "" })
		end := time.Now()
		b.end(handle, end, nil)
		time.Sleep(5 * time.Second)
		if segment := backend.segment(0); segment.closeReason() != "settled" || backend.segmentCount() != 1 {
			t.Fatalf("closed %q", segment.closeReason())
		}
		b.shutdown(false)
	})
}

func TestBurstOpeningThatMissesAResizeReopens(t *testing.T) {
	// A resize before the first frame drops the pipeline that started on the old
	// capture and starts another; one during the lead, when nothing follows the
	// page yet, closes the segment as target_changed and carries on in a new one.
	for name, test := range map[string]struct {
		action       burstAction
		resizeAfter  time.Duration
		wantDiscards int
		wantClosedBy string
	}{
		"before the first frame": {action: typeAction, resizeAfter: 50 * time.Millisecond, wantDiscards: 1},
		"during the lead":        {action: clickAction, resizeAfter: 500 * time.Millisecond, wantClosedBy: "target_changed"},
	} {
		t.Run(name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				backend := newFakeBurstBackend()
				backend.firstFrame = 350 * time.Millisecond
				b := newRecordingBursts(context.Background(), defaultBurstConfig(), backend, nil)
				action := test.action
				action.TargetID = "t1"
				done := make(chan *burstHandle)
				go func() {
					handle, err := b.begin(context.Background(), action)
					if err != nil {
						t.Error(err)
					}
					done <- handle
				}()
				time.Sleep(test.resizeAfter)
				backend.setWidth(800)
				changed, _ := backend.target("t1")
				b.replaceTarget(changed)
				synctest.Wait()
				handle := <-done
				synctest.Wait()
				if handle == nil || backend.segmentCount() != 2 || backend.segment(0).closeReason() != test.wantClosedBy || backend.segment(0).wasDiscarded() != (test.wantDiscards == 1) || backend.segment(1).target.Viewport.Width != 800 {
					t.Fatalf("handle %v, %d segments, first closed %q discarded %v", handle, backend.segmentCount(), backend.segment(0).closeReason(), backend.segment(0).wasDiscarded())
				}
				if status := b.status(); status.Count != 1 || status.State != "burst" {
					t.Fatalf("status %+v", status)
				}
				b.end(handle, time.Now(), nil)
				b.shutdown(false)
			})
		})
	}
}

func TestBurstPipelineThatNeverGetsAFrameIsStartedAgain(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		backend := newFakeBurstBackend()
		backend.firstFrames = []time.Duration{time.Hour, 100 * time.Millisecond}
		b := newRecordingBursts(context.Background(), defaultBurstConfig(), backend, nil)
		started := time.Now()
		handle, err := b.begin(context.Background(), typeAction)
		if err != nil || handle == nil {
			t.Fatalf("begin: %v %v", handle, err)
		}
		if waited := time.Since(started); waited != burstFirstFrameTimeout/burstOpenAttempts+100*time.Millisecond {
			t.Fatalf("begin took %v", waited)
		}
		if backend.segmentCount() != 2 || !backend.segment(0).wasDiscarded() || b.status().Skipped != 0 {
			t.Fatalf("%d segments, status %+v", backend.segmentCount(), b.status())
		}
		b.end(handle, time.Now(), nil)
		b.shutdown(false)
	})
}

func TestBurstPipelineExitFromAClosedPageIsNotAFailure(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		backend := newFakeBurstBackend()
		b := newRecordingBursts(context.Background(), defaultBurstConfig(), backend, nil)
		action := typeAction
		action.TargetID = "t1"
		for range 2 * burstMaxFailures {
			handle, err := b.begin(context.Background(), action)
			if err != nil || handle == nil {
				t.Fatalf("begin: %v %v", handle, err)
			}
			// The pipeline exits with its page, before the registry says so.
			backend.segment(backend.segmentCount() - 1).exit()
			synctest.Wait()
			backend.mu.Lock()
			backend.gone = map[string]bool{"t1": true}
			backend.mu.Unlock()
			time.Sleep(burstExitPoll * 2)
			if state := b.status().State; state != "idle" {
				t.Fatalf("state %q", state)
			}
			backend.mu.Lock()
			backend.gone = nil
			backend.mu.Unlock()
			b.end(handle, time.Now(), nil)
		}
		for index := range backend.segmentCount() {
			if reason := backend.segment(index).closeReason(); reason != "target_closed" {
				t.Fatalf("segment %d closed %q", index, reason)
			}
		}
		if len(backend.failedBy) != 0 {
			t.Fatalf("the recording failed: %v", backend.failedBy)
		}
		b.shutdown(false)
	})
}

func TestBurstOpenFailuresInARowAreCountedFromTheLastSuccess(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		backend := newFakeBurstBackend()
		b := newRecordingBursts(context.Background(), defaultBurstConfig(), backend, nil)
		fail := func(times int) {
			backend.mu.Lock()
			backend.openErr = errors.New("no pipeline")
			backend.mu.Unlock()
			for range times {
				if _, err := b.begin(context.Background(), typeAction); !errors.Is(err, errBurstUnavailable) {
					t.Fatal(err)
				}
			}
			backend.mu.Lock()
			backend.openErr = nil
			backend.mu.Unlock()
		}
		for range 2 {
			fail(burstMaxFailures - 1)
			runAction(t, b, typeAction, 10*time.Millisecond, nil)
			time.Sleep(2 * time.Second)
		}
		if len(backend.failedBy) != 0 {
			t.Fatalf("the recording failed: %v", backend.failedBy)
		}
		fail(burstMaxFailures)
		if len(backend.failedBy) != 1 {
			t.Fatalf("failed %v", backend.failedBy)
		}
		b.shutdown(false)
	})
}

func TestBurstGracefulStopWaitsForActionsThatAreRunning(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		backend := newFakeBurstBackend()
		b := newRecordingBursts(context.Background(), defaultBurstConfig(), backend, nil)
		handle, err := b.begin(context.Background(), clickAction)
		if err != nil || handle == nil {
			t.Fatal(err)
		}
		stopped := make(chan struct{})
		go func() {
			b.shutdown(true)
			close(stopped)
		}()
		// The click goes on for two seconds after the stop was asked for.
		time.Sleep(2 * time.Second)
		synctest.Wait()
		select {
		case <-stopped:
			t.Fatal("the stop did not wait for the action")
		default:
		}
		end := time.Now()
		handle.gestureEnd = end
		b.end(handle, end, nil)
		<-stopped
		segment := backend.segment(0)
		if segment.closeReason() != "settled" || segment.closedTime().Sub(end) != defaultBurstConfig().Tail {
			t.Fatalf("closed %q %v after the action", segment.closeReason(), segment.closedTime().Sub(end))
		}
		if len(backend.actions) != 1 {
			t.Fatalf("actions %v", backend.actions)
		}
	})
}

func TestBurstGracefulStopGivesUpOnActionsThatNeverEnd(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		backend := newFakeBurstBackend()
		b := newRecordingBursts(context.Background(), defaultBurstConfig(), backend, nil)
		if _, err := b.begin(context.Background(), typeAction); err != nil {
			t.Fatal(err)
		}
		started := time.Now()
		b.shutdown(true)
		if waited := time.Since(started); waited != burstStopActionWait || backend.segment(0).closeReason() != "stopped" {
			t.Fatalf("stop took %v, closed %q", waited, backend.segment(0).closeReason())
		}
	})
}

func TestBurstGracefulStopReturnsWhenTheControllerIsCancelled(t *testing.T) {
	for name, running := range map[string]bool{"tail": false, "action": true} {
		t.Run(name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				backend := newFakeBurstBackend()
				parent, cancel := context.WithCancel(context.Background())
				b := newRecordingBursts(parent, defaultBurstConfig(), backend, nil)
				handle, err := b.begin(context.Background(), typeAction)
				if err != nil {
					t.Fatal(err)
				}
				if !running {
					b.end(handle, time.Now(), nil)
				}
				// The runtime goes away: the tail loop ends without closing the burst.
				cancel()
				synctest.Wait()
				started := time.Now()
				b.shutdown(true)
				if time.Since(started) != 0 || backend.segment(0).closeReason() != "stopped" {
					t.Fatalf("stop took %v, closed %q", time.Since(started), backend.segment(0).closeReason())
				}
			})
		})
	}
}

func TestBurstActionWhileClosingWaitsForTheCloseOnly(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		backend := newFakeBurstBackend()
		backend.closeDelay = 300 * time.Millisecond
		b := newRecordingBursts(context.Background(), defaultBurstConfig(), backend, nil)
		_, end := runAction(t, b, typeAction, 10*time.Millisecond, nil)
		// The burst starts closing when its tail ends; an action arrives half way.
		time.Sleep(defaultBurstConfig().Tail + backend.closeDelay/2)
		if state := b.status().State; state != "burst" {
			t.Fatalf("state %q", state)
		}
		asked := time.Now()
		handle, err := b.begin(context.Background(), typeAction)
		if err != nil || handle == nil {
			t.Fatalf("begin: %v %v", handle, err)
		}
		waited := time.Since(asked)
		if want := backend.closeDelay/2 + backend.firstFrame; waited != want {
			t.Fatalf("begin took %v, want the rest of the close and a first frame (%v)", waited, want)
		}
		if backend.segmentCount() != 2 || backend.segment(0).closedTime().Sub(end) < defaultBurstConfig().Tail {
			t.Fatalf("%d segments", backend.segmentCount())
		}
		b.end(handle, time.Now(), nil)
		b.shutdown(false)
	})
}

func TestBurstLostVideoKeepsTheCountOfBurstsThatHaveSegments(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		backend := newFakeBurstBackend()
		b := newRecordingBursts(context.Background(), defaultBurstConfig(), backend, nil)
		action := typeAction
		action.TargetID = "t1"
		handle, err := b.begin(context.Background(), action)
		if err != nil {
			t.Fatal(err)
		}
		// The first segment is kept, the burst goes on in a second one that is lost.
		backend.setWidth(800)
		changed, _ := backend.target("t1")
		b.replaceTarget(changed)
		synctest.Wait()
		backend.mu.Lock()
		backend.closeErr = errors.New("no video")
		backend.mu.Unlock()
		b.end(handle, time.Now(), nil)
		time.Sleep(5 * time.Second)
		if status := b.status(); status.Count != 1 || status.Skipped != 0 || status.State != "idle" {
			t.Fatalf("status %+v", status)
		}
		// A burst none of whose segments is kept is not counted.
		runAction(t, b, action, 10*time.Millisecond, nil)
		time.Sleep(5 * time.Second)
		if status := b.status(); status.Count != 1 || status.Skipped != 1 {
			t.Fatalf("status %+v", status)
		}
		b.shutdown(false)
	})
}

func TestBurstPageClosedWhileOpeningIsSkippedQuietly(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		backend := newFakeBurstBackend()
		b := newRecordingBursts(context.Background(), defaultBurstConfig(), backend, nil)
		action := typeAction
		action.TargetID = "t1"
		done := make(chan error)
		go func() {
			_, err := b.begin(context.Background(), action)
			done <- err
		}()
		time.Sleep(backend.firstFrame / 2)
		b.targetClosed("t1")
		synctest.Wait()
		if err := <-done; !errors.Is(err, errBurstUnavailable) {
			t.Fatalf("begin: %v", err)
		}
		if status := b.status(); status.Skipped != 1 || status.LastError == "" || status.State != "idle" {
			t.Fatalf("status %+v", status)
		}
		b.shutdown(false)
	})
}

func TestBurstSegmentLimitSkipsActionsWithoutFailingTheRecording(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		backend := newFakeBurstBackend()
		b := newRecordingBursts(context.Background(), defaultBurstConfig(), backend, nil)
		b.mu.Lock()
		b.keptTotal = burstMaxSegments
		b.mu.Unlock()
		for range burstMaxFailures + 1 {
			if _, err := b.begin(context.Background(), typeAction); !errors.Is(err, errBurstUnavailable) {
				t.Fatal(err)
			}
		}
		if status := b.status(); status.Skipped != burstMaxFailures+1 || len(backend.failedBy) != 0 {
			t.Fatalf("status %+v, failed %v", status, backend.failedBy)
		}
		b.shutdown(false)
	})
}

func TestBurstWhileIdleReportsAStoppedController(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		b := newRecordingBursts(context.Background(), defaultBurstConfig(), newFakeBurstBackend(), nil)
		if err := b.whileIdle(func() {}); err != nil {
			t.Fatal(err)
		}
		b.shutdown(false)
		if err := b.whileIdle(func() { t.Fatal("ran on a stopped controller") }); !errors.Is(err, errBurstStopped) {
			t.Fatalf("error %v", err)
		}
	})
}

func TestBurstActionThatIsStillFindingItsPageHoldsTheTailOpen(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		backend := newFakeBurstBackend()
		b := newRecordingBursts(context.Background(), defaultBurstConfig(), backend, nil)
		action := clickAction
		action.TargetID = "t1"
		runAction(t, b, action, 10*time.Millisecond, nil)
		// The next action arrives while the tail runs, and finding its page takes
		// far longer than the tail and the settle time.
		time.Sleep(100 * time.Millisecond)
		release := b.arrive()
		time.Sleep(3 * time.Second)
		if backend.segment(0).closeReason() != "" || b.status().State != "burst" {
			t.Fatalf("the burst closed (%q) while the action was finding its page", backend.segment(0).closeReason())
		}
		handle, err := b.begin(context.Background(), action)
		release()
		if err != nil || handle == nil {
			t.Fatalf("begin: %v %v", handle, err)
		}
		if backend.segmentCount() != 1 {
			t.Fatalf("the action opened a second burst: %d segments", backend.segmentCount())
		}
		b.end(handle, time.Now(), nil)
		time.Sleep(3 * time.Second)
		if status := b.status(); status.Count != 1 || status.State != "idle" || backend.segment(0).closeReason() != "settled" {
			t.Fatalf("status %+v, closed %q", status, backend.segment(0).closeReason())
		}
		b.shutdown(false)
	})
}

func TestBurstArrivalThatNeverBeginsDoesNotHoldTheTailOnceReleased(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		backend := newFakeBurstBackend()
		b := newRecordingBursts(context.Background(), defaultBurstConfig(), backend, nil)
		runAction(t, b, typeAction, 10*time.Millisecond, nil)
		release := b.arrive()
		time.Sleep(2 * time.Second)
		release()
		release()
		time.Sleep(2 * time.Second)
		if backend.segment(0).closeReason() != "settled" {
			t.Fatalf("closed %q", backend.segment(0).closeReason())
		}
		b.shutdown(false)
	})
}

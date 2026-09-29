package browser

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/aperture/aperture/internal/recording/timeline"
)

// Bursts recordings capture video only around browser actions. Nothing is
// recorded while the page is idle: an action opens a burst (a segment of its own,
// captured by a pipeline that runs just for the burst), the burst stays open
// while actions keep coming and the screen keeps changing, and it closes once the
// screen has settled. Stopping the recording joins the bursts into one video, and
// the recording's timeline says where each one is.
//
// recordingBursts is the state machine behind one such recording. The two
// automation handlers drive it through burstTickets: begin runs before an action
// and end after it. The call returns when the action is done; the tail of the
// burst, its lead-out, runs on in the background.
//
//	idle --begin--> opening --first frame and lead--> active --last action ends--> tail
//	tail --begin--> active                            tail --settled or capped--> closing --> idle
//	active/tail --stop, target closed, pipeline exit--> closing --> idle
//
// A begin that finds the burst closing waits for it and opens a new one, so an
// action never runs against a segment that is being closed.

const (
	burstDefaultLead    = 400 * time.Millisecond
	burstDefaultTail    = 600 * time.Millisecond
	burstDefaultSettle  = 500 * time.Millisecond
	burstDefaultMaxTail = 4 * time.Second

	burstMaxLeadMs    = 10000
	burstMaxTailMs    = 30000
	burstMaxSettleMs  = 30000
	burstMaxMaxTailMs = 60000

	// burstFirstFrameTimeout is how long a burst waits for its pipeline's first
	// frame, as long as a replacement segment waits for data.
	burstFirstFrameTimeout = 5 * time.Second
	// burstIdleProbeTimeout bounds one ask of the compositor while a tail settles.
	burstIdleProbeTimeout = 500 * time.Millisecond
	// burstBlindAfter is how many failed asks in a row make a tail assume that the
	// screen settled at the time it would have, instead of waiting for an answer.
	burstBlindAfter = 3
	// burstMaxFailures is how many capture pipelines in a row may fail before the
	// recording fails.
	burstMaxFailures = 3
	// burstMaxSegments bounds the segments of one recording, which is also the
	// number of files its stop joins.
	burstMaxSegments = 1000
)

var (
	// errBurstUnavailable means a burst could not be opened. The action runs
	// anyway: a recording never fails the automation.
	errBurstUnavailable = errors.New("burst recording is unavailable")
	errBurstInProgress  = errors.New("a burst is in progress")
	// errBurstStopped means the recording is stopping and takes no more actions.
	errBurstStopped = errors.New("the recording is stopping")
)

// burstConfig is a bursts recording's timing.
type burstConfig struct {
	// Lead is the video recorded before a pointer action starts.
	Lead time.Duration
	// Tail is the least video recorded after an action ends.
	Tail time.Duration
	// Settle is how long the screen must stay unchanged, after the tail, for the
	// burst to close.
	Settle time.Duration
	// MaxTail is the most video recorded after an action ends, however long the
	// screen keeps changing.
	MaxTail time.Duration
}

func defaultBurstConfig() burstConfig {
	return burstConfig{Lead: burstDefaultLead, Tail: burstDefaultTail, Settle: burstDefaultSettle, MaxTail: burstDefaultMaxTail}
}

// wrapperBurstRequest is the burst timing a recording is started with; omitted
// fields take their defaults.
type wrapperBurstRequest struct {
	LeadMs    *int `json:"leadMs"`
	TailMs    *int `json:"tailMs"`
	SettleMs  *int `json:"settleMs"`
	MaxTailMs *int `json:"maxTailMs"`
}

// newBurstConfig applies the defaults to a request and checks its ranges.
func newBurstConfig(request *wrapperBurstRequest) (burstConfig, error) {
	config := defaultBurstConfig()
	if request == nil {
		return config, nil
	}
	set := func(name string, value *int, maximum int, destination *time.Duration) error {
		if value == nil {
			return nil
		}
		if *value < 0 || *value > maximum {
			return fmt.Errorf("burst %s must be between 0 and %d", name, maximum)
		}
		*destination = time.Duration(*value) * time.Millisecond
		return nil
	}
	for _, field := range []struct {
		name    string
		value   *int
		maximum int
		into    *time.Duration
	}{
		{"leadMs", request.LeadMs, burstMaxLeadMs, &config.Lead},
		{"tailMs", request.TailMs, burstMaxTailMs, &config.Tail},
		{"settleMs", request.SettleMs, burstMaxSettleMs, &config.Settle},
		{"maxTailMs", request.MaxTailMs, burstMaxMaxTailMs, &config.MaxTail},
	} {
		if err := set(field.name, field.value, field.maximum, field.into); err != nil {
			return burstConfig{}, err
		}
	}
	if config.MaxTail < config.Tail {
		return burstConfig{}, errors.New("burst maxTailMs must not be less than tailMs")
	}
	return config, nil
}

// wrapperBurstStatus is what a bursts recording reports about itself.
type wrapperBurstStatus struct {
	LeadMs    int `json:"leadMs"`
	TailMs    int `json:"tailMs"`
	SettleMs  int `json:"settleMs"`
	MaxTailMs int `json:"maxTailMs"`
	// State is "idle" between bursts and "burst" while one is opening, running,
	// tailing off or closing.
	State string `json:"state"`
	// Count is the bursts recorded so far, including a running one.
	Count int `json:"count"`
	// Capped is the bursts that were cut off by maxTailMs while the screen was
	// still changing.
	Capped int `json:"capped"`
	// Skipped is the actions that ran without being recorded because no burst
	// could be opened for them.
	Skipped   int    `json:"skipped"`
	LastError string `json:"lastError,omitempty"`
}

// burstAction is one browser action that asks to be recorded.
type burstAction struct {
	Tool string
	Kind burstActionKind
	// Hold is the extra wait a pointer tool blocks for after its gesture.
	Hold time.Duration
	// TargetID is the page the action runs on, or empty when it is not known.
	TargetID string
}

// burstHandle is one action taking part in a burst.
type burstHandle struct {
	action burstAction
	// started is when the action began running, after the burst's lead.
	started time.Time
	// gestureEnd and gesture are set by the action when it knows them: the time
	// its physical effect ended and the pointer gesture it made.
	gestureEnd time.Time
	gesture    uint64
}

// burstSegment is the capture of one burst: a pipeline recording one page to one
// file.
type burstSegment interface {
	// FirstFrame is closed once the pipeline has produced a frame, and Anchor is
	// then the wall time of that frame.
	FirstFrame() <-chan struct{}
	Anchor() time.Time
	// Exited is closed when the pipeline ends, whether asked to or not.
	Exited() <-chan struct{}
	// Close stops the pipeline, ends the segment's timeline and keeps its video.
	// An error means the video is unusable.
	Close(reason string) error
	// Discard stops the pipeline and throws the segment away. It is only valid
	// for the newest segment, and after Close failed or instead of it.
	Discard()
}

// burstBackend is what a bursts recording's controller needs from the wrapper,
// separated so the state machine can be exercised without pipelines.
type burstBackend interface {
	// target returns the ready page with the ID; the recording's own page when the
	// ID is empty.
	target(id string) (wrapperTargetSnapshot, bool)
	// open starts a segment for a burst.
	open(ctx context.Context, target wrapperTargetSnapshot, burst uint64) (burstSegment, error)
	// idleFor is how long the page's screen has been unchanged.
	idleFor(ctx context.Context, targetID string) (time.Duration, error)
	// noteAction records an action in the timeline.
	noteAction(action timeline.ActionInput)
	// publish makes the recording report its status and the page it records now.
	// It is called with the controller's lock held and must only take short locks.
	publish(status wrapperBurstStatus, targetID string)
	// changed tells clients that the recording's status changed. It is called
	// without any lock held.
	changed()
	// failed fails the whole recording, after too many capture failures. It is
	// called without any lock held and may not wait for the controller.
	failed(reason string, cause error)
}

type burstState int

const (
	burstIdle burstState = iota
	burstOpening
	burstActive
	burstTail
	burstClosing
	burstStopped
)

// tailPlan says when the burst may close: not before minEnd, and not after
// hardEnd however the screen behaves.
type tailPlan struct {
	valid      bool
	gestureEnd time.Time
	minEnd     time.Time
	hardEnd    time.Time
}

func (p tailPlan) merge(other tailPlan) tailPlan {
	if !p.valid {
		return other
	}
	p.gestureEnd = laterOf(p.gestureEnd, other.gestureEnd)
	p.minEnd = laterOf(p.minEnd, other.minEnd)
	p.hardEnd = laterOf(p.hardEnd, other.hardEnd)
	return p
}

func laterOf(a, b time.Time) time.Time {
	if b.After(a) {
		return b
	}
	return a
}

// recordingBursts is the controller of one bursts recording.
type recordingBursts struct {
	cfg     burstConfig
	backend burstBackend
	// root ends when the controller stops; background work belongs to it.
	root       context.Context
	cancelRoot context.CancelFunc
	// onStopped runs once when the controller stops.
	onStopped func()

	mu        sync.Mutex
	state     burstState
	stopping  bool
	seg       burstSegment
	segTarget wrapperTargetSnapshot
	burstNo   uint64
	handles   map[*burstHandle]struct{}
	plan      tailPlan
	// curPlan is the plan of the tail that is running.
	curPlan    tailPlan
	cancelOpen context.CancelFunc
	tailCancel context.CancelFunc
	tailID     uint64
	// changed is closed and replaced at every state change, so a waiter can wait
	// for the next one.
	changed     chan struct{}
	count       int
	capped      int
	skipped     int
	failedInRow int
	lastError   string
}

func newRecordingBursts(parent context.Context, cfg burstConfig, backend burstBackend, onStopped func()) *recordingBursts {
	root, cancel := context.WithCancel(parent)
	return &recordingBursts{
		cfg:        cfg,
		backend:    backend,
		root:       root,
		cancelRoot: cancel,
		onStopped:  onStopped,
		handles:    make(map[*burstHandle]struct{}),
		changed:    make(chan struct{}),
	}
}

func (b *recordingBursts) statusLocked() wrapperBurstStatus {
	state := "burst"
	if b.state == burstIdle || b.state == burstStopped {
		state = "idle"
	}
	return wrapperBurstStatus{
		LeadMs:    int(b.cfg.Lead / time.Millisecond),
		TailMs:    int(b.cfg.Tail / time.Millisecond),
		SettleMs:  int(b.cfg.Settle / time.Millisecond),
		MaxTailMs: int(b.cfg.MaxTail / time.Millisecond),
		State:     state,
		Count:     b.count,
		Capped:    b.capped,
		Skipped:   b.skipped,
		LastError: b.lastError,
	}
}

// status is the recording's burst status as it is now.
func (b *recordingBursts) status() wrapperBurstStatus {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.statusLocked()
}

// publishLocked reports the status after a change, and wakes the waiters.
func (b *recordingBursts) publishLocked() {
	targetID := ""
	switch b.state {
	case burstOpening, burstActive, burstTail, burstClosing:
		targetID = b.segTarget.TargetID
	}
	close(b.changed)
	b.changed = make(chan struct{})
	b.backend.publish(b.statusLocked(), targetID)
}

// waitLocked waits for the next state change, with the lock released while it
// waits, and reports whether the wait ended because ctx did.
func (b *recordingBursts) waitLocked(ctx context.Context) error {
	changed := b.changed
	b.mu.Unlock()
	defer b.mu.Lock()
	select {
	case <-changed:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// begin runs before an action. It returns a handle to pass to end, or nil when
// the action is not part of a burst: the recording is stopping, the action only
// waits and no burst is open, or a burst could not be opened (errBurstUnavailable,
// in which case the action should run anyway).
//
// For an action that opens a burst, begin returns once the burst's first frame
// exists and, for a pointer action, its lead has been recorded.
func (b *recordingBursts) begin(ctx context.Context, action burstAction) (*burstHandle, error) {
	b.mu.Lock()
	for {
		if b.stopping || b.state == burstStopped {
			b.mu.Unlock()
			return nil, nil
		}
		switch b.state {
		case burstIdle:
			if action.Kind == burstActionObserve {
				b.mu.Unlock()
				return nil, nil
			}
			target, ready := b.backend.target(action.TargetID)
			if !ready {
				b.skipLocked("the page to record is not ready")
				b.mu.Unlock()
				b.backend.changed()
				return nil, errBurstUnavailable
			}
			handle := b.registerLocked(action)
			openCtx := b.startOpeningLocked(ctx, target, true)
			lead := time.Duration(0)
			if action.Kind == burstActionPointer {
				lead = b.cfg.Lead
			}
			burst := b.burstNo
			b.mu.Unlock()
			b.backend.changed()
			if err := b.runOpening(openCtx, target, burst, lead, true); err != nil {
				switch {
				case errors.Is(err, errBurstStopped):
					return nil, nil
				case ctx.Err() != nil:
					return nil, ctx.Err()
				default:
					return nil, err
				}
			}
			handle.started = time.Now()
			return handle, nil
		case burstOpening, burstClosing:
			if action.Kind == burstActionObserve {
				b.mu.Unlock()
				return nil, nil
			}
			if err := b.waitLocked(ctx); err != nil {
				b.mu.Unlock()
				return nil, err
			}
		case burstActive, burstTail:
			if action.Kind != burstActionObserve && action.TargetID != "" && action.TargetID != b.segTarget.TargetID {
				// The automation moved to another page: record it in a burst of its own.
				seg := b.startClosingLocked(false)
				b.mu.Unlock()
				b.backend.changed()
				b.finishClose(seg, "target_changed", nil)
				b.mu.Lock()
				continue
			}
			handle := b.registerLocked(action)
			handle.started = time.Now()
			if b.state == burstTail {
				b.tailCancel()
				b.tailCancel = nil
				b.state = burstActive
				b.publishLocked()
			}
			b.mu.Unlock()
			return handle, nil
		}
	}
}

func (b *recordingBursts) registerLocked(action burstAction) *burstHandle {
	handle := &burstHandle{action: action}
	b.handles[handle] = struct{}{}
	return handle
}

func (b *recordingBursts) skipLocked(reason string) {
	b.skipped++
	b.lastError = reason
	b.publishLocked()
}

// startOpeningLocked moves to opening. It returns the context the opening runs
// under, which ends when the caller's does or the controller is told to stop.
func (b *recordingBursts) startOpeningLocked(parent context.Context, target wrapperTargetSnapshot, newBurst bool) context.Context {
	ctx, cancel := context.WithCancel(parent)
	b.cancelOpen = cancel
	b.state = burstOpening
	b.segTarget = target
	if newBurst {
		b.burstNo++
	}
	b.publishLocked()
	return ctx
}

// runOpening starts the segment of a burst and waits for its first frame and
// lead. It runs without the lock held, in the state startOpeningLocked set, and
// leaves the controller active, or idle when it fails.
func (b *recordingBursts) runOpening(ctx context.Context, target wrapperTargetSnapshot, burst uint64, lead time.Duration, newBurst bool) error {
	seg, err := b.backend.open(ctx, target, burst)
	if err == nil {
		err = awaitFirstFrame(ctx, seg)
	}
	if err == nil && lead > 0 {
		err = sleepUntil(ctx, seg.Anchor().Add(lead))
	}
	b.mu.Lock()
	if err == nil && b.stopping {
		err = errBurstStopped
	}
	if err != nil {
		// Cancelled openings are not failures: the caller went away, or the
		// recording is stopping.
		stopping := b.stopping
		cancelled := ctx.Err() != nil || errors.Is(err, errBurstStopped)
		b.cancelOpen()
		b.cancelOpen = nil
		b.mu.Unlock()
		if seg != nil {
			seg.Discard()
		}
		b.mu.Lock()
		clear(b.handles)
		b.plan = tailPlan{}
		b.state = burstIdle
		failed := false
		if !cancelled {
			b.failedInRow++
			b.skipped++
			b.lastError = err.Error()
			failed = b.failedInRow >= burstMaxFailures
		}
		b.publishLocked()
		b.mu.Unlock()
		b.backend.changed()
		if failed {
			b.backend.failed("pipeline_failed", err)
		}
		switch {
		case stopping:
			return errBurstStopped
		case cancelled:
			return context.Canceled
		default:
			return errBurstUnavailable
		}
	}
	b.cancelOpen()
	b.cancelOpen = nil
	b.seg = seg
	b.state = burstActive
	if newBurst {
		b.count++
	}
	go b.watch(seg)
	if len(b.handles) == 0 && b.plan.valid {
		// The burst was reopened on a new capture after its actions ended: it goes
		// on tailing off, for at least a tail of the new segment.
		b.plan.minEnd = laterOf(b.plan.minEnd, time.Now().Add(b.cfg.Tail))
		b.plan.hardEnd = laterOf(b.plan.hardEnd, b.plan.minEnd)
		b.enterTailLocked()
	}
	b.publishLocked()
	b.mu.Unlock()
	b.backend.changed()
	return nil
}

func awaitFirstFrame(ctx context.Context, seg burstSegment) error {
	timer := time.NewTimer(burstFirstFrameTimeout)
	defer timer.Stop()
	select {
	case <-seg.FirstFrame():
		return nil
	case <-seg.Exited():
		return errors.New("the capture pipeline exited before its first frame")
	case <-timer.C:
		return errors.New("the capture pipeline produced no frame")
	case <-ctx.Done():
		return ctx.Err()
	}
}

// sleepUntil waits for a wall time, or for ctx to end.
func sleepUntil(ctx context.Context, at time.Time) error {
	wait := time.Until(at)
	if wait <= 0 {
		return ctx.Err()
	}
	return sleepContext(ctx, wait)
}

// end runs after an action. gestureEnd and callEnd are wall times: when the
// action's physical effect ended, and when its call returned. err is the
// action's failure, if it failed. It never waits.
func (b *recordingBursts) end(handle *burstHandle, callEnd time.Time, err error) {
	if handle == nil {
		return
	}
	gestureEnd := handle.gestureEnd
	if gestureEnd.IsZero() || gestureEnd.After(callEnd) {
		gestureEnd = callEnd
	}
	start := handle.started
	if start.IsZero() || start.After(gestureEnd) {
		start = gestureEnd
	}
	b.backend.noteAction(timeline.ActionInput{
		Tool:     handle.action.Tool,
		Kind:     handle.action.Kind.String(),
		TargetID: b.actionTarget(handle),
		Start:    start,
		End:      callEnd,
		Gesture:  handle.gesture,
	})

	b.mu.Lock()
	defer b.mu.Unlock()
	if _, taking := b.handles[handle]; !taking {
		// The burst ended under the action: the recording stopped, or its page closed.
		return
	}
	delete(b.handles, handle)
	minTail := time.Duration(0)
	if err == nil {
		minTail = max(b.cfg.Tail, handle.action.Hold)
	}
	minEnd := laterOf(gestureEnd.Add(minTail), callEnd)
	hardEnd := laterOf(minEnd, gestureEnd.Add(max(b.cfg.MaxTail, b.cfg.Tail, handle.action.Hold)))
	b.plan = b.plan.merge(tailPlan{valid: true, gestureEnd: gestureEnd, minEnd: minEnd, hardEnd: hardEnd})
	if len(b.handles) == 0 && b.state == burstActive {
		b.enterTailLocked()
		b.publishLocked()
	}
}

func (b *recordingBursts) actionTarget(handle *burstHandle) string {
	if handle.action.TargetID != "" {
		return handle.action.TargetID
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.segTarget.TargetID
}

// enterTailLocked starts the tail that plan describes.
func (b *recordingBursts) enterTailLocked() {
	plan := b.plan
	b.plan = tailPlan{}
	b.curPlan = plan
	b.state = burstTail
	b.tailID++
	ctx, cancel := context.WithCancel(b.root)
	b.tailCancel = cancel
	go b.tailLoop(ctx, b.tailID, plan, b.segTarget.TargetID)
}

// tailLoop waits out the burst's tail: at least until plan.minEnd, then until
// the screen has been unchanged for Settle, and at most until plan.hardEnd.
func (b *recordingBursts) tailLoop(ctx context.Context, id uint64, plan tailPlan, targetID string) {
	if sleepUntil(ctx, plan.minEnd) != nil {
		return
	}
	ticker := time.NewTicker(recordingSampleInterval)
	defer ticker.Stop()
	failures := 0
	for {
		probeCtx, cancel := context.WithTimeout(ctx, burstIdleProbeTimeout)
		idle, err := b.backend.idleFor(probeCtx, targetID)
		cancel()
		if ctx.Err() != nil {
			return
		}
		reason := ""
		switch {
		case err != nil:
			failures++
			if failures >= burstBlindAfter {
				// The compositor does not answer: assume the screen settled when
				// it would have, without changes to tell us otherwise.
				blindAt := laterOf(plan.minEnd, plan.gestureEnd.Add(b.cfg.Settle))
				if blindAt.After(plan.hardEnd) {
					blindAt = plan.hardEnd
				}
				if sleepUntil(ctx, blindAt) != nil {
					return
				}
				reason = "settled"
			}
		case idle >= b.cfg.Settle:
			reason = "settled"
		default:
			failures = 0
		}
		if reason == "" && !time.Now().Before(plan.hardEnd) {
			reason = "max_tail"
		}
		if reason != "" {
			b.closeFromTail(id, reason)
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (b *recordingBursts) closeFromTail(id uint64, reason string) {
	b.mu.Lock()
	if b.state != burstTail || b.tailID != id {
		b.mu.Unlock()
		return
	}
	seg := b.startClosingLocked(false)
	if reason == "max_tail" {
		b.capped++
	}
	b.mu.Unlock()
	b.backend.changed()
	b.finishClose(seg, reason, nil)
}

// startClosingLocked moves an active or tailing burst to closing and returns its
// segment, which the caller must pass to finishClose. The actions still running
// are forgotten unless keepHandles, which a replacement of the recorded page's
// capture uses to carry the burst on.
func (b *recordingBursts) startClosingLocked(keepHandles bool) burstSegment {
	if b.tailCancel != nil {
		b.tailCancel()
		b.tailCancel = nil
	}
	seg := b.seg
	b.seg = nil
	wasTail := b.state == burstTail
	b.state = burstClosing
	if keepHandles {
		if wasTail {
			b.plan = b.curPlan
		}
	} else {
		clear(b.handles)
		b.plan = tailPlan{}
	}
	b.publishLocked()
	return seg
}

// finishClose ends a segment that startClosingLocked took, without the lock. It
// leaves the controller idle, or, when reopen is set, opening that page for the
// actions that were still running.
func (b *recordingBursts) finishClose(seg burstSegment, reason string, reopen *wrapperTargetSnapshot) {
	err := seg.Close(reason)
	if err != nil {
		seg.Discard()
	}
	b.mu.Lock()
	if err != nil {
		b.lastError = fmt.Sprintf("closing a burst: %v", err)
		if reopen == nil {
			b.count = max(0, b.count-1)
		}
	} else if reason != "pipeline_failed" {
		b.failedInRow = 0
	}
	if reopen != nil && !b.stopping && (len(b.handles) > 0 || b.plan.valid) {
		target := *reopen
		openCtx := b.startOpeningLocked(b.root, target, false)
		burst := b.burstNo
		b.mu.Unlock()
		b.backend.changed()
		_ = b.runOpening(openCtx, target, burst, 0, false)
		return
	}
	clear(b.handles)
	b.plan = tailPlan{}
	b.state = burstIdle
	b.publishLocked()
	b.mu.Unlock()
	b.backend.changed()
}

// watch reacts to a segment's pipeline exiting on its own.
func (b *recordingBursts) watch(seg burstSegment) {
	<-seg.Exited()
	b.mu.Lock()
	if b.seg != seg || (b.state != burstActive && b.state != burstTail) {
		b.mu.Unlock()
		return
	}
	b.failedInRow++
	b.lastError = "the capture pipeline exited during a burst"
	failed := b.failedInRow >= burstMaxFailures
	seg = b.startClosingLocked(false)
	b.mu.Unlock()
	b.backend.changed()
	b.finishClose(seg, "pipeline_failed", nil)
	if failed {
		b.backend.failed("pipeline_failed", errors.New("the capture pipeline failed repeatedly"))
	}
}

// targetClosed ends the burst recording that page, if it is the one being
// recorded. It does not stop the recording: the next action opens a burst on
// whatever page it runs on.
func (b *recordingBursts) targetClosed(targetID string) {
	b.mu.Lock()
	if b.segTarget.TargetID != targetID {
		b.mu.Unlock()
		return
	}
	switch b.state {
	case burstOpening:
		if b.cancelOpen != nil {
			b.cancelOpen()
		}
		b.mu.Unlock()
	case burstActive, burstTail:
		seg := b.startClosingLocked(false)
		b.mu.Unlock()
		b.backend.changed()
		b.finishClose(seg, "target_closed", nil)
	default:
		b.mu.Unlock()
	}
}

// replaceTarget follows a replacement of the recorded page's capture, or a change
// of its size: the burst carries on in a new segment, which has the new size.
func (b *recordingBursts) replaceTarget(target wrapperTargetSnapshot) {
	b.mu.Lock()
	current := b.segTarget
	if b.stopping || (b.state != burstActive && b.state != burstTail) || current.TargetID != target.TargetID ||
		(current.CaptureID == target.CaptureID && current.Generation == target.Generation && current.Viewport == target.Viewport) {
		b.mu.Unlock()
		return
	}
	// A burst that is running, or tailing off, carries on in a new segment.
	seg := b.startClosingLocked(true)
	b.mu.Unlock()
	b.backend.changed()
	b.finishClose(seg, "target_changed", &target)
}

// follow moves a burst that is running to another page: the segment on the old
// page closes and a new one opens on the new page, without a lead, for the
// action that is still running.
func (b *recordingBursts) follow(targetID string) {
	target, ready := b.backend.target(targetID)
	if !ready {
		return
	}
	b.mu.Lock()
	if b.stopping || b.state != burstActive || b.segTarget.TargetID == target.TargetID {
		b.mu.Unlock()
		return
	}
	seg := b.startClosingLocked(true)
	b.mu.Unlock()
	b.backend.changed()
	b.finishClose(seg, "target_changed", &target)
}

// whileIdle runs f if no burst is running, holding the controller so none can
// start meanwhile, and reports whether it ran.
func (b *recordingBursts) whileIdle(f func()) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.state != burstIdle {
		return false
	}
	f()
	return true
}

// shutdown ends the controller. A graceful shutdown lets a burst that is tailing
// off finish first (bounded by its longest tail), so the last action's result is
// in the video; otherwise, and for a burst still running, it closes at once. It
// returns when no segment is being written any more.
func (b *recordingBursts) shutdown(graceful bool) {
	b.mu.Lock()
	b.stopping = true
	for {
		switch b.state {
		case burstStopped:
			b.mu.Unlock()
			return
		case burstIdle:
			b.state = burstStopped
			b.publishLocked()
			b.mu.Unlock()
			b.cancelRoot()
			if b.onStopped != nil {
				b.onStopped()
			}
			b.backend.changed()
			return
		case burstOpening:
			if b.cancelOpen != nil {
				b.cancelOpen()
			}
			_ = b.waitLocked(context.Background())
		case burstClosing:
			_ = b.waitLocked(context.Background())
		case burstTail:
			if graceful {
				_ = b.waitLocked(context.Background())
				continue
			}
			fallthrough
		case burstActive:
			seg := b.startClosingLocked(false)
			b.mu.Unlock()
			b.finishClose(seg, "stopped", nil)
			b.mu.Lock()
		}
	}
}

// warn reports something a bursts recording did not expect.
func burstWarn(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "browser-session-wrapper: "+format+"\n", args...)
}

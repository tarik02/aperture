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
// action never runs against a segment that is being closed. The same goes for a
// burst that is moving to another page in the background after a tab action
// (following): actions wait for it, and its tail starts when it is done.

const (
	burstDefaultLead    = 400 * time.Millisecond
	burstDefaultTail    = 600 * time.Millisecond
	burstDefaultSettle  = 500 * time.Millisecond
	burstDefaultMaxTail = 4 * time.Second

	burstMaxLeadMs   = 10000
	burstMaxTailMs   = 30000
	burstMaxSettleMs = 30000
	// burstMaxMaxTailMs bounds a burst's tail. A graceful stop waits for the actions
	// that are running and then for the tail, but never longer than
	// burstStopActionWait+burstStopTailSlack in all, which is what keeps it under
	// the timeouts MCP clients commonly put on a tool call.
	burstMaxMaxTailMs = 30000

	// burstFirstFrameTimeout is how long a burst waits for its pipeline's first
	// frame, as long as a replacement segment waits for data.
	burstFirstFrameTimeout = 5 * time.Second
	// burstOpenAttempts is how many pipelines a burst tries for its first frame.
	// Each gets burstFirstFrameTimeout divided among the attempts; a pipeline that
	// started against a capture that was replaced meanwhile never produces one,
	// so the wait also ends when the page's capture changes.
	burstOpenAttempts   = 2
	burstCapturePollGap = 100 * time.Millisecond
	// burstIdleProbeTimeout bounds one ask of the compositor while a tail settles.
	burstIdleProbeTimeout = 500 * time.Millisecond
	// burstBlindAfter is how many failed asks in a row make a tail assume that the
	// screen settled at the time it would have, instead of waiting for an answer.
	burstBlindAfter = 3
	// burstMaxFailures is how many capture pipelines in a row may fail before the
	// recording fails, counting failures to open and pipelines that exit during a
	// burst separately.
	burstMaxFailures = 3
	// burstMaxSegments bounds the segments of one recording, which is also the
	// number of files its stop joins with one concat.
	burstMaxSegments = 200
	// burstTargetReadyTimeout is how long a burst waits for the page an action
	// runs on to become ready: a page that was just opened is not in the target
	// registry until its next sync.
	burstTargetReadyTimeout = 1500 * time.Millisecond
	burstTargetPoll         = 25 * time.Millisecond
	// burstExitGrace is how long a pipeline that exited is given for its page to be
	// reported closed, before the exit counts as a capture failure.
	burstExitGrace = time.Second
	burstExitPoll  = 50 * time.Millisecond
	// burstStopActionWait bounds how long a graceful stop waits for the actions
	// that are running to end.
	burstStopActionWait = 30 * time.Second
	// burstStopTailSlack is how long past a tail's hard end a graceful stop waits
	// for the tail to close the burst before it closes it itself. It is also the
	// room a stop has, beyond burstStopActionWait, for a tail: the whole graceful
	// wait, actions and tail together, ends burstStopActionWait+burstStopTailSlack
	// after the stop began.
	burstStopTailSlack = 5 * time.Second
)

var (
	// errBurstUnavailable means a burst could not be opened. The action runs
	// anyway: a recording never fails the automation.
	errBurstUnavailable = errors.New("burst recording is unavailable")
	errBurstInProgress  = errors.New("a burst is in progress")
	// errBurstStopped means the recording is stopping and takes no more actions.
	errBurstStopped = errors.New("the recording is stopping")
	// errBurstLimit means the recording holds as many segments as it may. It is
	// not a capture failure.
	errBurstLimit = errors.New("the recording has reached its limit of segments")
	// errBurstNoFrame and errBurstCaptureChanged end an attempt to open a segment.
	errBurstNoFrame        = errors.New("the capture pipeline produced no frame")
	errBurstCaptureChanged = errors.New("the page's capture changed while the pipeline started")
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
	// could be opened for them, and the bursts whose video was lost.
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
	// refreshTargets asks for the page registry to sync now, for a caller that
	// waits for a page it knows exists. It may be slow, and ends with ctx.
	refreshTargets(ctx context.Context)
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
	// openCancelReason is why the opening that cancelOpen would cancel is being
	// cancelled, when it is not because the recording stops.
	openCancelReason string
	tailCancel       context.CancelFunc
	tailID           uint64
	// following counts the moves to another page that are running in the
	// background: the burst does not tail off, and no action joins it, until they
	// are done.
	following int
	// followTo is the page a finished move found the automation on, when the
	// burst could not move to it at once because it was opening or closing. The
	// move is made when the burst settles; see settleFollowLocked.
	followTo string
	// pending counts the actions that have arrived and are still finding out which
	// page they run on: the burst does not close its tail meanwhile.
	pending int
	// changed is closed and replaced at every state change, so a waiter can wait
	// for the next one.
	changed chan struct{}
	count   int
	capped  int
	skipped int
	// burstKept is the segments of the current burst that were kept, and keptTotal
	// those of the whole recording.
	burstKept int
	keptTotal int
	// openFailures counts the openings that failed in a row, and exitFailures the
	// pipelines in a row that exited during a burst.
	openFailures int
	exitFailures int
	lastError    string
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

// arrive tells the controller that an action has arrived and is finding out
// which page it runs on, which can take a while. Until the returned function is
// called, which the caller does once begin returned, a tail does not close, so
// the action can join the burst it would have joined had it arrived at once.
// It is safe to call the function more than once.
func (b *recordingBursts) arrive() (release func()) {
	b.mu.Lock()
	b.pending++
	b.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			b.mu.Lock()
			b.pending--
			b.mu.Unlock()
		})
	}
}

// begin runs before an action. It returns a handle to pass to end, or nil when
// the action is not part of a burst: the recording is stopping, the action only
// waits and no burst is open, or a burst could not be opened (errBurstUnavailable,
// in which case the action should run anyway).
//
// For an action that opens a burst, begin returns once the burst's first frame
// exists and, for a pointer action, its lead has been recorded. An action that
// runs on a page that is not ready yet (one that was just opened) waits a short
// while for it.
func (b *recordingBursts) begin(ctx context.Context, action burstAction) (*burstHandle, error) {
	awaited := false
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
			if b.following > 0 {
				// The burst closed while a tab action was moving it: the move opens a
				// burst on the page it finds, which the action joins.
				if err := b.waitLocked(ctx); err != nil {
					b.mu.Unlock()
					return nil, err
				}
				continue
			}
			target, ready := b.backend.target(action.TargetID)
			if !ready && !awaited && action.TargetID != "" {
				awaited = true
				if err := b.awaitTargetUnlocked(ctx, action.TargetID); err != nil {
					return nil, err
				}
				continue
			}
			return b.openForAction(ctx, action, target, ready)
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
			if action.Kind != burstActionObserve && b.following > 0 {
				// The burst is moving to another page: the action belongs to whatever
				// it finds there.
				if err := b.waitLocked(ctx); err != nil {
					b.mu.Unlock()
					return nil, err
				}
				continue
			}
			if action.Kind != burstActionObserve && action.TargetID != "" && action.TargetID != b.segTarget.TargetID {
				if _, ready := b.backend.target(action.TargetID); !ready && !awaited {
					awaited = true
					if err := b.awaitTargetUnlocked(ctx, action.TargetID); err != nil {
						return nil, err
					}
					continue
				}
				// The automation moved to another page: record it in a burst of its own.
				seg := b.startClosingLocked(false)
				b.mu.Unlock()
				b.backend.changed()
				b.finishClose(seg, "target_changed", nil)
				b.mu.Lock()
				continue
			}
			return b.joinLocked(action), nil
		}
	}
}

// awaitTargetUnlocked waits for a page to become ready with the lock released,
// and takes the lock again. It fails only when ctx ended.
func (b *recordingBursts) awaitTargetUnlocked(ctx context.Context, id string) error {
	b.mu.Unlock()
	b.awaitTarget(ctx, id)
	if err := ctx.Err(); err != nil {
		return err
	}
	b.mu.Lock()
	return nil
}

// awaitTarget waits, for at most burstTargetReadyTimeout, for a page to become
// ready. It asks the registry to sync instead of waiting for its next round.
func (b *recordingBursts) awaitTarget(ctx context.Context, id string) (wrapperTargetSnapshot, bool) {
	ctx, cancel := context.WithTimeout(ctx, burstTargetReadyTimeout)
	defer cancel()
	defer context.AfterFunc(b.root, cancel)()
	for attempt := 0; ; attempt++ {
		if target, ready := b.backend.target(id); ready {
			return target, true
		}
		if attempt%10 == 0 {
			b.backend.refreshTargets(ctx)
		}
		if sleepContext(ctx, burstTargetPoll) != nil {
			return b.backend.target(id)
		}
	}
}

// joinLocked adds an action to the burst that is open. It unlocks.
func (b *recordingBursts) joinLocked(action burstAction) *burstHandle {
	handle := b.registerLocked(action)
	handle.started = time.Now()
	if b.state == burstTail {
		b.tailCancel()
		b.tailCancel = nil
		b.state = burstActive
		b.publishLocked()
	}
	b.mu.Unlock()
	return handle
}

// openForAction opens a burst for an action that finds none, and waits for its
// first frame and lead. It runs with the lock held and unlocks.
func (b *recordingBursts) openForAction(ctx context.Context, action burstAction, target wrapperTargetSnapshot, ready bool) (*burstHandle, error) {
	reason := ""
	switch {
	case !ready:
		reason = "the page to record is not ready"
	case b.keptTotal >= burstMaxSegments:
		reason = fmt.Sprintf("the recording has reached its limit of %d segments", burstMaxSegments)
	}
	if reason != "" {
		b.skipLocked(reason)
		b.mu.Unlock()
		b.backend.changed()
		return nil, errBurstUnavailable
	}
	handle := b.registerLocked(action)
	b.followTo = ""
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
		b.burstKept = 0
	}
	b.publishLocked()
	return ctx
}

// runOpening starts the segment of a burst and waits for its first frame and
// lead. It runs without the lock held, in the state startOpeningLocked set, and
// leaves the controller active, or idle when it fails.
func (b *recordingBursts) runOpening(ctx context.Context, target wrapperTargetSnapshot, burst uint64, lead time.Duration, newBurst bool) error {
	seg, err := b.openSegment(ctx, target, burst, lead)
	b.mu.Lock()
	switch {
	case err != nil:
	case b.stopping:
		err = errBurstStopped
	case ctx.Err() != nil:
		// Cancelled while the segment finished opening (the page closed, or the
		// caller went away): the cancellation wins, so that its reason is kept.
		err = ctx.Err()
	}
	if err != nil {
		return b.abortOpening(ctx, seg, err, newBurst)
	}
	b.activateLocked(seg, newBurst)
	b.mu.Unlock()
	b.backend.changed()
	// The page's capture may have been replaced, or its size changed, while the
	// segment opened, when nothing could follow it yet.
	if current, ready := b.backend.target(target.TargetID); ready {
		b.replaceTarget(current)
	}
	// A tab action may have moved on to another page while the burst was opening.
	b.mu.Lock()
	b.settleFollowLocked(false)
	return nil
}

// openSegment starts the pipeline of a segment, and waits for its first frame
// and, after it, the lead. A pipeline that started while the page's capture was
// being replaced never gets a frame: it is dropped, as soon as the capture is seen
// to change or the attempt's share of the wait is over, and started again on the
// page as it is then.
func (b *recordingBursts) openSegment(ctx context.Context, target wrapperTargetSnapshot, burst uint64, lead time.Duration) (burstSegment, error) {
	var seg burstSegment
	var err error
	for attempt := 1; ; attempt++ {
		seg, err = b.backend.open(ctx, target, burst)
		if err != nil {
			return nil, err
		}
		err = b.awaitFirstFrame(ctx, seg, target, burstFirstFrameTimeout/burstOpenAttempts)
		if !errors.Is(err, errBurstNoFrame) && !errors.Is(err, errBurstCaptureChanged) || attempt >= burstOpenAttempts {
			break
		}
		burstWarn("burst pipeline for page %s got no first frame (%v); starting it again", target.TargetID, err)
		seg.Discard()
		seg = nil
		next, ready := b.awaitTarget(ctx, target.TargetID)
		if !ready {
			return nil, errors.New("the page to record stopped being ready")
		}
		target = next
		b.mu.Lock()
		b.segTarget = target
		b.mu.Unlock()
	}
	if err == nil && lead > 0 {
		err = sleepUntil(ctx, seg.Anchor().Add(lead))
	}
	return seg, err
}

// awaitFirstFrame waits for the segment's first frame, at most timeout, and gives
// up early when the page's capture is not the one the pipeline was started on.
func (b *recordingBursts) awaitFirstFrame(ctx context.Context, seg burstSegment, target wrapperTargetSnapshot, timeout time.Duration) error {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	poll := time.NewTicker(burstCapturePollGap)
	defer poll.Stop()
	for {
		select {
		case <-seg.FirstFrame():
			return nil
		case <-seg.Exited():
			return errors.New("the capture pipeline exited before its first frame")
		case <-timer.C:
			return errBurstNoFrame
		case <-ctx.Done():
			return ctx.Err()
		case <-poll.C:
			current, ready := b.backend.target(target.TargetID)
			if !ready || current.CaptureID != target.CaptureID || current.Generation != target.Generation || current.Viewport != target.Viewport {
				return errBurstCaptureChanged
			}
		}
	}
}

// activateLocked makes an opened segment the burst's.
func (b *recordingBursts) activateLocked(seg burstSegment, newBurst bool) {
	b.cancelOpen()
	b.cancelOpen = nil
	b.openCancelReason = ""
	b.seg = seg
	b.state = burstActive
	b.openFailures = 0
	if newBurst {
		b.count++
	}
	go b.watch(seg)
	if len(b.handles) == 0 && b.plan.valid {
		// The burst was reopened on a new capture after its actions ended: it goes
		// on tailing off, for at least a tail of the new segment.
		b.plan.minEnd = laterOf(b.plan.minEnd, time.Now().Add(b.cfg.Tail))
		b.plan.hardEnd = laterOf(b.plan.hardEnd, b.plan.minEnd)
		b.resumeTailLocked()
	}
	b.publishLocked()
}

// abortOpening ends an opening that failed or was cancelled. It runs with the
// lock held and unlocks. Cancelled openings are not failures: the caller went
// away, the page closed, or the recording is stopping.
func (b *recordingBursts) abortOpening(ctx context.Context, seg burstSegment, err error, newBurst bool) error {
	stopping := b.stopping
	reason := b.openCancelReason
	b.openCancelReason = ""
	b.followTo = ""
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
	if !newBurst && b.burstKept == 0 {
		// The reopening of a burst none of whose segments was kept.
		b.count = max(0, b.count-1)
	}
	failed := false
	switch {
	case stopping:
	case cancelled && reason != "":
		b.skipped++
		b.lastError = reason
	case cancelled:
	case errors.Is(err, errBurstLimit):
		b.skipped++
		b.lastError = err.Error()
	default:
		b.openFailures++
		b.skipped++
		b.lastError = err.Error()
		failed = b.openFailures >= burstMaxFailures
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
	case cancelled && reason == "":
		return context.Canceled
	default:
		return errBurstUnavailable
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
	if len(b.handles) == 0 && b.state == burstActive && b.following == 0 {
		b.resumeTailLocked()
		b.publishLocked()
	}
}

// resumeTailLocked starts the tail of a burst whose actions have all ended and
// which is not moving to another page, if it has a tail to run.
func (b *recordingBursts) resumeTailLocked() {
	if b.state == burstActive && len(b.handles) == 0 && b.following == 0 && b.plan.valid {
		b.enterTailLocked()
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
		if reason != "" && b.closeFromTail(id, reason) {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// closeFromTail closes the burst when the tail that id names is over. It reports
// false when an action that has arrived holds the burst open, and the tail
// should keep waiting.
func (b *recordingBursts) closeFromTail(id uint64, reason string) bool {
	b.mu.Lock()
	if b.state != burstTail || b.tailID != id {
		b.mu.Unlock()
		return true
	}
	if b.pending > 0 {
		b.mu.Unlock()
		return false
	}
	seg := b.startClosingLocked(false)
	if reason == "max_tail" {
		b.capped++
	}
	b.mu.Unlock()
	b.backend.changed()
	b.finishClose(seg, reason, nil)
	return true
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
	reopening := reopen != nil && !b.stopping && (len(b.handles) > 0 || b.plan.valid)
	var reopenTarget wrapperTargetSnapshot
	if reopening {
		// The page may have closed while the segment was closing: reopening on it
		// would only fail, and count as a capture failure.
		var ready bool
		if reopenTarget, ready = b.backend.target(reopen.TargetID); !ready {
			reopening = false
			b.lastError = "the page to record closed while its burst was closing"
		}
	}
	if err != nil {
		b.lastError = fmt.Sprintf("closing a burst: %v", err)
		if b.burstKept == 0 && !reopening {
			// Nothing of the burst survives.
			b.count = max(0, b.count-1)
			b.skipped++
		}
	} else {
		b.burstKept++
		b.keptTotal++
		if reason != "pipeline_failed" {
			b.exitFailures = 0
		}
	}
	if reopening {
		openCtx := b.startOpeningLocked(b.root, reopenTarget, false)
		burst := b.burstNo
		b.mu.Unlock()
		b.backend.changed()
		_ = b.runOpening(openCtx, reopenTarget, burst, 0, false)
		return
	}
	clear(b.handles)
	b.plan = tailPlan{}
	b.state = burstIdle
	b.publishLocked()
	if b.followTo != "" {
		// A tab action moved the automation to another page while the burst was
		// closing: there is no burst to move, so one opens on that page.
		b.settleFollowLocked(false)
		return
	}
	b.mu.Unlock()
	b.backend.changed()
}

// watch reacts to a segment's pipeline exiting on its own.
func (b *recordingBursts) watch(seg burstSegment) {
	<-seg.Exited()
	// A pipeline whose page closed exits too, usually before the registry reports
	// the page closed: that is not a capture failure, so the page gets a moment
	// to be reported.
	deadline := time.Now().Add(burstExitGrace)
	for {
		b.mu.Lock()
		if b.seg != seg || (b.state != burstActive && b.state != burstTail) {
			b.mu.Unlock()
			return
		}
		_, ready := b.backend.target(b.segTarget.TargetID)
		if !ready || !time.Now().Before(deadline) {
			reason, failed := "target_closed", false
			if ready {
				reason = "pipeline_failed"
				b.exitFailures++
				b.lastError = "the capture pipeline exited during a burst"
				failed = b.exitFailures >= burstMaxFailures
			}
			seg = b.startClosingLocked(false)
			b.mu.Unlock()
			b.backend.changed()
			b.finishClose(seg, reason, nil)
			if failed {
				b.backend.failed("pipeline_failed", errors.New("the capture pipeline failed repeatedly"))
			}
			return
		}
		b.mu.Unlock()
		if sleepContext(b.root, burstExitPoll) != nil {
			return
		}
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
			b.openCancelReason = "the page closed while its burst was opening"
			b.cancelOpen()
		}
		b.mu.Unlock()
	case burstActive, burstTail:
		seg := b.startClosingLocked(false)
		b.mu.Unlock()
		// The registry calls this from inside its own sync, which must not wait for
		// a pipeline to finish: the close runs on, and actions wait for it.
		go b.finishCloseAndNotify(seg, "target_closed", nil)
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
	// Like targetClosed, this runs inside the registry's sync, and the reopening
	// waits for a first frame and for the registry itself: it runs in the
	// background.
	go b.finishCloseAndNotify(seg, "target_changed", &target)
}

// finishCloseAndNotify tells clients the burst is closing, then finishes the close.
func (b *recordingBursts) finishCloseAndNotify(seg burstSegment, reason string, reopen *wrapperTargetSnapshot) {
	b.backend.changed()
	b.finishClose(seg, reason, reopen)
}

// startFollow moves a burst that an action is running in to the page the action
// left the automation on, when that is another page: the segment on the old page
// closes and a new one opens on the new page, without a lead, for the action
// that is still running. Finding the page, waiting for it to be ready and the
// close and reopening all run in the background, owned by the controller; until
// they are done the burst does not tail off and later actions wait for it. The
// action's ticket calls it before end.
//
// The move does not depend on the state the burst is in: a burst that is being
// closed or reopened (its page's capture was replaced) makes the move when it
// settles, and one that ended under the action (the tab it recorded was closed)
// gets a new burst on the page the automation is on now. See settleFollowLocked.
func (b *recordingBursts) startFollow(identify func() string) {
	b.mu.Lock()
	if b.stopping || b.state == burstStopped {
		b.mu.Unlock()
		return
	}
	b.following++
	b.mu.Unlock()
	go b.follow(identify)
}

func (b *recordingBursts) follow(identify func() string) {
	var target wrapperTargetSnapshot
	found := false
	if targetID := identify(); targetID != "" {
		target, found = b.awaitTarget(b.root, targetID)
	}
	b.mu.Lock()
	b.following--
	if found {
		b.followTo = target.TargetID
	}
	b.settleFollowLocked(true)
}

// settleFollowLocked carries out the move to the page a follow found, once the
// burst is in a state to make it. It runs with the lock held and unlocks, and may
// wait for a segment to open. finished says a follow just ended, so that a burst
// that stays where it is starts the tail its actions asked for.
//
//   - Running or tailing off on another page: the segment closes and one opens on
//     the page.
//   - Opening or closing: nothing yet. The page is kept in followTo, and the
//     opening, or the close that leaves the controller idle, calls this again.
//   - Idle: the burst ended while the action moved (its page closed, or its
//     capture failed), so a new burst opens on the page, and tails off like the
//     one that was lost.
//
// While other moves are running the last of them settles.
func (b *recordingBursts) settleFollowLocked(finished bool) {
	if b.followTo == "" && !finished {
		b.mu.Unlock()
		return
	}
	if b.following > 0 {
		if finished {
			b.publishLocked()
		}
		b.mu.Unlock()
		b.backend.changed()
		return
	}
	id := b.followTo
	b.followTo = ""
	var target wrapperTargetSnapshot
	ready := false
	if id != "" && !b.stopping {
		target, ready = b.backend.target(id)
	}
	switch b.state {
	case burstActive, burstTail:
		if ready && target.TargetID != b.segTarget.TargetID {
			seg := b.startClosingLocked(true)
			b.mu.Unlock()
			b.backend.changed()
			b.finishClose(seg, "target_changed", &target)
			return
		}
		// Nowhere to move to: the tail the actions asked for starts now.
		b.resumeTailLocked()
	case burstIdle:
		if ready && b.keptTotal < burstMaxSegments {
			now := time.Now()
			b.plan = tailPlan{valid: true, gestureEnd: now, minEnd: now.Add(b.cfg.Tail), hardEnd: now.Add(max(b.cfg.MaxTail, b.cfg.Tail))}
			openCtx := b.startOpeningLocked(b.root, target, true)
			burst := b.burstNo
			b.mu.Unlock()
			b.backend.changed()
			_ = b.runOpening(openCtx, target, burst, 0, true)
			return
		}
	case burstOpening, burstClosing:
		if id != "" && !b.stopping {
			b.followTo = id
		}
	}
	b.publishLocked()
	b.mu.Unlock()
	b.backend.changed()
}

// whileIdle runs f if no burst is running, holding the controller so none can
// start meanwhile. It returns errBurstInProgress when a burst is running, and
// errBurstStopped when the controller has stopped or is stopping.
func (b *recordingBursts) whileIdle(f func()) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	switch {
	case b.stopping || b.state == burstStopped:
		return errBurstStopped
	case b.state != burstIdle:
		return errBurstInProgress
	}
	f()
	return nil
}

// waitUntilLocked waits for the next state change, at most until deadline or
// until the controller's root ends.
func (b *recordingBursts) waitUntilLocked(deadline time.Time) error {
	ctx, cancel := context.WithDeadline(b.root, deadline)
	defer cancel()
	return b.waitLocked(ctx)
}

// shutdown ends the controller. A graceful shutdown lets the actions that are
// running end and a burst that is tailing off finish first, so the last action's
// result is in the video; otherwise, and for a burst that is running, it closes
// at once. A graceful shutdown waits for actions at most burstStopActionWait and
// for a tail until its hard end (plus burstStopTailSlack), but for both together
// no longer than burstStopActionWait+burstStopTailSlack, and gives up when the
// controller's root ends.
// It returns when no segment is being written any more.
func (b *recordingBursts) shutdown(graceful bool) {
	b.mu.Lock()
	b.stopping = true
	// The wait for actions and for a tail together ends at gracefulEnd, so that a
	// graceful stop stays within burstStopActionWait+burstStopTailSlack however the
	// two add up.
	gracefulEnd := time.Now().Add(burstStopActionWait + burstStopTailSlack)
	var actionsDeadline time.Time
	for {
		if graceful && b.root.Err() != nil {
			graceful = false
		}
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
			// Openings and closings are bounded by their own timeouts.
			if b.cancelOpen != nil {
				b.cancelOpen()
			}
			_ = b.waitLocked(context.Background())
		case burstClosing:
			_ = b.waitLocked(context.Background())
		case burstTail:
			if graceful {
				tailDeadline := b.curPlan.hardEnd.Add(burstStopTailSlack)
				if tailDeadline.After(gracefulEnd) {
					tailDeadline = gracefulEnd
				}
				if b.waitUntilLocked(tailDeadline) != nil {
					graceful = false
				}
				continue
			}
			b.closeForShutdown()
		case burstActive:
			if graceful && (len(b.handles) > 0 || b.following > 0) {
				if actionsDeadline.IsZero() {
					actionsDeadline = time.Now().Add(burstStopActionWait)
				}
				if b.waitUntilLocked(actionsDeadline) != nil {
					graceful = false
				}
				continue
			}
			b.closeForShutdown()
		}
	}
}

// closeForShutdown closes the burst that is running, with the lock held on entry
// and on return.
func (b *recordingBursts) closeForShutdown() {
	seg := b.startClosingLocked(false)
	b.mu.Unlock()
	b.finishClose(seg, "stopped", nil)
	b.mu.Lock()
}

// burstWarn reports something a bursts recording did not expect.
func burstWarn(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "browser-session-wrapper: "+format+"\n", args...)
}

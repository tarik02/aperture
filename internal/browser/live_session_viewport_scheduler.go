package browser

import (
	"sync"
	"time"
)

// liveSessionAutoSizeCoalesceInterval is how often the scheduler applies the newest auto-size
// viewport. Auto-size follows a window drag, so intermediate sizes arrive at frame rate; applying
// each one would queue seconds of resizes and block the client's other messages. One apply per
// interval keeps the browser close to the drag without building a backlog.
const liveSessionAutoSizeCoalesceInterval = 100 * time.Millisecond

type liveSessionAutoSizeViewport struct {
	client            *liveSessionClient
	targetID          string
	width             int
	height            int
	deviceScaleFactor float64
	generation        uint64
}

// liveSessionViewportScheduler coalesces the viewport owner's auto-size resizes and serializes
// them with explicit viewport changes. The live session command loop only records the newest
// auto-size viewport; a background loop applies it, so input and other commands never wait for a
// resize.
type liveSessionViewportScheduler struct {
	session *liveSession

	mu          sync.Mutex
	pending     map[string]liveSessionAutoSizeViewport
	generations map[string]uint64
	suppressed  map[string]int
	closed      bool

	// applyMu serializes the background applier with explicit viewport changes, so an explicit
	// size is always the last resize applied for its target.
	applyMu sync.Mutex

	done chan struct{}
	wg   sync.WaitGroup
}

func newLiveSessionViewportScheduler(session *liveSession) *liveSessionViewportScheduler {
	scheduler := &liveSessionViewportScheduler{
		session:     session,
		pending:     make(map[string]liveSessionAutoSizeViewport),
		generations: make(map[string]uint64),
		suppressed:  make(map[string]int),
		done:        make(chan struct{}),
	}
	scheduler.wg.Add(1)
	go scheduler.run()
	return scheduler
}

// schedule records the newest auto-size viewport for a target. It never waits for the resize.
func (scheduler *liveSessionViewportScheduler) schedule(client *liveSessionClient, targetID string, width int, height int, deviceScaleFactor float64) {
	scheduler.mu.Lock()
	defer scheduler.mu.Unlock()
	if scheduler.closed {
		return
	}
	if scheduler.suppressed[targetID] > 0 {
		return
	}
	scheduler.pending[targetID] = liveSessionAutoSizeViewport{
		client:            client,
		targetID:          targetID,
		width:             width,
		height:            height,
		deviceScaleFactor: deviceScaleFactor,
		generation:        scheduler.generations[targetID],
	}
}

// applyExplicit applies a viewport change that is not the owner's auto-size. It drops any
// auto-size still waiting, prevents new ones for the target from overtaking this change, and
// waits for the resize to finish. settled runs on success before auto-size resumes.
func (scheduler *liveSessionViewportScheduler) applyExplicit(targetID string, apply func() error, settled func()) error {
	scheduler.mu.Lock()
	scheduler.generations[targetID]++
	delete(scheduler.pending, targetID)
	scheduler.suppressed[targetID]++
	scheduler.mu.Unlock()

	err := func() error {
		scheduler.applyMu.Lock()
		defer scheduler.applyMu.Unlock()
		return apply()
	}()
	if err == nil && settled != nil {
		settled()
	}

	scheduler.mu.Lock()
	scheduler.suppressed[targetID]--
	if scheduler.suppressed[targetID] <= 0 {
		delete(scheduler.suppressed, targetID)
	}
	scheduler.mu.Unlock()
	return err
}

func (scheduler *liveSessionViewportScheduler) stop() {
	scheduler.mu.Lock()
	if scheduler.closed {
		scheduler.mu.Unlock()
		return
	}
	scheduler.closed = true
	clear(scheduler.pending)
	scheduler.mu.Unlock()
	close(scheduler.done)
	scheduler.wg.Wait()
}

func (scheduler *liveSessionViewportScheduler) run() {
	defer scheduler.wg.Done()
	ticker := time.NewTicker(liveSessionAutoSizeCoalesceInterval)
	defer ticker.Stop()
	for {
		select {
		case <-scheduler.done:
			return
		case <-ticker.C:
			scheduler.flush()
		}
	}
}

func (scheduler *liveSessionViewportScheduler) flush() {
	scheduler.mu.Lock()
	if scheduler.closed || len(scheduler.pending) == 0 {
		scheduler.mu.Unlock()
		return
	}
	pending := make([]liveSessionAutoSizeViewport, 0, len(scheduler.pending))
	for targetID, viewport := range scheduler.pending {
		pending = append(pending, viewport)
		delete(scheduler.pending, targetID)
	}
	scheduler.mu.Unlock()

	for _, viewport := range pending {
		scheduler.apply(viewport)
	}
}

func (scheduler *liveSessionViewportScheduler) apply(viewport liveSessionAutoSizeViewport) {
	scheduler.applyMu.Lock()
	defer scheduler.applyMu.Unlock()

	scheduler.mu.Lock()
	suppressed := scheduler.suppressed[viewport.targetID] > 0
	stale := scheduler.closed || scheduler.generations[viewport.targetID] != viewport.generation
	scheduler.mu.Unlock()
	if suppressed || stale {
		return
	}

	// Ownership can move while a resize is in flight; the next viewport state decides who resizes.
	scheduler.session.mu.Lock()
	owner := scheduler.session.viewportOwner
	scheduler.session.mu.Unlock()
	if owner != viewport.client {
		return
	}

	_ = scheduler.session.browser.setViewport(
		viewport.targetID,
		viewport.width,
		viewport.height,
		viewport.deviceScaleFactor,
	)
}

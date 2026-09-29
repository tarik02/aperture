package browser

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// burstTicket ties one browser action to the bursts recordings that record it. It
// is made by beginBurstAction before the action runs and ended after it. A nil
// ticket, which is what an action gets when no bursts recording exists, is valid
// and does nothing.
type burstTicket struct {
	// targetID is the page the action runs on, when it could be identified.
	targetID string
	entries  []burstTicketEntry
	once     sync.Once
	// follow finds the page the action left the automation on, so that the bursts
	// move to it. Only the tab tool sets it: it is the one action after which the
	// page Playwright controls is another. It is called in the background, at most
	// once, and does not depend on the action's context.
	follow func() string
}

type burstTicketEntry struct {
	bursts *recordingBursts
	handle *burstHandle
}

// burstFollowProbeTimeout bounds finding the page a tab action left the
// automation on.
const burstFollowProbeTimeout = 3 * time.Second

type burstTicketKey struct{}

func withBurstTicket(ctx context.Context, ticket *burstTicket) context.Context {
	if ticket == nil {
		return ctx
	}
	return context.WithValue(ctx, burstTicketKey{}, ticket)
}

func burstTicketFromContext(ctx context.Context) *burstTicket {
	ticket, _ := ctx.Value(burstTicketKey{}).(*burstTicket)
	return ticket
}

// resolvedTarget is the page the action was found to run on, or empty.
func (t *burstTicket) resolvedTarget() string {
	if t == nil {
		return ""
	}
	return t.targetID
}

// actionEnded tells the bursts that the action's effect on the page ended at a
// wall time, before the call itself returns (a pointer tool goes on holding, and
// reads the page). gesture is the pointer gesture it made, or zero.
func (t *burstTicket) actionEnded(at time.Time, gesture uint64) {
	if t == nil {
		return
	}
	for _, entry := range t.entries {
		entry.handle.gestureEnd = at
		entry.handle.gesture = gesture
	}
}

// end runs after the action, with its error if it failed. It does not wait: the
// tail of the burst, and the move of a tab action's burst to the page it left the
// automation on, run on in the background.
func (t *burstTicket) end(err error) {
	if t == nil {
		return
	}
	t.once.Do(func() {
		if t.follow != nil && err == nil {
			// The burst goes on with the page the automation is on now, so that its
			// tail shows what the tool switched to. It is registered before the
			// action ends, so the burst does not start tailing off on the old page.
			for _, entry := range t.entries {
				entry.bursts.startFollow(entry.handle, t.follow)
			}
		}
		callEnd := time.Now()
		for _, entry := range t.entries {
			entry.bursts.end(entry.handle, callEnd, err)
		}
	})
}

// burstControllers returns the controllers of the running bursts recordings.
func (session *liveSession) burstControllers() []*recordingBursts {
	r := session.runtime
	r.mu.Lock()
	defer r.mu.Unlock()
	var controllers []*recordingBursts
	for _, recording := range session.recordings {
		if recording.bursts != nil && recording.Status == wrapperRecordingRunning {
			controllers = append(controllers, recording.bursts)
		}
	}
	return controllers
}

// beginBurstAction runs before a browser tool call that the bursts recordings of
// the session may record, after its arguments were checked. When it returns the
// bursts that record the action are running: their first frames exist and, for a
// pointer tool, so does the lead that shows the page before the pointer moves. It
// never fails the action: a burst that cannot be opened only costs the recording
// that action.
//
// The returned context carries the ticket; end it when the action is done.
// Sessions without a bursts recording answer at once, before looking at the call.
func (r *wrapperRuntime) beginBurstAction(ctx context.Context, tool string, arguments map[string]any, hold time.Duration) (context.Context, *burstTicket) {
	session := r.liveSession
	if session == nil || session.burstRecordings.Load() == 0 {
		return ctx, nil
	}
	kind := classifyBurstAction(tool, arguments)
	if kind == burstActionNone {
		return ctx, nil
	}
	controllers := session.burstControllers()
	if len(controllers) == 0 {
		return ctx, nil
	}
	action := burstAction{Tool: tool, Kind: kind, Hold: hold}
	if kind != burstActionObserve {
		// Finding the page can take long enough for a burst's tail to run out: the
		// bursts are told the action has arrived, and hold their tails until it has
		// joined or opened one.
		for _, controller := range controllers {
			defer controller.arrive()()
		}
		action.TargetID = r.identifyBurstTarget(ctx)
	}
	ticket := &burstTicket{targetID: action.TargetID}
	entries := make([]burstTicketEntry, len(controllers))
	var group sync.WaitGroup
	for index, controller := range controllers {
		group.Add(1)
		go func() {
			defer group.Done()
			handle, err := controller.begin(ctx, action)
			if err != nil && !errors.Is(err, errBurstUnavailable) && ctx.Err() == nil {
				burstWarn("recording burst for %s: %v", tool, err)
			}
			if handle != nil {
				entries[index] = burstTicketEntry{bursts: controller, handle: handle}
			}
		}()
	}
	group.Wait()
	for _, entry := range entries {
		if entry.handle != nil {
			ticket.entries = append(ticket.entries, entry)
		}
	}
	if tool == "browser_tabs" && len(ticket.entries) > 0 {
		ticket.follow = sync.OnceValue(func() string {
			followCtx, cancel := context.WithTimeout(r.ctx, burstFollowProbeTimeout)
			defer cancel()
			return r.identifyBurstTarget(followCtx)
		})
	}
	if len(ticket.entries) == 0 && ticket.targetID == "" {
		return ctx, nil
	}
	return withBurstTicket(ctx, ticket), ticket
}

// identifyBurstTarget names the page the browser tool that is about to run acts
// on, which is the page Playwright controls. It returns nothing when that cannot
// be told, and the bursts then record the page they fall back to. With several
// pages it costs a probe, which is why it runs only when a bursts recording
// exists; the pointer tools reuse the answer instead of asking again.
func (r *wrapperRuntime) identifyBurstTarget(ctx context.Context) string {
	conn := &pointerCDPConn{port: r.values.CDPPort}
	defer conn.close()
	targetID, err := r.identifyPointerTargetID(ctx, conn, true)
	if err != nil {
		return ""
	}
	return targetID
}

// burstFailure is the error a burst is told an action failed with: the call's
// error, or the tool's own report of a failure.
func burstFailure(result *mcp.CallToolResult, err error) error {
	if err != nil {
		return err
	}
	if result != nil && result.IsError {
		return errors.New("the tool reported an error")
	}
	return nil
}

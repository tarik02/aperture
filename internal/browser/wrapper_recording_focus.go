package browser

import (
	"context"
	"errors"
	"math"
	"time"

	"github.com/aperture/aperture/internal/recording"
)

// focusTrackInterval is how often a focus on a selector measures its element again.
const focusTrackInterval = 100 * time.Millisecond

// recordingFocus is the zoom a recording holds now. A recording holds one at most: a new focus
// ends the one before, and the edit shows the change as the view moving and zooming from one to
// the other, since the two windows touch. A reset, the end of the recording or FocusOpenMaxMS
// zooms out. The focus is journaled when it ends, with how it ended.
//
// A focus on a selector follows its element, so the zoom stays on it when automation scrolls or the
// layout moves, and a focus on the pointer follows the pointer, so what automation clicks and
// hovers stays in view: every move is a track point at its offset from the start. A moment the
// element cannot be measured keeps the last rect; the pointer is a rect without size.
type recordingFocus struct {
	recording *wrapperRecording
	fields    map[string]any // targetId, rect, zoom, follow
	selector  string
	pointer   bool
	targetID  string
	started   time.Time
	stop      chan struct{}
	done      chan struct{}
	track     []map[string]any // written by follow until done
}

// annotateFocus sets the recording's focus. With a duration it zooms out after it, unless another
// focus or a reset ended it first, and returns then; without one it returns at once.
func (session *liveSession) annotateFocus(ctx context.Context, active *wrapperRecording, targetID string, request annotationRequest) error {
	var rect recording.Rect
	var err error
	follow := ""
	switch {
	case request.pointer:
		var ok bool
		if rect, ok = session.pointerRect(targetID); !ok {
			return errors.New("a pointer focus needs a compositor session with the recorded target ready")
		}
		follow = "pointer"
	default:
		if rect, err = session.annotationRect(targetID, request); err != nil {
			return err
		}
		if request.selector != "" {
			follow = "element"
		}
	}
	fields := map[string]any{"targetId": targetID, "rect": rect, "zoom": request.zoom}
	if follow != "" {
		fields["follow"] = follow
	}
	focus := &recordingFocus{
		recording: active,
		fields:    fields,
		selector:  request.selector,
		pointer:   request.pointer,
		targetID:  targetID,
		started:   time.Now(),
		stop:      make(chan struct{}),
		done:      make(chan struct{}),
	}
	r := session.runtime
	r.mu.Lock()
	if active.Status != wrapperRecordingRunning || active.stopping {
		r.mu.Unlock()
		return errors.New("recording stopped")
	}
	previous := active.focus
	active.focus = focus
	r.mu.Unlock()
	if previous != nil {
		previous.end("replaced")
	}
	go session.followFocus(focus, rect)
	if request.durationMS == 0 {
		return nil
	}
	waitErr := sleepContext(ctx, time.Duration(request.durationMS)*time.Millisecond)
	if session.takeFocus(active, focus) != nil {
		focus.end("duration")
	}
	return waitErr
}

// takeFocus detaches the recording's focus, or only the given one when it is still the focus, and
// returns it; whoever takes a focus ends it.
func (session *liveSession) takeFocus(active *wrapperRecording, only *recordingFocus) *recordingFocus {
	r := session.runtime
	r.mu.Lock()
	defer r.mu.Unlock()
	focus := active.focus
	if focus == nil || (only != nil && focus != only) {
		return nil
	}
	active.focus = nil
	return focus
}

// pointerRect is where the pointer is on the target's surface, as a rect without size.
func (session *liveSession) pointerRect(targetID string) (recording.Rect, bool) {
	if session.pointer == nil {
		return recording.Rect{}, false
	}
	surface, ok := session.pointer.surface(targetID)
	if !ok {
		return recording.Rect{}, false
	}
	at := session.pointer.position(surface)
	return recording.Rect{X: at.x, Y: at.y}, true
}

// followFocus measures a selector's element or the pointer until the focus ends, and ends a focus
// that has been held for FocusOpenMaxMS.
func (session *liveSession) followFocus(focus *recordingFocus, last recording.Rect) {
	defer close(focus.done)
	expire := time.NewTimer(recording.FocusOpenMaxMS * time.Millisecond)
	defer expire.Stop()
	var tick <-chan time.Time
	if focus.selector != "" || focus.pointer {
		ticker := time.NewTicker(focusTrackInterval)
		defer ticker.Stop()
		tick = ticker.C
	}
	for {
		select {
		case <-focus.stop:
			return
		case <-expire.C:
			if session.takeFocus(focus.recording, focus) != nil {
				focus.write("expired")
			}
			return
		case <-tick:
			var current recording.Rect
			var ok bool
			if focus.pointer {
				current, ok = session.pointerRect(focus.targetID)
			} else {
				current, ok = session.trackRect(focus.targetID, focus.selector)
			}
			if !ok {
				continue
			}
			moved := max(math.Abs(current.X-last.X), math.Abs(current.Y-last.Y), math.Abs(current.Width-last.Width), math.Abs(current.Height-last.Height))
			if moved < 1 {
				continue
			}
			focus.track = append(focus.track, map[string]any{"atMs": time.Since(focus.started).Milliseconds(), "rect": current})
			last = current
		}
	}
}

// end stops following and journals the focus; only the caller that took the focus ends it.
func (focus *recordingFocus) end(how string) {
	close(focus.stop)
	<-focus.done
	focus.write(how)
}

// write journals the focus as ended now. The recording's journal takes it even while the
// recording is stopping: a stop ends the focus before the edit reads the journal.
func (focus *recordingFocus) write(how string) {
	fields := focus.fields
	fields["ended"] = how
	if len(focus.track) > 0 {
		fields["track"] = focus.track
	}
	focus.recording.journal.append(journalLine("focus", focus.started, fields))
}

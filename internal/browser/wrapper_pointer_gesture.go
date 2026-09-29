package browser

import (
	"sync"
	"time"

	"github.com/aperture/aperture/internal/pointer"
)

const pointerGestureHistory = 256

type pointerGestureKind string

const (
	pointerGestureClick  pointerGestureKind = "click"
	pointerGestureMove   pointerGestureKind = "move"
	pointerGestureDrag   pointerGestureKind = "drag"
	pointerGestureScroll pointerGestureKind = "scroll"
)

// pointerGestureMode says how a gesture reached the page.
type pointerGestureMode string

const (
	// pointerModeCompositor gestures are real Wayland pointer events, so the
	// rendered cursor and page follow the same path a person would produce.
	pointerModeCompositor pointerGestureMode = "compositor"
	// pointerModeCDP gestures go through Playwright, which dispatches input over
	// CDP. They carry no cursor path or motion.
	pointerModeCDP pointerGestureMode = "cdp"
)

// pointerPathPoint is one cursor position, Offset after the gesture started.
// Coordinates are logical pixels of the gesture's compositor surface (CSS pixels at default zoom).
type pointerPathPoint struct {
	Offset time.Duration
	X      float64
	Y      float64
}

// pointerClickPoint is one button press.
type pointerClickPoint struct {
	At     time.Time
	X      float64
	Y      float64
	Button string
	// Count is the click's position within a multi-click, starting at 1.
	Count int
}

// pointerGestureRecord describes one finished gesture. The recording timeline
// consumes it to time captions, cursor effects and bursts.
//
// Every record carries Kind, Tool, Mode, Start, End, Hold and Caption. Only
// pointerModeCompositor records carry Motion, Path and Clicks: Playwright input
// has no cursor path to report, so a pointerModeCDP click, move or drag record
// holds just its timing and caption, and a scroll adds its distance, target and
// wheel position.
type pointerGestureRecord struct {
	ID   uint64
	Kind pointerGestureKind
	// Tool is the pointer tool that ran the gesture.
	Tool string
	Mode pointerGestureMode
	// TargetID is the CDP target of the page the gesture ran on. It is empty for
	// a pointerModeCDP gesture other than a scroll, and for a scroll whose page
	// could not be identified.
	TargetID string
	// Start and End are wall times around the physical gesture. Hold is the
	// extra wait the caller asked for after End.
	Start time.Time
	End   time.Time
	Hold  time.Duration
	// Motion is the resolved motion; unset in pointerModeCDP.
	Motion pointer.Motion
	// Path is the cursor's route and Clicks its button presses; empty in
	// pointerModeCDP.
	Path   []pointerPathPoint
	Clicks []pointerClickPoint
	// ScrollX and ScrollY are a scroll's wheel deltas in CSS pixels.
	ScrollX float64
	ScrollY float64
	// Point is where a scroll's wheel turned, in surface pixels, when the page
	// has a compositor surface. Scrolls carry no Path.
	Point *pointer.Point
	// Caption is the caller's text describing the gesture.
	Caption string
}

// pointerPosition is where the compositor pointer last was.
type pointerPosition struct {
	surfaceID uint64
	point     pointer.Point
}

// pointerRuntime holds the runtime-only pointer state of a live session. Its
// zero value is ready to use.
type pointerRuntime struct {
	mu            sync.Mutex
	sessionMotion pointer.Motion
	last          pointerPosition
	nextID        uint64
	recent        []pointerGestureRecord
	observers     map[int]func(pointerGestureRecord)
	nextObserver  int
}

// currentSessionMotion returns the session's default motion; natural when unset.
func (p *pointerRuntime) currentSessionMotion() pointer.Motion {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.sessionMotion.IsZero() {
		return pointer.Natural
	}
	return p.sessionMotion
}

func (p *pointerRuntime) setSessionMotion(motion pointer.Motion) {
	p.mu.Lock()
	p.sessionMotion = motion
	p.mu.Unlock()
}

// setPosition records where the pointer is on a surface. The compositor has one
// seat, so a later position on another surface replaces this one.
func (p *pointerRuntime) setPosition(surfaceID uint64, point pointer.Point) {
	p.mu.Lock()
	p.last = pointerPosition{surfaceID: surfaceID, point: point}
	p.mu.Unlock()
}

// position returns the last known pointer position if it is on the surface.
func (p *pointerRuntime) position(surfaceID uint64) (pointer.Point, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.last.surfaceID == 0 || p.last.surfaceID != surfaceID {
		return pointer.Point{}, false
	}
	return p.last.point, true
}

// record stores a finished gesture and passes it to the observers.
func (p *pointerRuntime) record(record pointerGestureRecord) {
	p.mu.Lock()
	p.nextID++
	record.ID = p.nextID
	p.recent = append(p.recent, record)
	if len(p.recent) > pointerGestureHistory {
		p.recent = append([]pointerGestureRecord(nil), p.recent[len(p.recent)-pointerGestureHistory:]...)
	}
	observers := make([]func(pointerGestureRecord), 0, len(p.observers))
	for _, observer := range p.observers {
		observers = append(observers, observer)
	}
	p.mu.Unlock()
	for _, observer := range observers {
		observer(record)
	}
}

// observe registers a callback for every finished gesture and returns a
// function that removes it. Callbacks run on the gesture's goroutine after the
// gesture ends and while the automation lease is still held; they must not block.
func (p *pointerRuntime) observe(observer func(pointerGestureRecord)) (stop func()) {
	p.mu.Lock()
	if p.observers == nil {
		p.observers = make(map[int]func(pointerGestureRecord))
	}
	p.nextObserver++
	id := p.nextObserver
	p.observers[id] = observer
	p.mu.Unlock()
	return func() {
		p.mu.Lock()
		delete(p.observers, id)
		p.mu.Unlock()
	}
}

// recentGestures returns the newest gestures, oldest first.
func (p *pointerRuntime) recentGestures() []pointerGestureRecord {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]pointerGestureRecord(nil), p.recent...)
}

// recordingPointerMotion returns the motion configured on the recording that
// captures a target, if any. Recordings do not carry a motion setting yet, so
// this is the hook where it plugs into the resolution order.
func (r *wrapperRuntime) recordingPointerMotion(string) *pointer.Motion {
	return nil
}

// resolvePointerMotion applies the precedence: tool parameter, recording
// setting, session setting, then natural.
func (r *wrapperRuntime) resolvePointerMotion(spec pointerGestureSpec, targetID string) pointer.Motion {
	session := r.pointer.currentSessionMotion()
	return pointer.Resolve(spec.Motion, r.recordingPointerMotion(targetID), &session)
}

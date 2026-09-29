package browser

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/aperture/aperture/internal/recording/edit"
	"github.com/aperture/aperture/internal/recording/timeline"
)

// recordingEffectsRequest is what a recording is started with to apply effects
// to its video when it stops: how to shorten the stretches in which nothing
// happens, and what gestures that do not say otherwise get. Each is off when
// omitted.
type recordingEffectsRequest struct {
	// Idle is "speed" or "cut".
	Idle string `json:"idle"`
	// Ripple marks clicks with a ripple.
	Ripple *bool `json:"ripple"`
	// Zoom zooms toward click, drag and scroll gestures: true, a magnification, or false.
	Zoom *edit.Zoom `json:"zoom"`
}

// recordingEffects are a recording's effect defaults, validated.
type recordingEffects struct {
	idle   string
	ripple bool
	zoom   float64
}

// resolve validates the request.
func (request recordingEffectsRequest) resolve(capture wrapperRecordingCapture) (recordingEffects, error) {
	effects := recordingEffects{idle: request.Idle}
	switch request.Idle {
	case "", timeline.IdleSpeed, timeline.IdleCut:
	default:
		return effects, errors.New(`idle must be "speed" or "cut"`)
	}
	if request.Idle != "" && capture == wrapperRecordingCaptureBursts {
		return effects, errors.New("idle applies to continuous recordings; bursts recordings already skip idle time")
	}
	if request.Ripple != nil {
		effects.ripple = *request.Ripple
	}
	if request.Zoom != nil {
		level := float64(*request.Zoom)
		if level != 0 && (level < edit.MinZoomLevel || level > edit.MaxZoomLevel) {
			return effects, fmt.Errorf("zoom must be true, false, or a magnification between %g and %g", edit.MinZoomLevel, float64(edit.MaxZoomLevel))
		}
		effects.zoom = level
	}
	return effects, nil
}

func (e recordingEffects) any() bool {
	return e.idle != "" || e.ripple || e.zoom > 0
}

// timelineOptions are the defaults as the timeline records them, nil for none.
func (e recordingEffects) timelineOptions() *timeline.EditOptions {
	if !e.any() {
		return nil
	}
	return &timeline.EditOptions{Idle: e.idle, Ripple: e.ripple, Zoom: e.zoom}
}

// gesture resolves what a finished gesture gets: its own zoom and ripple, or else
// the recording's defaults. A move zooms only when it asks to, since moves are as
// often incidental (opening a hover menu) as a place to look at; only a click can
// ripple; and the default zoom is left to the gestures that have a place to look.
func (e recordingEffects) gesture(record pointerGestureRecord) (zoom float64, ripple bool) {
	switch record.Kind {
	case pointerGestureClick, pointerGestureDrag, pointerGestureScroll:
		zoom = e.zoom
	}
	if record.Zoom != nil {
		zoom = float64(*record.Zoom)
	}
	if record.Kind == pointerGestureClick {
		ripple = e.ripple
		if record.Ripple != nil {
			ripple = *record.Ripple
		}
	}
	return zoom, ripple
}

// toolCaptionRecord is a caption that came with a page-changing tool, for the
// span of the tool's call.
type toolCaptionRecord struct {
	Tool  string
	Text  string
	Start time.Time
	End   time.Time
}

// captionRuntime passes the captions of tool calls to the recordings that are
// running. Its zero value is ready to use.
type captionRuntime struct {
	mu           sync.Mutex
	observers    map[int]func(toolCaptionRecord)
	nextObserver int
}

// observe registers a callback for every captioned tool call that finishes and
// returns a function that removes it. Callbacks run on the call's goroutine and
// must not block.
func (c *captionRuntime) observe(observer func(toolCaptionRecord)) (stop func()) {
	c.mu.Lock()
	if c.observers == nil {
		c.observers = make(map[int]func(toolCaptionRecord))
	}
	c.nextObserver++
	id := c.nextObserver
	c.observers[id] = observer
	c.mu.Unlock()
	return func() {
		c.mu.Lock()
		delete(c.observers, id)
		c.mu.Unlock()
	}
}

func (c *captionRuntime) record(record toolCaptionRecord) {
	c.mu.Lock()
	observers := make([]func(toolCaptionRecord), 0, len(c.observers))
	for _, observer := range c.observers {
		observers = append(observers, observer)
	}
	c.mu.Unlock()
	for _, observer := range observers {
		observer(record)
	}
}

// validateToolCaption checks the caption of a tool call.
func validateToolCaption(caption string) error {
	if utf8.RuneCountInString(caption) > edit.MaxCaptionLength {
		return fmt.Errorf("caption must be at most %d characters", edit.MaxCaptionLength)
	}
	return nil
}

// noteToolCaption hands the caption of a tool call that succeeded to the running
// recordings, for the span of the call. A call that failed changed nothing on the
// page, so its caption would describe something that did not happen.
func (r *wrapperRuntime) noteToolCaption(call playwrightCallRequest, started time.Time, result *mcp.CallToolResult, err error) {
	if strings.TrimSpace(call.Caption) == "" || err != nil || result == nil || result.IsError {
		return
	}
	r.captions.record(toolCaptionRecord{Tool: call.Name, Text: call.Caption, Start: started, End: time.Now()})
}

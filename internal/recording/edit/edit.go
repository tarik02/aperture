// Package edit turns a recording and its timeline into an edited video with
// ffmpeg: captions burned in, a zoom toward where the pointer works, a ripple at
// clicks, and idle stretches sped up or cut out.
//
// What to apply is declared while the recording is made. Each pointer gesture
// carries its own zoom and ripple, and the recording carries the defaults and the
// idle mode; the timeline holds all of it (see timeline.Gesture, timeline.Caption
// and timeline.EditOptions). The look of the effects is fixed here.
//
// The work is split in two. Build is pure: it reads the timeline and the facts
// about the source video and produces a Plan, the ffmpeg filter chain, the
// captions script and a TimeMap from the raw video's clock to the edited one. Run
// probes the source, builds the plan and runs ffmpeg. The raw video and its
// timeline are only ever read.
//
// # Time
//
// Every time in a Plan's filters before the idle step is on the raw video's
// clock (see package timeline). Ripples and zoom are applied first, while frames
// still have their raw times, and one select and setpts pair then removes and
// speeds up the idle stretches. Captions are drawn last, on the edited video's
// clock, and so are not zoomed.
package edit

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"strconv"

	"github.com/aperture/aperture/internal/recording/timeline"
)

// The magnification a zoom argument of true stands for, and the range of the
// others.
const (
	DefaultZoomLevel = 1.6
	MinZoomLevel     = 1.1
	MaxZoomLevel     = 4
)

// MaxCaptionLength is the most characters a caption may have.
const MaxCaptionLength = 500

// The fixed look and pacing of the effects.
const (
	// zoomEaseMs is how long zooming in, out and panning take.
	zoomEaseMs = 600
	// zoomLingerMs is how long the zoom stays after the last gesture of a scene.
	zoomLingerMs = 800
	// zoomMergeGapMs is the longest pause between two zoomed gestures that still
	// shares one zoom. It is at least zoomLingerMs + 2*zoomEaseMs, so zooms never overlap.
	zoomMergeGapMs = 2000

	// rippleRadius is the ring's final radius in pixels of a 1280 pixel wide
	// frame; it scales with the frame's width.
	rippleRadius     = 48
	rippleDurationMs = 600

	// idleMinMs is the shortest idle stretch that is touched, idleKeepMs what stays
	// at normal speed at each end of it, and idleSpeed how much faster a sped up
	// stretch plays.
	idleMinMs  = 1500
	idleKeepMs = 300
	idleSpeed  = 8.0

	// captionMinMs is the shortest a caption stays on screen; longer text stays
	// longer, see readingTime.
	captionMinMs = 1200
)

// Zoom is a zoom argument: the magnification, or 0 for off. In JSON it is true
// (the default magnification), false (off), or a number from MinZoomLevel to
// MaxZoomLevel. A field of type *Zoom is nil when the argument was left out.
type Zoom float64

// UnmarshalJSON reads true, false or a magnification.
func (z *Zoom) UnmarshalJSON(data []byte) error {
	switch text := string(bytes.TrimSpace(data)); text {
	case "true":
		*z = DefaultZoomLevel
	case "false":
		*z = 0
	default:
		level, err := strconv.ParseFloat(text, 64)
		if err != nil || math.IsNaN(level) || level < MinZoomLevel || level > MaxZoomLevel {
			return fmt.Errorf("zoom must be true, false, or a magnification between %g and %g", MinZoomLevel, float64(MaxZoomLevel))
		}
		*z = Zoom(level)
	}
	return nil
}

// MarshalJSON writes what UnmarshalJSON reads.
func (z Zoom) MarshalJSON() ([]byte, error) {
	if z == 0 {
		return []byte("false"), nil
	}
	return json.Marshal(float64(z))
}

// Wanted reports whether a timeline asks for anything to be applied: a caption, a
// zoomed gesture, a rippled click, or an idle mode. It says nothing about whether
// the effects have something to act on, which only Build finds out.
func Wanted(tl *timeline.Timeline) bool {
	if tl == nil {
		return false
	}
	if tl.Recording.Edit != nil && tl.Recording.Edit.Idle != "" {
		return true
	}
	for _, caption := range tl.Captions {
		if normalizeCueText(caption.Text) != "" {
			return true
		}
	}
	for _, gesture := range tl.Gestures {
		if gesture.Zoom > 0 || gesture.Ripple {
			return true
		}
	}
	return false
}

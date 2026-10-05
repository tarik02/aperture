package recording

import (
	"strings"
	"unicode/utf8"
)

// The explicit recording tools. Each one acts on one running recording: the one named by
// RecordingID, or the only one running. Coordinates are CSS px of the recorded target's viewport.
const (
	CaptionMaxRunes            = 200
	FocusMaxZoom               = 4.0
	CaptionDurationDefaultMS   = 3000
	CaptionDurationMinMS       = 200
	CaptionDurationMaxMS       = 30000
	FocusDurationMinMS         = 200
	FocusDurationMaxMS         = 10000
	FocusOpenMaxMS             = 60000 // a focus nobody reset zooms out after this
	AttentionDurationDefaultMS = 1200
	AttentionDurationMinMS     = 300
	AttentionDurationMaxMS     = 5000
	AttentionRadiusDefault     = 40.0
	AttentionRadiusMin         = 8.0
	AttentionRadiusMax         = 300.0
	AttentionLoopsDefault      = 2
	AttentionLoopsMin          = 1
	AttentionLoopsMax          = 5
)

type Rect struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

type Point struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// Caption shows a text in the recording from now on.
type Caption struct {
	RecordingID string `json:"recordingId,omitempty" jsonschema:"Recording to caption; omit when exactly one recording is running."`
	Text        string `json:"text" jsonschema:"Caption text."`
	DurationMS  int    `json:"durationMs,omitempty" jsonschema:"How long the caption shows, in milliseconds."`
}

// Focus zooms the recording on a rect or element until it is reset, the recording stops or
// FocusOpenMaxMS passes, or for DurationMS when that is set. A recording holds one focus: a new
// one moves the view from the one before.
type Focus struct {
	RecordingID string  `json:"recordingId,omitempty" jsonschema:"Recording to zoom; omit when exactly one recording is running."`
	Rect        *Rect   `json:"rect,omitempty" jsonschema:"Area to zoom on. Pass rect or selector."`
	Selector    string  `json:"selector,omitempty" jsonschema:"CSS selector of the element to zoom on, in the top-level document. Pass rect or selector."`
	Zoom        float64 `json:"zoom" jsonschema:"Zoom factor."`
	DurationMS  int     `json:"durationMs,omitempty" jsonschema:"Zoom out after this many milliseconds; the call blocks for this long. Omit to keep the zoom until recording.reset_focus."`
}

// ResetFocus zooms the recording out of its focus.
type ResetFocus struct {
	RecordingID string `json:"recordingId,omitempty" jsonschema:"Recording to zoom out; omit when exactly one recording is running."`
}

// Attention circles the real pointer around a point or element so a viewer looks there.
type Attention struct {
	RecordingID string  `json:"recordingId,omitempty" jsonschema:"Recording to annotate; omit when exactly one recording is running."`
	Point       *Point  `json:"point,omitempty" jsonschema:"Where to draw attention. Pass point or selector."`
	Selector    string  `json:"selector,omitempty" jsonschema:"CSS selector of the element to draw attention to, in the top-level document. Pass point or selector."`
	Radius      float64 `json:"radius,omitempty" jsonschema:"Radius of the pointer's circle in px."`
	Loops       int     `json:"loops,omitempty" jsonschema:"How many times the pointer circles."`
	DurationMS  int     `json:"durationMs,omitempty" jsonschema:"How long the pointer circles, in milliseconds. The call blocks for this long."`
}

// duration fills a zero duration with its default and bounds the rest.
func duration(value *int, fallback, low, high int) error {
	if *value == 0 {
		*value = fallback
	} else if *value < low || *value > high {
		return invalidf("durationMs must be %d to %d", low, high)
	}
	return nil
}

// place checks that one of a rect and a selector names the place, not both.
func place(hasRect bool, selector string) error {
	if hasRect == (selector != "") {
		return invalidf("name the place with a rect or point, or with a selector, not both")
	}
	return nil
}

// Validate checks the caption and fills its defaults.
func (c *Caption) Validate() error {
	c.Text = strings.TrimSpace(c.Text)
	if c.Text == "" || utf8.RuneCountInString(c.Text) > CaptionMaxRunes {
		return invalidf("text must be 1 to %d characters", CaptionMaxRunes)
	}
	return duration(&c.DurationMS, CaptionDurationDefaultMS, CaptionDurationMinMS, CaptionDurationMaxMS)
}

// Validate checks the focus and fills its defaults.
func (f *Focus) Validate() error {
	if err := place(f.Rect != nil, f.Selector); err != nil {
		return err
	}
	if f.Rect != nil && (f.Rect.Width < 0 || f.Rect.Height < 0) {
		return invalidf("size must not be negative")
	}
	if f.Zoom <= 1 || f.Zoom > FocusMaxZoom {
		return invalidf("zoom must be above 1 and at most %v", FocusMaxZoom)
	}
	if f.DurationMS != 0 && (f.DurationMS < FocusDurationMinMS || f.DurationMS > FocusDurationMaxMS) {
		return invalidf("durationMs must be %d to %d", FocusDurationMinMS, FocusDurationMaxMS)
	}
	return nil
}

// Validate has nothing to check: a reset without a focus does nothing.
func (r *ResetFocus) Validate() error { return nil }

// Validate checks the attention and fills its defaults.
func (a *Attention) Validate() error {
	if err := place(a.Point != nil, a.Selector); err != nil {
		return err
	}
	if a.Radius == 0 {
		a.Radius = AttentionRadiusDefault
	}
	if a.Loops == 0 {
		a.Loops = AttentionLoopsDefault
	}
	if a.Radius < AttentionRadiusMin || a.Radius > AttentionRadiusMax || a.Loops < AttentionLoopsMin || a.Loops > AttentionLoopsMax {
		return invalidf("radius must be %v to %v and loops %d to %d", AttentionRadiusMin, AttentionRadiusMax, AttentionLoopsMin, AttentionLoopsMax)
	}
	return duration(&a.DurationMS, AttentionDurationDefaultMS, AttentionDurationMinMS, AttentionDurationMaxMS)
}

package recording

import (
	"strings"
	"unicode/utf8"
)

// The explicit recording tools. Each one acts on one running recording: the one named by
// RecordingID, or the only one running. Coordinates are CSS px of the recorded target's viewport.
const (
	CaptionMaxRunes = 200
	FocusMaxZoom    = 4.0
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
	Text        string `json:"text" jsonschema:"Caption text, 1 to 200 characters."`
	DurationMS  int    `json:"durationMs,omitempty" jsonschema:"How long the caption shows, 200 to 30000. Defaults to 3000."`
}

// Focus zooms the recording on a rect or element for a while.
type Focus struct {
	RecordingID string  `json:"recordingId,omitempty" jsonschema:"Recording to zoom; omit when exactly one recording is running."`
	Rect        *Rect   `json:"rect,omitempty" jsonschema:"Area to zoom on. Pass rect or selector."`
	Selector    string  `json:"selector,omitempty" jsonschema:"CSS selector of the element to zoom on, in the top-level document. Pass rect or selector."`
	Zoom        float64 `json:"zoom" jsonschema:"Zoom factor above 1, up to 4."`
	DurationMS  int     `json:"durationMs,omitempty" jsonschema:"How long the zoom holds, 200 to 10000. Defaults to 2000. The call blocks for this long."`
}

// Attention circles the real pointer around a point or element so a viewer looks there.
type Attention struct {
	RecordingID string  `json:"recordingId,omitempty" jsonschema:"Recording to annotate; omit when exactly one recording is running."`
	Point       *Point  `json:"point,omitempty" jsonschema:"Where to draw attention. Pass point or selector."`
	Selector    string  `json:"selector,omitempty" jsonschema:"CSS selector of the element to draw attention to, in the top-level document. Pass point or selector."`
	Radius      float64 `json:"radius,omitempty" jsonschema:"Radius of the pointer's circle in px, 8 to 300. Defaults to 40."`
	Loops       int     `json:"loops,omitempty" jsonschema:"How many times the pointer circles, 1 to 5. Defaults to 2."`
	DurationMS  int     `json:"durationMs,omitempty" jsonschema:"How long the pointer circles, 300 to 5000. Defaults to 1200. The call blocks for this long."`
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
	return duration(&c.DurationMS, 3000, 200, 30000)
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
	return duration(&f.DurationMS, 2000, 200, 10000)
}

// Validate checks the attention and fills its defaults.
func (a *Attention) Validate() error {
	if err := place(a.Point != nil, a.Selector); err != nil {
		return err
	}
	if a.Radius == 0 {
		a.Radius = 40
	}
	if a.Loops == 0 {
		a.Loops = 2
	}
	if a.Radius < 8 || a.Radius > 300 || a.Loops < 1 || a.Loops > 5 {
		return invalidf("radius must be 8 to 300 and loops 1 to 5")
	}
	return duration(&a.DurationMS, 1200, 300, 5000)
}

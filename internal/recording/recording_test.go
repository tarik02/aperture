package recording

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestConfigRules(t *testing.T) {
	t.Parallel()
	for config, wantErr := range map[string]bool{
		`{}`: false, `{"capture":"bursts"}`: false, `{"capture":"bursts","burst":{"leadMs":100}}`: false, `{"idle":"speed","ripple":true}`: false,
		`{"capture":"bursts","idle":"cut"}`: true, `{"capture":"burst"}`: true, `{"idle":"fast"}`: true, `{"burst":{"leadMs":1}}`: true,
		`{"capture":"bursts","burst":{"tailMs":5000}}`: true, `{"capture":"bursts","burst":{"leadMs":-1}}`: true, `{"capture":"bursts","burst":{"leadMs":60001}}`: true,
	} {
		var c Config
		if err := json.Unmarshal([]byte(config), &c); err != nil {
			t.Fatal(err)
		}
		if err := c.Validate(); (err != nil) != wantErr || (err != nil && !errors.Is(err, ErrInvalid)) {
			t.Errorf("%s: %v", config, err)
		}
	}
	c := Config{Capture: CaptureBursts, Burst: &Burst{LeadMS: 100}}
	if _ = c.Validate(); *c.Burst != (Burst{100, 800, 400, 3000}) {
		t.Errorf("defaults = %+v", *c.Burst)
	}
	for _, edits := range []Config{{Capture: CaptureBursts}, {Idle: IdleCut}, {Ripple: true}} {
		if !edits.Edits() {
			t.Errorf("%+v does not edit", edits)
		}
	}
	if (Config{Presentation: true}).Edits() {
		t.Error("presentation alone edits")
	}
}

func TestAnnotationRules(t *testing.T) {
	t.Parallel()
	caption := Caption{Text: "  Open the menu "}
	if err := caption.Validate(); err != nil || caption.Text != "Open the menu" || caption.DurationMS != 3000 {
		t.Fatalf("caption = %+v, %v", caption, err)
	}
	for _, bad := range []Caption{{Text: " "}, {Text: strings.Repeat("a", CaptionMaxRunes+1)}, {Text: "a", DurationMS: 199}} {
		if err := bad.Validate(); !errors.Is(err, ErrInvalid) {
			t.Errorf("caption %+v: %v", bad, err)
		}
	}
	for _, bad := range []Focus{
		{Zoom: 1, Rect: &Rect{Width: 10, Height: 10}},                  // no zoom
		{Zoom: 2, DurationMS: 10001, Rect: &Rect{Width: 1, Height: 1}}, // too long
		{Zoom: 2, Rect: &Rect{Width: 1, Height: 1}, Selector: "#a"},    // two places
		{Zoom: 2, DurationMS: 200},                                     // no place
		{Zoom: 2, Rect: &Rect{Width: -1}},                              // negative size
	} {
		if err := bad.Validate(); !errors.Is(err, ErrInvalid) {
			t.Errorf("focus %+v: %v", bad, err)
		}
	}
	// Without a duration a focus holds until it is reset.
	focus := Focus{Zoom: 2, Selector: "#a"}
	if err := focus.Validate(); err != nil || focus.DurationMS != 0 {
		t.Fatalf("focus = %+v, %v", focus, err)
	}
	attention := Attention{Point: &Point{X: 1, Y: 2}}
	if err := attention.Validate(); err != nil || attention.Radius != 40 || attention.Loops != 2 || attention.DurationMS != 1200 {
		t.Fatalf("attention = %+v, %v", attention, err)
	}
	for _, bad := range []Attention{{Point: &Point{}, Radius: 7}, {Point: &Point{}, Loops: 6}, {Selector: "#a", DurationMS: 5001}, {}} {
		if err := bad.Validate(); !errors.Is(err, ErrInvalid) {
			t.Errorf("attention %+v: %v", bad, err)
		}
	}
}

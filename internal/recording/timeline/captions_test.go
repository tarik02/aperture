package timeline

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestToolCaptionsAreMappedIntoEverySegmentTheyOverlap(t *testing.T) {
	b := twoSegments(t)
	// Within A only, across the two segments, and before the recording.
	b.AddCaption(CaptionInput{Tool: "browser_type", Text: "Type a name", Start: at(1000), End: at(1200)})
	b.AddCaption(CaptionInput{Tool: "browser_navigate", Text: "Go", Start: at(2900), End: at(3400)})
	b.AddCaption(CaptionInput{Tool: "browser_press_key", Text: "before", Start: at(0), End: at(50)})
	b.AddGesture(GestureInput{ID: 1, Kind: "click", Tool: "browser_click", Mode: "compositor", TargetID: "A", Start: at(1500), End: at(1600), Caption: "Click"})
	got, err := b.Build(BuildOptions{Recording: Recording{ID: "r"}})
	if err != nil {
		t.Fatal(err)
	}
	// A starts at wall 100 (video 0), and B at wall 3050 (video 3000, owning from
	// there): wall 3050 is where A stops owning.
	want := []Caption{
		{StartMs: 900, EndMs: 1100, Text: "Type a name", Tool: "browser_type"},
		{StartMs: 1400, EndMs: 1500, Text: "Click", Gesture: 1},
		{StartMs: 2800, EndMs: 2950, Text: "Go", Tool: "browser_navigate"},
		{StartMs: 3000, EndMs: 3350, Text: "Go", Tool: "browser_navigate"},
	}
	if !reflect.DeepEqual(got.Captions, want) {
		t.Errorf("captions\n got %+v\nwant %+v", got.Captions, want)
	}
}

func TestToolCaptionsAreBounded(t *testing.T) {
	b := NewBuilder(Limits{MaxGestures: 2})
	b.BeginSegment(SegmentInput{TargetID: "A", CaptureID: "c", Width: 100, Height: 100, Started: at(0), Clock: fixedClock(at(0), 0, ms(1000))})
	b.EndSegment(0, at(1000))
	for range 5 {
		b.AddCaption(CaptionInput{Text: "x", Start: at(100), End: at(200)})
	}
	got, err := b.Build(BuildOptions{Recording: Recording{ID: "r"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Captions) != 2 || !got.Truncated.Captions {
		t.Errorf("captions %d, truncated %+v", len(got.Captions), got.Truncated)
	}
}

func TestGesturesKeepTheirEffects(t *testing.T) {
	b := twoSegments(t)
	b.AddGesture(GestureInput{ID: 1, Kind: "click", Mode: "compositor", TargetID: "A", Start: at(600), End: at(700), Zoom: 1.6, Ripple: true})
	b.AddGesture(GestureInput{ID: 2, Kind: "drag", Mode: "compositor", TargetID: "A", Start: at(800), End: at(900)})
	got, err := b.Build(BuildOptions{Recording: Recording{ID: "r", Edit: &EditOptions{Idle: IdleCut, Zoom: 1.6}}})
	if err != nil {
		t.Fatal(err)
	}
	if got.Gestures[0].Zoom != 1.6 || !got.Gestures[0].Ripple || got.Gestures[1].Zoom != 0 || got.Gestures[1].Ripple {
		t.Errorf("gestures %+v", got.Gestures)
	}
	encoded, err := got.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	// Effects that are off leave no field; those that are on do.
	var decoded struct {
		Recording struct {
			Edit map[string]any `json:"edit"`
		} `json:"recording"`
		Gestures []map[string]any `json:"gestures"`
	}
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Gestures[0]["zoom"] != 1.6 || decoded.Gestures[0]["ripple"] != true {
		t.Errorf("first gesture %v", decoded.Gestures[0])
	}
	if _, has := decoded.Gestures[1]["zoom"]; has {
		t.Errorf("an unzoomed gesture has no zoom: %v", decoded.Gestures[1])
	}
	if _, has := decoded.Gestures[1]["ripple"]; has {
		t.Errorf("an unrippled gesture has no ripple: %v", decoded.Gestures[1])
	}
	if decoded.Recording.Edit["idle"] != "cut" || decoded.Recording.Edit["zoom"] != 1.6 {
		t.Errorf("edit options %v", decoded.Recording.Edit)
	}
	if _, has := decoded.Recording.Edit["ripple"]; has {
		t.Errorf("ripple is off: %v", decoded.Recording.Edit)
	}
	reread, err := Parse(encoded)
	if err != nil || reread.Recording.Edit == nil || reread.Recording.Edit.Idle != IdleCut {
		t.Errorf("reread %+v err %v", reread, err)
	}
}

func TestATimelineWithoutEditOptionsHasNoEditMember(t *testing.T) {
	got, err := twoSegments(t).Build(BuildOptions{Recording: Recording{ID: "r"}})
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := got.Marshal()
	if strings.Contains(string(encoded), `"edit"`) || strings.Contains(string(encoded), `"zoom"`) {
		t.Errorf("timeline %s", encoded)
	}
}

func TestEditOptionsEmpty(t *testing.T) {
	var none *EditOptions
	if !none.Empty() || !(&EditOptions{}).Empty() {
		t.Error("no options is empty")
	}
	for _, options := range []*EditOptions{{Idle: IdleSpeed}, {Ripple: true}, {Zoom: 2}} {
		if options.Empty() {
			t.Errorf("%+v is not empty", options)
		}
	}
}

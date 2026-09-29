package browser

import (
	"reflect"
	"testing"
	"time"
)

func TestAddSpanMergesCloseChanges(t *testing.T) {
	base := time.Unix(100, 0)
	var spans []timelineSpan
	for _, ms := range []int{0, 100, 350, 1000, 1100} {
		at := base.Add(time.Duration(ms) * time.Millisecond)
		spans = addSpan(spans, at, at)
	}
	want := []timelineSpan{
		{base, base.Add(350 * time.Millisecond)},
		{base.Add(1000 * time.Millisecond), base.Add(1100 * time.Millisecond)},
	}
	if !reflect.DeepEqual(spans, want) {
		t.Fatalf("spans = %v, want %v", spans, want)
	}
}

func TestTimelineBuildMapsWallTimeOntoVideo(t *testing.T) {
	t0 := time.Unix(1000, 0)
	ms := func(n int64) int64 { return t0.Add(time.Duration(n) * time.Millisecond).UnixMilli() }
	timeline := &recordingTimeline{segments: []*timelineSegment{
		{targetID: "a", width: 200, height: 200, scaleX: 2, scaleY: 2, clock: &frameClock{first: t0, last: time.Second},
			unknown: []timelineSpan{{t0.Add(200 * time.Millisecond), t0.Add(300 * time.Millisecond)}}},
		{targetID: "b", width: 100, height: 100, scaleX: 1, scaleY: 1, clock: &frameClock{first: t0.Add(2 * time.Second), last: 500 * time.Millisecond},
			spans: []timelineSpan{{t0.Add(2100 * time.Millisecond), t0.Add(2200 * time.Millisecond)}}},
	}}
	timeline.actions = []timelineAction{
		{Tool: "early", Start: ms(-500), End: ms(-100)},
		{Tool: "on_b", Start: ms(2100), End: ms(2300), Caption: "hi", OK: true},
	}
	timeline.gestures = []timelineGesture{
		{Tool: "on_a", TargetID: "a", Start: ms(100), End: ms(5000),
			Path:   [][3]float64{{float64(ms(100)), 10, 20}, {float64(ms(5000)), 500, 20}},
			Clicks: []timelineClick{{T: ms(100), X: 10, Y: 20}},
			Scroll: &timelineScroll{T: ms(100), X: 10, Y: 20}},
		{Tool: "fallback", TargetID: "b", Fallback: true, Start: ms(2100), End: ms(2200),
			Path: [][3]float64{{float64(ms(2100)), 5, 5}}, Clicks: []timelineClick{{T: ms(2100)}}, Scroll: &timelineScroll{}},
		{Tool: "elsewhere", TargetID: "c", Start: ms(2100)},
	}

	doc := timeline.build("rec", "v.webm")

	if doc.DurationMS != 1500 {
		t.Fatalf("duration = %d, want 1500", doc.DurationMS)
	}
	if want := []timelineSegmentOut{{"a", 0, 1000, 200, 200}, {"b", 1000, 1500, 100, 100}}; !reflect.DeepEqual(doc.Segments, want) {
		t.Fatalf("segments = %v", doc.Segments)
	}
	if len(doc.Actions) != 1 || doc.Actions[0].Start != 1100 || doc.Actions[0].End != 1300 {
		t.Fatalf("actions = %v", doc.Actions)
	}
	if want := []timelineSpanOut{{1100, 1200}}; !reflect.DeepEqual(doc.Activity, want) {
		t.Fatalf("activity = %v", doc.Activity)
	}
	if want := []timelineSpanOut{{200, 300}}; !reflect.DeepEqual(doc.Unknown, want) {
		t.Fatalf("unknown = %v", doc.Unknown)
	}
	if len(doc.Gestures) != 2 {
		t.Fatalf("gestures = %v", doc.Gestures)
	}
	// Scaled by 2 into video pixels; the end of the gesture clamps to its segment.
	on := doc.Gestures[0]
	if on.Start != 100 || on.End != 1000 || on.Path[0] != [3]float64{100, 20, 40} || on.Path[1] != [3]float64{1000, 199, 40} ||
		on.Clicks[0].X != 20 || on.Scroll == nil || on.Scroll.T != 100 || on.Scroll.Y != 40 {
		t.Fatalf("gesture = %+v", on)
	}
	// Viewport CSS pixels are not surface pixels, so a fallback gesture keeps only timing.
	fb := doc.Gestures[1]
	if fb.Start != 1100 || len(fb.Path) != 0 || len(fb.Clicks) != 0 || fb.Scroll != nil {
		t.Fatalf("fallback gesture = %+v", fb)
	}
}

func TestRecordTimelineRoutesToRunningRecordings(t *testing.T) {
	running := &recordingTimeline{segments: []*timelineSegment{{clock: &frameClock{}}}}
	stopped := &recordingTimeline{segments: []*timelineSegment{{clock: &frameClock{}}}}
	session := &liveSession{runtime: &wrapperRuntime{}, recordings: map[string]*wrapperRecording{
		"a": {Status: wrapperRecordingRunning, timeline: running},
		"b": {Status: wrapperRecordingStopped, timeline: stopped},
	}}

	session.recordTimeline(map[string]any{"action": map[string]any{"tool": "browser_click", "caption": "go"}})

	if len(running.actions) != 1 || running.actions[0].Caption != "go" || len(stopped.actions) != 0 {
		t.Fatalf("running %v, stopped %v", running.actions, stopped.actions)
	}
}

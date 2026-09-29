package edit

import (
	"errors"
	"strings"
	"testing"

	"github.com/aperture/aperture/internal/recording/timeline"
)

func planTimeline() *timeline.Timeline {
	return &timeline.Timeline{
		Version: timeline.Version,
		Recording: timeline.Recording{
			FPS: 30, Width: 1280, Height: 720, DurationMs: 30000,
		},
		Segments: []timeline.Segment{{Index: 0, Width: 1280, Height: 720, EndMs: 30000}},
		Activity: timeline.Activity{Available: true, MergeGapMs: 250, Spans: []timeline.Span{{StartMs: 0, EndMs: 30000}}},
	}
}

func build(t *testing.T, tl *timeline.Timeline) *Plan {
	t.Helper()
	plan, err := Build(tl, Source{Width: 1280, Height: 720, DurationMs: tl.Recording.DurationMs})
	if err != nil {
		t.Fatal(err)
	}
	return plan
}

func TestBuildWithNothingToApplyIsTrivial(t *testing.T) {
	plan := build(t, planTimeline())
	if !plan.Trivial() || plan.Filter != "" || plan.ASS != nil || plan.OutDurationMs != 30000 {
		t.Errorf("plan %+v", plan)
	}
}

func TestBuildIdleOnAVideoWithoutIdleStaysTrivialAndSaysWhy(t *testing.T) {
	tl := planTimeline()
	tl.Recording.Edit = &timeline.EditOptions{Idle: timeline.IdleSpeed}
	plan := build(t, tl)
	if !plan.Trivial() || len(plan.Warnings) == 0 || !strings.Contains(plan.Warnings[0], "idle was left") {
		t.Errorf("plan %+v", plan)
	}
}

func TestBuildAppliesEveryEffectInOrder(t *testing.T) {
	tl := planTimeline()
	tl.Recording.Edit = &timeline.EditOptions{Idle: timeline.IdleCut}
	tl.Activity.Spans = []timeline.Span{{StartMs: 0, EndMs: 9000}, {StartMs: 24000, EndMs: 30000}}
	tl.Gestures = []timeline.Gesture{
		clickGesture(1, 2000, 400, 300, 1.6),
		clickGesture(2, 5000, 900, 500, 2),
	}
	tl.Gestures[0].Ripple = true
	tl.Gestures[1].Ripple = true
	tl.Captions = []timeline.Caption{{StartMs: 2000, EndMs: 2400, Text: "Click it", Gesture: 1}}
	plan := build(t, tl)
	if plan.Trivial() {
		t.Fatal("plan is trivial")
	}
	if plan.Report.Ripples != 2 || plan.Report.Zooms != 2 || plan.Report.Captions != 1 || plan.Report.IdleRegions != 1 {
		t.Errorf("report %+v", plan.Report)
	}
	// Normalise, draw effects on raw time, remap idle, then burn captions.
	order := []string{"setpts=PTS-STARTPTS,fps=fps=30:start_time=0,format=yuv420p", "geq=", "geq=", "perspective=", "perspective=", "select='", "setpts='", "fps=fps=30,ass=captions.ass"}
	position := -1
	for _, part := range order {
		next := strings.Index(plan.Filter[position+1:], part)
		if next < 0 {
			t.Fatalf("filter lacks %q after position %d: %s", part, position, plan.Filter)
		}
		position += 1 + next
	}
	if plan.ASS == nil || !strings.Contains(string(plan.ASS), "Click it") {
		t.Errorf("captions script %s", plan.ASS)
	}
	if plan.OutDurationMs >= 30000 || plan.OutDurationMs != plan.TimeMap.OutDuration() {
		t.Errorf("the cut shortens the video: %d", plan.OutDurationMs)
	}
	// The caption is on the edited clock, and the cut happens after it.
	if len(plan.Cues) != 1 || plan.Cues[0].StartMs != 2000 {
		t.Errorf("cues %+v", plan.Cues)
	}
}

func TestBuildWithoutIdleHasNoRemap(t *testing.T) {
	tl := planTimeline()
	tl.Gestures = []timeline.Gesture{clickGesture(1, 2000, 400, 300, 0)}
	tl.Gestures[0].Ripple = true
	plan := build(t, tl)
	if strings.Contains(plan.Filter, "select=") || strings.Contains(plan.Filter, "ass=") || strings.Contains(plan.Filter, "perspective=") {
		t.Errorf("filter %s", plan.Filter)
	}
	if !strings.Contains(plan.Filter, "geq=") || plan.OutDurationMs != 30000 {
		t.Errorf("filter %s, duration %d", plan.Filter, plan.OutDurationMs)
	}
}

func TestBuildRefusesFramesOfDifferentSizes(t *testing.T) {
	tl := planTimeline()
	tl.Segments = append(tl.Segments, timeline.Segment{Index: 1, Width: 1024, Height: 600})
	tl.Gestures = []timeline.Gesture{clickGesture(1, 2000, 400, 300, 2)}
	_, err := Build(tl, Source{Width: 1280, Height: 720})
	var failure *Error
	if !errors.As(err, &failure) || failure.Code != CodeMixedSizes {
		t.Fatalf("error %v", err)
	}
}

func TestBuildScalesGestureCoordinatesToTheSource(t *testing.T) {
	tl := planTimeline()
	tl.Segments[0].Width, tl.Segments[0].Height = 640, 360
	tl.Gestures = []timeline.Gesture{clickGesture(1, 2000, 200, 150, 0)}
	tl.Gestures[0].Ripple = true
	plan := build(t, tl)
	// The point (200,150) of a 640x360 frame is (400,300) of the 1280x720 source.
	if !strings.Contains(plan.Filter, "X-400.0") || !strings.Contains(plan.Filter, "Y-300.0") {
		t.Errorf("filter %s", plan.Filter)
	}
}

func TestBuildWarnsAboutGesturesWithoutAPosition(t *testing.T) {
	tl := planTimeline()
	tl.Gestures = []timeline.Gesture{
		{ID: 1, Kind: "click", Mode: "cdp", StartMs: 1000, EndMs: 1100, Zoom: 2, Ripple: true},
		{ID: 2, Kind: "click", Mode: "cdp", StartMs: 3000, EndMs: 3100, Zoom: 2, Ripple: true},
	}
	plan := build(t, tl)
	if !plan.Trivial() {
		t.Errorf("nothing can be applied: %+v", plan.Report)
	}
	if len(plan.Warnings) != 2 || !strings.Contains(plan.Warnings[0], "clicks made through Playwright input") || !strings.Contains(plan.Warnings[1], "zoomed gestures made through Playwright input") {
		t.Errorf("warnings %v", plan.Warnings)
	}
}

func TestBuildKeepsTheFilterWithinTheLimitAndSaysWhatItLeftOut(t *testing.T) {
	tl := planTimeline()
	tl.Recording.DurationMs = 2_000_000
	tl.Segments[0].EndMs = 2_000_000
	for index := range maxRipples + 20 {
		gesture := clickGesture(uint64(index+1), int64(index)*5000+1000, float64(100+index), 300, 0)
		gesture.Ripple = true
		if index < maxZoomScenes+5 {
			gesture.Zoom = 1.6
		}
		tl.Gestures = append(tl.Gestures, gesture)
	}
	plan, err := Build(tl, Source{Width: 1280, Height: 720, DurationMs: 2_000_000})
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Filter) > maxFilterBytes {
		t.Errorf("filter of %d bytes", len(plan.Filter))
	}
	if plan.Report.Zooms > maxZoomScenes || plan.Report.Ripples > maxRipples {
		t.Errorf("report %+v", plan.Report)
	}
	// The zooms come first; whatever room they leave goes to the ripples.
	if plan.Report.Zooms == 0 || plan.Report.Ripples == 0 || plan.Report.Ripples >= maxRipples+20 {
		t.Errorf("report %+v", plan.Report)
	}
	if len(plan.Warnings) == 0 {
		t.Error("what did not fit must be reported")
	}
}

func TestBuildAppliesTheLimitsOnTheNumberOfEffects(t *testing.T) {
	tl := planTimeline()
	tl.Recording.DurationMs = 2_000_000
	tl.Segments[0].EndMs = 2_000_000
	for index := range maxRipples + 20 {
		gesture := clickGesture(uint64(index+1), int64(index)*5000+1000, 400, 300, 0)
		gesture.Ripple = true
		tl.Gestures = append(tl.Gestures, gesture)
	}
	plan, err := Build(tl, Source{Width: 1280, Height: 720, DurationMs: 2_000_000})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Report.Ripples > maxRipples || plan.Report.Ripples < 100 {
		t.Errorf("report %+v", plan.Report)
	}
}

func TestBuildUsesTheRecordingFrameRateUpToSixty(t *testing.T) {
	for _, test := range []struct{ fps, want int }{{0, 30}, {24, 24}, {60, 60}, {120, 60}} {
		tl := planTimeline()
		tl.Recording.FPS = test.fps
		tl.Captions = []timeline.Caption{{StartMs: 1000, EndMs: 2000, Text: "x"}}
		if plan := build(t, tl); plan.FPS != test.want {
			t.Errorf("fps %d gives %d, want %d", test.fps, plan.FPS, test.want)
		}
	}
}

func TestBuildFallsBackToTheTimelineForSizeAndLength(t *testing.T) {
	tl := planTimeline()
	tl.Captions = []timeline.Caption{{StartMs: 1000, EndMs: 2000, Text: "x"}}
	plan, err := Build(tl, Source{})
	if err != nil || plan.Width != 1280 || plan.Height != 720 || plan.InDurationMs != 30000 {
		t.Errorf("plan %+v err %v", plan, err)
	}
}

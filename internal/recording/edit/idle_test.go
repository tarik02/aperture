package edit

import (
	"testing"

	"github.com/aperture/aperture/internal/recording/timeline"
)

func TestMergeIntervals(t *testing.T) {
	got := mergeIntervals([]interval{{500, 900}, {-50, 100}, {100, 300}, {950, 2000}, {2500, 9000}}, 5000)
	want := []interval{{0, 300}, {500, 900}, {950, 2000}, {2500, 5000}}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Errorf("got %v, want %v", got, want)
		}
	}
	if got := mergeIntervals([]interval{{6000, 7000}}, 5000); len(got) != 0 {
		t.Errorf("an interval past the end is dropped, got %v", got)
	}
}

func TestPlanIdleLeavesShortGapsAlone(t *testing.T) {
	// The gap between the two busy intervals is 1.5 s, less than min + 2*keep.
	busy := []interval{{0, 1000}, {2500, 4000}}
	plan, warnings := planIdle(timeline.IdleCut, busy, 4000, 30)
	if plan.Regions != 0 || plan.Map.OutDuration() != 4000 {
		t.Errorf("plan %+v", plan)
	}
	_ = warnings
}

func TestPlanIdleCutKeepsThePadsOnBothSides(t *testing.T) {
	busy := []interval{{0, 1000}, {11000, 12000}}
	plan, _ := planIdle(timeline.IdleCut, busy, 12000, 30)
	if plan.Regions != 1 {
		t.Fatalf("regions %d", plan.Regions)
	}
	// The 10 s gap keeps 300 ms next to each busy side, and loses the middle.
	if got := plan.Map.OutDuration(); got < 2000+600-70 || got > 2000+600+70 {
		t.Errorf("duration %d, want about 2600", got)
	}
	if plan.CutMs < 9300 || plan.CutMs > 9500 {
		t.Errorf("cut %d ms", plan.CutMs)
	}
	// What is kept next to the busy parts maps one to one.
	if got := plan.Map.Map(1200); got != 1200 {
		t.Errorf("the pad after the first busy part stays at normal speed, Map(1200) = %d", got)
	}
	// The 300 ms before the second busy part (from 10700) follow the 300 ms
	// after the first, so 10800 is 100 ms into them.
	if got := plan.Map.Map(10800); got < 1400-70 || got > 1400+70 {
		t.Errorf("the pad before the second busy part is kept whole, Map(10800) = %d", got)
	}
}

func TestPlanIdleSpeedPlaysTheMiddleFaster(t *testing.T) {
	busy := []interval{{0, 1000}, {21000, 22000}}
	plan, _ := planIdle(timeline.IdleSpeed, busy, 22000, 30)
	if plan.Regions != 1 {
		t.Fatalf("regions %d", plan.Regions)
	}
	var fast []Piece
	for _, piece := range plan.Map.Pieces {
		if piece.Speed > 1 {
			fast = append(fast, piece)
		}
	}
	if len(fast) != 1 || fast[0].Speed < 7.5 || fast[0].Speed > 8.5 {
		t.Fatalf("pieces %+v", plan.Map.Pieces)
	}
	// 20 s gap: 300 ms + 19.4 s / 8 + 300 ms is kept.
	if got := plan.Map.OutDuration(); got > 1000+300+2500+300+1000+100 || got < 1000+300+2300+300+1000-100 {
		t.Errorf("duration %d", got)
	}
	if plan.CutMs != 0 || plan.SavedMs < 16000 {
		t.Errorf("cut %d saved %d", plan.CutMs, plan.SavedMs)
	}
}

func TestPlanIdleHeadAndTailOnlyKeepTheBusySidePad(t *testing.T) {
	// 6 s of nothing before the first busy part and after the last one.
	busy := []interval{{6000, 7000}}
	plan, _ := planIdle(timeline.IdleCut, busy, 13000, 30)
	if plan.Regions != 2 {
		t.Fatalf("regions %d, want head and tail", plan.Regions)
	}
	// Head: 300 ms kept before the busy part; tail: 300 ms after it.
	if got := plan.Map.OutDuration(); got < 300+1000+300-70 || got > 300+1000+300+70 {
		t.Errorf("duration %d, want about 1600", got)
	}
	last := plan.Map.Pieces[len(plan.Map.Pieces)-1]
	if last.SrcEnd < 7250 || last.SrcEnd > 7350 {
		t.Errorf("the video ends 300 ms after the last busy part, got %d", last.SrcEnd)
	}
	if plan.Map.Pieces[0].SrcStart < 5500 {
		t.Errorf("the head is cut, got start %d", plan.Map.Pieces[0].SrcStart)
	}
}

func TestPlanIdleAllBusyOrNoBusy(t *testing.T) {
	plan, _ := planIdle(timeline.IdleCut, []interval{{0, 8000}}, 8000, 30)
	if plan.Regions != 0 || plan.Map.OutDuration() != 8000 {
		t.Errorf("all busy: %+v", plan)
	}
	plan, warnings := planIdle(timeline.IdleCut, nil, 8000, 30)
	if plan.Regions != 0 || len(warnings) == 0 {
		t.Errorf("no busy interval at all leaves the video alone and says so: %+v %v", plan, warnings)
	}
}

func TestPlanIdleCutsLandOnFrames(t *testing.T) {
	busy := []interval{{0, 1013}, {9987, 12000}}
	plan, _ := planIdle(timeline.IdleCut, busy, 12000, 30)
	for _, piece := range plan.Map.Pieces {
		for _, ms := range []int64{piece.SrcStart, piece.SrcEnd} {
			if ms == 12000 || ms == 0 {
				continue
			}
			frame := float64(ms) * 30 / 1000
			if frame-float64(int64(frame+0.5)) > 0.02 || float64(int64(frame+0.5))-frame > 0.02 {
				t.Errorf("piece boundary %d ms is not on a frame of a 30 fps video", ms)
			}
		}
	}
}

func TestPlanIdleLimitsThePiecesByKeepingTheLongestRegions(t *testing.T) {
	// 100 gaps of 3 s, and one of 60 s, between one second busy parts.
	var busy []interval
	at := int64(0)
	for range 100 {
		busy = append(busy, interval{at, at + 1000})
		at += 4000
	}
	busy = append(busy, interval{at, at + 1000})
	at += 61000
	busy = append(busy, interval{at, at + 1000})
	plan, warnings := planIdle(timeline.IdleSpeed, busy, at+1000, 30)
	if len(plan.Map.Pieces) > maxKeptPieces {
		t.Errorf("%d pieces, the limit is %d", len(plan.Map.Pieces), maxKeptPieces)
	}
	if len(warnings) == 0 {
		t.Error("dropping regions must be reported")
	}
	longest := false
	for _, piece := range plan.Map.Pieces {
		if piece.SrcEnd-piece.SrcStart > 50000 && piece.Speed > 1 {
			longest = true
		}
	}
	if !longest {
		t.Error("the longest idle region is the one to keep")
	}
}

func idleTimeline() *timeline.Timeline {
	return &timeline.Timeline{
		Recording: timeline.Recording{FPS: 30, DurationMs: 20000, Edit: &timeline.EditOptions{Idle: timeline.IdleCut}},
		Segments:  []timeline.Segment{{Width: 1280, Height: 720, EndMs: 20000}},
		Activity:  timeline.Activity{Available: true, MergeGapMs: 250, Spans: []timeline.Span{}},
	}
}

func TestBusyIntervalsAreTheUnionOfWhatKeepsTheVideoBusy(t *testing.T) {
	tl := idleTimeline()
	tl.Activity.Spans = []timeline.Span{{StartMs: 1000, EndMs: 1500}}
	tl.Activity.Unknown = []timeline.Span{{StartMs: 5000, EndMs: 6000}}
	tl.Gestures = []timeline.Gesture{{StartMs: 8000, EndMs: 8200, HoldMs: 300}}
	cues := []Cue{{StartMs: 10000, EndMs: 11500, Text: "x"}}
	ripples := []ripple{{tMs: 13000}}
	scenes := []zoomScene{{StartMs: 15000, EndMs: 17000}}
	busy, known := busyIntervals(tl, cues, ripples, scenes)
	if !known {
		t.Fatal("activity is available")
	}
	merged := mergeIntervals(busy, 20000)
	want := []interval{
		{875, 1625},    // activity, padded by half the merge gap
		{5000, 6000},   // unknown: missing activity means nothing there
		{7900, 8600},   // gesture, padded, with its hold
		{10000, 11500}, // caption
		{13000, 13600}, // ripple
		{15000, 17000}, // zoom scene
	}
	if len(merged) != len(want) {
		t.Fatalf("busy %v, want %v", merged, want)
	}
	for index := range want {
		if merged[index] != want[index] {
			t.Errorf("busy %v, want %v", merged, want)
			break
		}
	}
}

func TestBusyIntervalsAreUnknownWithoutActivity(t *testing.T) {
	tl := idleTimeline()
	tl.Activity.Available = false
	if _, known := busyIntervals(tl, nil, nil, nil); known {
		t.Error("nothing is known about the screen when it could not be watched")
	}
}

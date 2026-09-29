package timeline

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

var epoch = time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)

func at(ms int) time.Time { return epoch.Add(time.Duration(ms) * time.Millisecond) }

func ms(n int) time.Duration { return time.Duration(n) * time.Millisecond }

func fixedClock(first time.Time, pts, duration time.Duration) func() (Clock, bool) {
	return func() (Clock, bool) { return Clock{FirstFrame: first, FirstPTS: pts, Duration: duration}, true }
}

func TestPathFor(t *testing.T) {
	for video, want := range map[string]string{
		"recordings/recording-1.webm":     "recordings/recording-1.webm.timeline.json",
		"recordings/demo/clip.final.mkv":  "recordings/demo/clip.final.mkv.timeline.json",
		"/session/files/recordings/a.mkv": "/session/files/recordings/a.mkv.timeline.json",
		"recordings/noext":                "recordings/noext.timeline.json",
		"recordings/demo-1.webm":          "recordings/demo-1.webm.timeline.json",
	} {
		if got := PathFor(video); got != want {
			t.Errorf("PathFor(%q) = %q, want %q", video, got, want)
		}
	}
}

// twoSegments returns a builder that recorded target A for a while, then target B.
//
//	A: first frame at wall 100, 3000 ms long, so it ends at wall 3100.
//	B: first frame at wall 3050 (it overlaps A by 50 ms), 2000 ms long.
//
// Joined, A covers video time 0..3000 and B 3000..5000.
func twoSegments(t *testing.T) *Builder {
	t.Helper()
	b := NewBuilder(Limits{})
	b.BeginSegment(SegmentInput{TargetID: "A", CaptureID: "capA", Width: 1280, Height: 720, ScaleX: 1, ScaleY: 1, Started: at(0),
		Clock: fixedClock(at(100), ms(40), ms(3000))})
	b.EndSegment(0, at(3100))
	b.BeginSegment(SegmentInput{TargetID: "B", CaptureID: "capB", Width: 1920, Height: 1080, ScaleX: 1.5, ScaleY: 1.5, Started: at(2900),
		Clock: fixedClock(at(3050), ms(35), ms(2000))})
	b.EndSegment(1, at(5050))
	return b
}

func TestMappingAcrossSegments(t *testing.T) {
	b := twoSegments(t)
	b.AddGesture(GestureInput{ID: 1, Kind: "click", Tool: "browser_click", Mode: "compositor", TargetID: "A",
		Start: at(600), End: at(1100), Hold: ms(500), Caption: "Click Save",
		Path:   []PathInput{{Offset: 0, X: 10, Y: 10}, {Offset: ms(500), X: 100, Y: 50}},
		Clicks: []ClickInput{{At: at(1000), X: 100, Y: 50, Button: "left", Count: 1}}})
	b.AddGesture(GestureInput{ID: 2, Kind: "click", Mode: "compositor", TargetID: "B",
		Start: at(4000), End: at(4200), Clicks: []ClickInput{{At: at(4100), X: 200, Y: 100, Button: "left", Count: 1}}})
	// On a target that is not recorded, and one from before the recording.
	b.AddGesture(GestureInput{ID: 3, Kind: "move", TargetID: "C", Start: at(1500), End: at(1600)})
	b.AddGesture(GestureInput{ID: 4, Kind: "move", TargetID: "A", Start: at(10), End: at(50)})
	got, err := b.Build(BuildOptions{Recording: Recording{ID: "r"}})
	if err != nil {
		t.Fatal(err)
	}
	if got.Recording.ContainerStartMs != 0 || got.Recording.DurationMs != 5000 {
		t.Fatalf("container start %d duration %d, want 0 and 5000", got.Recording.ContainerStartMs, got.Recording.DurationMs)
	}
	if got.Segments[0].StartMs != 0 || got.Segments[0].EndMs != 3000 || got.Segments[1].StartMs != 3000 || got.Segments[1].EndMs != 5000 {
		t.Fatalf("segments %+v", got.Segments)
	}
	if len(got.Gestures) != 2 {
		t.Fatalf("got %d gestures, want the two on recorded targets: %+v", len(got.Gestures), got.Gestures)
	}
	first, second := got.Gestures[0], got.Gestures[1]
	// Wall 600 is 500 ms after A's first frame.
	if first.ID != 1 || first.Segment != 0 || first.StartMs != 500 || first.EndMs != 1000 || first.HoldMs != 500 || first.Clipped {
		t.Errorf("first gesture %+v", first)
	}
	if want := []PathPoint{{TMs: 500, X: 10, Y: 10}, {TMs: 1000, X: 100, Y: 50}}; !reflect.DeepEqual(first.Path, want) {
		t.Errorf("path %+v, want %+v", first.Path, want)
	}
	if want := []Click{{TMs: 900, X: 100, Y: 50, Button: "left", Count: 1}}; !reflect.DeepEqual(first.Clicks, want) {
		t.Errorf("clicks %+v, want %+v", first.Clicks, want)
	}
	// Wall 4000 is 950 ms after B's first frame, which sits at video time 3000;
	// coordinates are scaled by 1.5 to the frame.
	if second.ID != 2 || second.Segment != 1 || second.StartMs != 3950 || second.EndMs != 4150 {
		t.Errorf("second gesture %+v", second)
	}
	if want := []Click{{TMs: 4050, X: 300, Y: 150, Button: "left", Count: 1}}; !reflect.DeepEqual(second.Clicks, want) {
		t.Errorf("clicks %+v, want %+v", second.Clicks, want)
	}
	if want := []Caption{{StartMs: 500, EndMs: 1500, Text: "Click Save", Gesture: 1}}; !reflect.DeepEqual(got.Captions, want) {
		t.Errorf("captions %+v, want %+v", got.Captions, want)
	}
	if err := got.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestOverlapBelongsToNewerSegment(t *testing.T) {
	b := twoSegments(t)
	// Wall 3070 is inside A's frames (until 3100) and B's (from 3050); B owns it.
	b.AddGesture(GestureInput{ID: 1, Kind: "click", TargetID: "B", Start: at(3070), End: at(3080)})
	b.AddGesture(GestureInput{ID: 2, Kind: "click", TargetID: "A", Start: at(3070), End: at(3080)})
	got, err := b.Build(BuildOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Gestures) != 1 || got.Gestures[0].ID != 1 || got.Gestures[0].StartMs != 3020 {
		t.Fatalf("gestures %+v", got.Gestures)
	}
}

func TestGestureIsClippedToSegment(t *testing.T) {
	b := twoSegments(t)
	// Began 50 ms before the recording's first frame and ends after B takes over
	// while still on A: it is cut at B's first frame.
	b.AddGesture(GestureInput{ID: 1, Kind: "drag", TargetID: "A", Start: at(50), End: at(3200), Hold: ms(100),
		Path: []PathInput{{Offset: 0, X: 0, Y: 0}, {Offset: ms(3150), X: 315, Y: 0}}})
	got, err := b.Build(BuildOptions{})
	if err != nil {
		t.Fatal(err)
	}
	g := got.Gestures[0]
	if !g.Clipped || g.StartMs != 0 || g.EndMs != 2950 || g.HoldMs != 0 {
		t.Fatalf("gesture %+v", g)
	}
	// The path runs straight from wall 50 to 3200, so it is cut where the segment
	// starts (wall 100, 50 ms in: x=5) and where B takes over (wall 3050: x=300).
	if want := []PathPoint{{TMs: 0, X: 5, Y: 0}, {TMs: 2950, X: 300, Y: 0}}; !reflect.DeepEqual(g.Path, want) {
		t.Fatalf("path %+v, want %+v", g.Path, want)
	}
}

func TestSingleSegmentReportsItsContainerStart(t *testing.T) {
	b := NewBuilder(Limits{})
	b.BeginSegment(SegmentInput{TargetID: "A", CaptureID: "c", Width: 100, Height: 100, Started: at(0), Clock: fixedClock(at(100), ms(39), ms(1000))})
	b.EndSegment(0, at(1100))
	b.AddGesture(GestureInput{ID: 1, Kind: "click", TargetID: "A", Start: at(600), End: at(700)})
	got, err := b.Build(BuildOptions{})
	if err != nil {
		t.Fatal(err)
	}
	// The file's first frame is at 39 ms in its container but is time 0 of the video.
	if got.Recording.ContainerStartMs != 39 || got.Recording.DurationMs != 1000 || got.Segments[0].StartMs != 0 {
		t.Fatalf("recording %+v segments %+v", got.Recording, got.Segments)
	}
	if g := got.Gestures[0]; g.StartMs != 500 || g.EndMs != 600 {
		t.Fatalf("gesture %+v", g)
	}
}

func TestEstimatedClockFallsBackToStartAndEnd(t *testing.T) {
	b := NewBuilder(Limits{})
	b.BeginSegment(SegmentInput{TargetID: "A", CaptureID: "c", Width: 100, Height: 100, Started: at(100)})
	b.EndSegment(0, at(2100))
	got, err := b.Build(BuildOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if got.Segments[0].Clock != ClockEstimated || got.Recording.DurationMs != 2000 || got.Recording.ContainerStartMs != 0 {
		t.Fatalf("recording %+v segments %+v", got.Recording, got.Segments)
	}
}

func TestSelectedSegmentsOfSalvagedRecording(t *testing.T) {
	b := twoSegments(t)
	b.AddGesture(GestureInput{ID: 1, Kind: "click", TargetID: "B", Start: at(4000), End: at(4100)})
	got, err := b.Build(BuildOptions{Segments: []int{1}, Recording: Recording{Salvaged: true}})
	if err != nil {
		t.Fatal(err)
	}
	// A lone segment is not re-timed in its file, which starts at its own first timestamp.
	if len(got.Segments) != 1 || got.Recording.ContainerStartMs != 35 || got.Recording.DurationMs != 2000 || got.Gestures[0].StartMs != 950 {
		t.Fatalf("%+v %+v %+v", got.Recording, got.Segments, got.Gestures)
	}
}

func TestActivitySpansMergeAndMap(t *testing.T) {
	b := twoSegments(t)
	b.NoteSample()
	for _, change := range []int{200, 250, 300, 340, 800, 1500, 1520} {
		b.AddChange("capA", at(change))
	}
	// 3060 is in the overlap that B owns, so A's change there is dropped; B's counts.
	b.AddChange("capA", at(3060))
	b.AddChange("capB", at(3060))
	b.AddChange("capB", at(3200))
	// Before A's first frame.
	b.AddChange("capA", at(50))
	b.AddUnknown("capA", at(2000), at(2400))
	got, err := b.Build(BuildOptions{})
	if err != nil {
		t.Fatal(err)
	}
	want := []Span{
		{StartMs: 100, EndMs: 240},   // wall 200..340
		{StartMs: 700, EndMs: 700},   // 800 stands alone: 340 -> 800 is a 460 ms pause
		{StartMs: 1400, EndMs: 1420}, // 1500, 1520
		{StartMs: 3010, EndMs: 3010}, // B at wall 3060 is 10 ms after B's first frame? see below
		{StartMs: 3150, EndMs: 3150},
	}
	// B's first frame is wall 3050, so wall 3060 is video 3010, and 3200 is 3150; 3010 -> 3150 is a 140 ms pause, which merges.
	want = append(want[:3:3], Span{StartMs: 3010, EndMs: 3150})
	if !reflect.DeepEqual(got.Activity.Spans, want) {
		t.Errorf("spans %+v, want %+v", got.Activity.Spans, want)
	}
	if !got.Activity.Available || got.Activity.MergeGapMs != 250 || got.Activity.SampleIntervalMs != 50 {
		t.Errorf("activity %+v", got.Activity)
	}
	if want := []Span{{StartMs: 1900, EndMs: 2300}}; !reflect.DeepEqual(got.Activity.Unknown, want) {
		t.Errorf("unknown %+v, want %+v", got.Activity.Unknown, want)
	}
	if err := got.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestActivityUnavailableWithoutSamples(t *testing.T) {
	got, err := twoSegments(t).Build(BuildOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if got.Activity.Available || got.Activity.Spans == nil || len(got.Activity.Spans) != 0 {
		t.Fatalf("activity %+v", got.Activity)
	}
}

func TestLimitsBoundMemory(t *testing.T) {
	b := NewBuilder(Limits{MaxGestures: 2, MaxPathPointsTotal: 10, MaxActivitySpans: 3, MergeGap: ms(10)})
	b.BeginSegment(SegmentInput{TargetID: "A", CaptureID: "c", Width: 100, Height: 100, Started: at(0), Clock: fixedClock(at(0), 0, ms(100_000))})
	for id := range 4 {
		var path []PathInput
		for step := range 8 {
			path = append(path, PathInput{Offset: ms(step * 10), X: float64(step * 10), Y: float64(step % 2 * 20)})
		}
		b.AddGesture(GestureInput{ID: uint64(id), Kind: "move", TargetID: "A", Start: at(id * 1000), End: at(id*1000 + 80), Path: path})
	}
	for index := range 10 {
		b.AddChange("c", at(index*1000))
	}
	got, err := b.Build(BuildOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Gestures) != 2 || !got.Truncated.Gestures || !got.Truncated.PathPoints || !got.Truncated.Activity || len(got.Activity.Spans) != 3 {
		t.Fatalf("gestures %d spans %d truncated %+v", len(got.Gestures), len(got.Activity.Spans), got.Truncated)
	}
	total := 0
	for _, gesture := range got.Gestures {
		total += len(gesture.Path)
	}
	if total > 10 {
		t.Fatalf("%d path points kept, limit 10", total)
	}
}

func TestThinPath(t *testing.T) {
	var straight []PathInput
	for step := range 100 {
		straight = append(straight, PathInput{Offset: ms(step * 16), X: float64(step) * 3, Y: float64(step) * 2})
	}
	thinned, lost := thinPath(straight, 240)
	if lost || len(thinned) != 2 || thinned[0] != straight[0] || thinned[1] != straight[99] {
		t.Fatalf("a straight line at constant speed should reduce to its ends, got %d points (lost=%v)", len(thinned), lost)
	}
	// The same line crossed with easing has to keep its timing: interpolating the
	// thinned points in time stays within a pixel of every recorded position.
	var eased []PathInput
	for step := range 100 {
		progress := float64(step) / 99
		progress = progress * progress * (3 - 2*progress)
		eased = append(eased, PathInput{Offset: ms(step * 16), X: progress * 300, Y: progress * 200})
	}
	thinned, lost = thinPath(eased, 240)
	if lost || len(thinned) < 10 || len(thinned) >= len(eased) {
		t.Fatalf("an eased line should be thinned but keep its timing, got %d of %d points (lost=%v)", len(thinned), len(eased), lost)
	}
	for _, point := range eased {
		var before, after PathInput
		for _, kept := range thinned {
			if kept.Offset <= point.Offset {
				before = kept
			}
			if kept.Offset >= point.Offset {
				after = kept
				break
			}
		}
		if err := interpolationError(point, before, after); err > pathTolerance+0.01 {
			t.Fatalf("thinned path is %.2f px off at %v", err, point.Offset)
		}
	}
	var curve []PathInput
	for step := range 400 {
		curve = append(curve, PathInput{Offset: ms(step * 16), X: float64(step), Y: float64(step%2) * 10})
	}
	thinned, lost = thinPath(curve, 50)
	if !lost || len(thinned) != 50 || thinned[0] != curve[0] || thinned[49] != curve[399] {
		t.Fatalf("got %d points (lost=%v)", len(thinned), lost)
	}
}

func TestRoundTripAndAtomicWrite(t *testing.T) {
	b := twoSegments(t)
	b.NoteSample()
	b.AddChange("capA", at(500))
	b.AddGesture(GestureInput{ID: 1, Kind: "scroll", Tool: "browser_scroll", Mode: "cdp", TargetID: "A", Start: at(600), End: at(900),
		ScrollY: 300, ScrollAt: &PointInput{X: 10, Y: 20}, Caption: "Scroll down"})
	built, err := b.Build(BuildOptions{Recording: Recording{ID: "abc", Video: "recordings/recording-abc.webm", Mode: "tab", Codec: "vp8", FPS: 30, StartedAt: at(0)}})
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "recording-abc.timeline.json")
	if err := os.WriteFile(path, []byte("stale"), 0o600); err != nil {
		t.Fatal(err)
	}
	written, err := Write(path, built)
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(dir, "recording-abc.1.timeline.json"); written != want {
		t.Fatalf("written to %q, want %q beside the stale file", written, want)
	}
	if stale, _ := os.ReadFile(path); string(stale) != "stale" {
		t.Fatalf("an existing file was replaced: %q", stale)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 2 {
		t.Fatalf("temporary files left behind: %v", entries)
	}
	loaded, err := Read(written)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(built, loaded) {
		t.Fatalf("round trip changed the timeline:\n%+v\n%+v", built, loaded)
	}
	if loaded.Version != 1 || loaded.Recording.Video != "recordings/recording-abc.webm" || loaded.Gestures[0].Scroll.DY != 300 || loaded.Gestures[0].Scroll.At == nil {
		t.Fatalf("%+v", loaded)
	}
}

func TestParseRejectsOtherVersionsAndInconsistentFiles(t *testing.T) {
	if _, err := Parse([]byte(`{"version":2}`)); err == nil {
		t.Fatal("a future version must be rejected")
	}
	if _, err := Parse([]byte(`not json`)); err == nil {
		t.Fatal("garbage must be rejected")
	}
	bad := `{"version":1,"recording":{"durationMs":100},"segments":[{"index":0,"startMs":0,"endMs":100}],` +
		`"gestures":[{"id":1,"startMs":50,"endMs":500,"segment":0}],"captions":[],"activity":{"spans":[]},"truncated":{}}`
	if _, err := Parse([]byte(bad)); err == nil {
		t.Fatal("a gesture beyond the video must be rejected")
	}
}

func TestBuildWithoutSegmentsFails(t *testing.T) {
	if _, err := NewBuilder(Limits{}).Build(BuildOptions{}); err == nil {
		t.Fatal("expected an error")
	}
}

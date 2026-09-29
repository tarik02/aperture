package timeline

import (
	"reflect"
	"testing"
)

// Bursts are far apart in wall time, but the video holds them one after the other:
// a burst's times are video times, and what happened between bursts is not in it.
func TestBurstsAreMappedThroughGapsInWallTime(t *testing.T) {
	b := NewBuilder(Limits{})
	begin := func(burst uint64, first, length int) int {
		index := b.BeginSegment(SegmentInput{TargetID: "A", CaptureID: "cap", Width: 1280, Height: 720, ScaleX: 1, ScaleY: 1, Started: at(first - 100),
			Clock: fixedClock(at(first), ms(40), ms(length)), Burst: burst})
		b.EndSegment(index, at(first+length))
		return index
	}
	// Burst 1: 2000 ms from wall 1000. Burst 2: 1500 ms from wall 60000, in two
	// segments because the page was replaced during it.
	b.SetSegmentClosedBy(begin(1, 1000, 2000), "settled")
	begin(2, 60000, 700)
	b.SetSegmentClosedBy(begin(2, 60700, 800), "max_tail")

	b.AddAction(ActionInput{Tool: "browser_click", Kind: "pointer", TargetID: "A", Start: at(1400), End: at(1600), Gesture: 7})
	b.AddAction(ActionInput{Tool: "browser_resize", Kind: "change", TargetID: "A", Start: at(60100), End: at(60800)})
	// Nothing was recorded here.
	b.AddAction(ActionInput{Tool: "browser_type", Kind: "change", Start: at(30000), End: at(30100)})
	b.AddGesture(GestureInput{ID: 9, Kind: "move", TargetID: "A", Start: at(30000), End: at(30100)})

	got, err := b.Build(BuildOptions{Recording: Recording{ID: "r", Capture: "bursts"}})
	if err != nil {
		t.Fatal(err)
	}
	if err := got.Validate(); err != nil {
		t.Fatal(err)
	}
	if got.Recording.DurationMs != 3500 || len(got.Segments) != 3 || len(got.Gestures) != 0 {
		t.Fatalf("duration %d, %d segments, %d gestures", got.Recording.DurationMs, len(got.Segments), len(got.Gestures))
	}
	want := []Burst{
		{FirstSegment: 0, LastSegment: 0, StartMs: 0, EndMs: 2000, LeadMs: 400, TailMs: 1400, ClosedBy: "settled",
			Actions: []BurstAction{{Tool: "browser_click", Kind: "pointer", TargetID: "A", StartMs: 400, EndMs: 600, Gesture: 7}}},
		// The resize started 100 ms into the burst and ended 100 ms into its second segment.
		{FirstSegment: 1, LastSegment: 2, StartMs: 2000, EndMs: 3500, LeadMs: 100, TailMs: 700, ClosedBy: "max_tail",
			Actions: []BurstAction{{Tool: "browser_resize", Kind: "change", TargetID: "A", StartMs: 2100, EndMs: 2800}}},
	}
	if !reflect.DeepEqual(got.Bursts, want) {
		t.Fatalf("bursts\n got %+v\nwant %+v", got.Bursts, want)
	}
}

func TestContinuousRecordingsHaveNoBursts(t *testing.T) {
	got, err := twoSegments(t).Build(BuildOptions{Recording: Recording{ID: "r"}})
	if err != nil {
		t.Fatal(err)
	}
	if got.Bursts != nil {
		t.Fatalf("bursts %+v", got.Bursts)
	}
}

func TestBurstActionsAreLimited(t *testing.T) {
	b := NewBuilder(Limits{MaxBurstActions: 2})
	b.BeginSegment(SegmentInput{TargetID: "A", CaptureID: "cap", Width: 10, Height: 10, Started: at(0), Clock: fixedClock(at(0), 0, ms(1000)), Burst: 1})
	for range 3 {
		b.AddAction(ActionInput{Tool: "browser_type", Kind: "change", Start: at(10), End: at(20)})
	}
	got, err := b.Build(BuildOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Bursts[0].Actions) != 2 || !got.Truncated.Bursts {
		t.Fatalf("%d actions, truncated %+v", len(got.Bursts[0].Actions), got.Truncated)
	}
}

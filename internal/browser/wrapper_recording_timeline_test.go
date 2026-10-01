package browser

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestTimelineBuildMapsWallTimeOntoVideo(t *testing.T) {
	t0 := time.Unix(1000, 0)
	ms := func(n int64) int64 { return t0.Add(time.Duration(n) * time.Millisecond).UnixMilli() }
	timeline := &recordingTimeline{segments: []*timelineSegment{
		{targetID: "a", width: 200, height: 200, scaleX: 2, scaleY: 2, clock: &frameClock{first: t0, last: time.Second}},
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
		{Tool: "on_b", TargetID: "b", Start: ms(2100), End: ms(2200)},
		{Tool: "elsewhere", TargetID: "c", Start: ms(2100)},
		{Tool: "old_tab", TargetID: "a", Start: ms(2100)}, // a stopped being recorded when b took over
	}
	timeline.incomplete = true

	doc, err := timeline.build("rec", "v.webm")
	if err != nil {
		t.Fatal(err)
	}

	if doc.DurationMS != 1500 {
		t.Fatalf("duration = %d, want 1500", doc.DurationMS)
	}
	if want := []timelineSegmentOut{{"a", 0, 1000, 200, 200}, {"b", 1000, 1500, 100, 100}}; !reflect.DeepEqual(doc.Segments, want) {
		t.Fatalf("segments = %v", doc.Segments)
	}
	if len(doc.Actions) != 1 || doc.Actions[0].Start != 1100 || doc.Actions[0].End != 1300 {
		t.Fatalf("actions = %v", doc.Actions)
	}
	if want := (timelineActivity{Spans: []timelineSpanOut{{1100, 1200}}}); !reflect.DeepEqual(doc.Activity, want) {
		t.Fatalf("activity = %v", doc.Activity)
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
	if doc.Gestures[1].Tool != "on_b" || doc.Gestures[1].Start != 1100 {
		t.Fatalf("gesture = %+v", doc.Gestures[1])
	}
}

func TestTimelineBuildNeedsEverySegmentAnchored(t *testing.T) {
	timeline := &recordingTimeline{segments: []*timelineSegment{
		{clock: &frameClock{first: time.Unix(1000, 0)}}, {clock: &frameClock{}},
	}}
	if _, err := timeline.build("rec", "v.webm"); err == nil {
		t.Fatal("built a timeline with an unanchored segment")
	}
}

func TestTimelineSamplingRacesBuild(t *testing.T) {
	dir, err := os.MkdirTemp("", "tl")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.RemoveAll(dir) }()
	socket := filepath.Join(dir, "s")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = listener.Close() }()
	go func() {
		for count := 0; ; count++ {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			_, _ = bufio.NewReader(conn).ReadString('\n')
			_, _ = fmt.Fprintf(conn, "ok 0 %d\n", count)
			_ = conn.Close()
		}
	}()
	timeline := &recordingTimeline{segments: []*timelineSegment{{clock: &frameClock{first: time.Now(), last: time.Second}}}}
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(400*time.Millisecond, cancel)
	done := make(chan struct{})
	go func() { timeline.sample(ctx, socket); close(done) }()
	for ctx.Err() == nil {
		if _, err := timeline.build("rec", "v.webm"); err != nil {
			t.Fatal(err)
		}
		time.Sleep(5 * time.Millisecond)
	}
	<-done
	if doc, _ := timeline.build("rec", "v.webm"); len(doc.Activity.Spans) == 0 || !doc.Activity.Complete {
		t.Fatalf("activity = %+v", doc.Activity)
	}
}

func TestFrameClockReadsReportsSplitAcrossWrites(t *testing.T) {
	clock := &frameClock{frame: 40 * time.Millisecond}
	report := func(pts string) string {
		return "/GstPipeline:pipeline0/GstIdentity:aperture_frames: last-message = chain ******* (aperture_frames:sink) (100 bytes, dts: none, pts: " + pts + ", duration: none)\n"
	}
	first, second := report("0:00:00.100000000"), report("0:00:01.000000000")
	for _, chunk := range []string{"other output\n" + first[:30], first[30:] + second[:70], second[70:], "partial", " line"} {
		_, _ = clock.Write([]byte(chunk))
	}
	if start, length := clock.span(); start.IsZero() || length != 940*time.Millisecond {
		t.Fatalf("span = %v, %v", start, length)
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

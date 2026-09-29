package browser

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aperture/aperture/internal/pointer"
	"github.com/aperture/aperture/internal/recording/timeline"
)

func TestParseCaptureDamage(t *testing.T) {
	damage, err := parseCaptureDamage("ok 1500 42")
	if err != nil {
		t.Fatal(err)
	}
	if damage.Since != 1500*time.Millisecond || damage.Count != 42 {
		t.Fatalf("damage %+v", damage)
	}
	for _, bad := range []string{"", "ok", "ok 1", "ok x 2", "ok 1 -2", "error output not found", "ok 1 2 3"} {
		if _, err := parseCaptureDamage(bad); err == nil {
			t.Errorf("parseCaptureDamage(%q) should fail", bad)
		}
	}
}

func TestParseChainLine(t *testing.T) {
	line := "/GstPipeline:pipeline0/GstIdentity:aperture_frames: last-message = chain   ******* (aperture_frames:sink) " +
		"(3686400 bytes, dts: 0:00:00.033233797, pts: 0:00:01.033233797, duration: 0:00:00.033333333, offset: 0, offset_end: 1, flags: 00000040 discont , meta: GstVideoMeta) 0x7f3a3c004e60"
	pts, duration, ok := parseChainLine(line)
	if !ok || pts != time.Second+33233797*time.Nanosecond || duration != 33333333*time.Nanosecond {
		t.Fatalf("pts %v duration %v ok %v", pts, duration, ok)
	}
	// A frame without a duration, and one with unset times.
	noDuration := strings.Replace(line, "duration: 0:00:00.033333333", "duration: 99:99:99.999999999", 1)
	if pts, duration, ok := parseChainLine(noDuration); !ok || pts == 0 || duration != 0 {
		t.Fatalf("pts %v duration %v ok %v", pts, duration, ok)
	}
	unset := strings.Replace(line, "pts: 0:00:01.033233797", "pts: 99:99:99.999999999", 1)
	if _, _, ok := parseChainLine(unset); ok {
		t.Fatal("a frame without a timestamp carries no time")
	}
	if _, _, ok := parseChainLine("/GstPipeline:pipeline0/GstIdentity:aperture_frames: last-message = event   ******* (aperture_frames:sink) E (type: caps"); ok {
		t.Fatal("events are not frames")
	}
}

// The probe takes the smallest gap between reading a report and its timestamp,
// since a report is read after its frame, never before.
func TestScreencastProbeAnchorsOnEarliestFrame(t *testing.T) {
	epoch := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)
	probe := newScreencastProbe(30)
	if _, ok := probe.clock(); ok {
		t.Fatal("no frame has been seen")
	}
	// The pipeline's clock started at epoch+100ms. Reads lag by 5, 2 and 9 ms.
	probe.observe(epoch.Add(100*time.Millisecond+40*time.Millisecond+5*time.Millisecond), 40*time.Millisecond, 33*time.Millisecond)
	probe.observe(epoch.Add(100*time.Millisecond+80*time.Millisecond+2*time.Millisecond), 80*time.Millisecond, 33*time.Millisecond)
	probe.observe(epoch.Add(100*time.Millisecond+120*time.Millisecond+9*time.Millisecond), 120*time.Millisecond, 0)
	clock, ok := probe.clock()
	if !ok {
		t.Fatal("expected a clock")
	}
	// The first frame's timestamp is 40 ms, so its wall time is epoch+140ms, refined by the 3 ms earlier read of the second.
	if want := epoch.Add(140*time.Millisecond + 2*time.Millisecond); !clock.FirstFrame.Equal(want) {
		t.Errorf("first frame at %v, want %v", clock.FirstFrame.Sub(epoch), want.Sub(epoch))
	}
	if clock.FirstPTS != 40*time.Millisecond {
		t.Errorf("first pts %v", clock.FirstPTS)
	}
	// The last frame has no duration, so a frame at 30 fps is assumed: 120ms+33.3ms-40ms.
	if want := 120*time.Millisecond + time.Second/30 - 40*time.Millisecond; clock.Duration != want {
		t.Errorf("duration %v, want %v", clock.Duration, want)
	}
}

func TestScreencastProbeConsumesPipelineOutput(t *testing.T) {
	probe := newScreencastProbe(30)
	reader, writer := io.Pipe()
	var forwarded strings.Builder
	go probe.consume(reader, &forwarded)
	lines := []string{
		"Setting pipeline to PLAYING ...\n",
		"/GstPipeline:pipeline0/GstIdentity:aperture_frames.GstPad:src: caps = video/x-raw\n",
		"/GstPipeline:pipeline0/GstIdentity:aperture_frames: last-message = chain   ******* (aperture_frames:sink) (100 bytes, dts: 0:00:00.040000000, pts: 0:00:00.040000000, duration: 0:00:00.033333333, offset: 0)\n",
		"/GstPipeline:pipeline0/GstIdentity:aperture_frames: last-message = chain   ******* (aperture_frames:sink) (100 bytes, dts: 0:00:00.080000000, pts: 0:00:00.080000000, duration: 0:00:00.033333333, offset: 1)\n",
		"Got EOS from element \"pipeline0\".\n",
	}
	for _, line := range lines {
		if _, err := io.WriteString(writer, line); err != nil {
			t.Fatal(err)
		}
	}
	_ = writer.Close()
	probe.wait(time.Second)
	clock, ok := probe.clock()
	if !ok || clock.FirstPTS != 40*time.Millisecond || clock.Duration != 80*time.Millisecond-40*time.Millisecond+33333333*time.Nanosecond {
		t.Fatalf("clock %+v ok %v", clock, ok)
	}
	if got := forwarded.String(); got != "Setting pipeline to PLAYING ...\nGot EOS from element \"pipeline0\".\n" {
		t.Fatalf("forwarded %q", got)
	}
}

func TestTimelineSegmentScalesPageToFrame(t *testing.T) {
	target := wrapperTargetSnapshot{
		TargetID:  "t",
		CaptureID: "capture-t-g1",
		Viewport:  newCompositorViewport(1280, 720, 180),
	}
	segment := timelineSegment(target, newScreencastProbe(30), time.Time{})
	// At a device pixel ratio of 1.5 the content is 1920x1080, inside a 1920x1088 canvas.
	if segment.Width != 1920 || segment.Height != 1080 || segment.ScaleX != 1.5 || segment.ScaleY != 1.5 {
		t.Fatalf("segment %+v", segment)
	}
	odd := timelineSegment(wrapperTargetSnapshot{Viewport: newCompositorViewport(1281, 721, 120)}, newScreencastProbe(30), time.Time{})
	// Odd sizes are rounded up to even, as the pipeline crops them.
	if odd.Width != 1282 || odd.Height != 722 {
		t.Fatalf("odd segment %+v", odd)
	}
}

func TestTimelineGestureConvertsRecord(t *testing.T) {
	start := time.Now()
	input := timelineGesture(pointerGestureRecord{
		ID: 7, Kind: pointerGestureClick, Tool: "browser_click", Mode: pointerModeCompositor, TargetID: "t",
		Start: start, End: start.Add(time.Second), Hold: time.Second, Caption: "hi",
		Path:   []pointerPathPoint{{Offset: 0, X: 1, Y: 2}, {Offset: time.Second, X: 3, Y: 4}},
		Clicks: []pointerClickPoint{{At: start.Add(time.Second), X: 3, Y: 4, Button: "left", Count: 2}},
	})
	if input.ID != 7 || input.Kind != "click" || input.Mode != "compositor" || input.Caption != "hi" || len(input.Path) != 2 ||
		input.Clicks[0].Count != 2 || input.Path[1].Offset != time.Second {
		t.Fatalf("input %+v", input)
	}
	scroll := timelineGesture(pointerGestureRecord{Kind: pointerGestureScroll, Mode: pointerModeCDP, ScrollY: 200, Point: &pointer.Point{X: 5, Y: 6}})
	if scroll.ScrollAt == nil || scroll.ScrollAt.X != 5 || scroll.ScrollAt.Y != 6 || scroll.ScrollY != 200 {
		t.Fatalf("scroll %+v", scroll)
	}
}

// fakeDamage stands in for the compositor: it counts changes and reports how
// long ago the last one was.
type fakeDamage struct {
	mu     sync.Mutex
	count  uint64
	last   time.Time
	failed bool
}

func (f *fakeDamage) change(at time.Time) {
	f.mu.Lock()
	f.count++
	f.last = at
	f.mu.Unlock()
}

func (f *fakeDamage) setFailing(failing bool) {
	f.mu.Lock()
	f.failed = failing
	f.mu.Unlock()
}

func (f *fakeDamage) read(_ context.Context, _ string) (captureDamage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failed {
		return captureDamage{}, errors.New("compositor unavailable")
	}
	return captureDamage{Count: f.count, LastChange: f.last, Since: time.Since(f.last)}, nil
}

func TestSampleRecordedScreenReportsChangesAtTheirTime(t *testing.T) {
	builder := timeline.NewBuilder(timeline.Limits{MergeGap: 20 * time.Millisecond})
	started := time.Now()
	builder.BeginSegment(timeline.SegmentInput{TargetID: "t", CaptureID: "cap", Width: 100, Height: 100, ScaleX: 1, ScaleY: 1, Started: started,
		Clock: func() (timeline.Clock, bool) { return timeline.Clock{FirstFrame: started, Duration: time.Hour}, true }})
	screen := &fakeDamage{last: started}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		sampleRecordedScreen(ctx, builder, screen.read, 5*time.Millisecond)
	}()
	time.Sleep(40 * time.Millisecond)
	changeAt := time.Now()
	screen.change(changeAt)
	time.Sleep(40 * time.Millisecond)
	screen.setFailing(true)
	time.Sleep(40 * time.Millisecond)
	screen.setFailing(false)
	time.Sleep(30 * time.Millisecond)
	cancel()
	<-done
	built, err := builder.Build(timeline.BuildOptions{End: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	if !built.Activity.Available || len(built.Activity.Spans) != 1 {
		t.Fatalf("activity %+v", built.Activity)
	}
	// The span sits where the change was made, whatever sample noticed it.
	want := changeAt.Sub(started).Milliseconds()
	if span := built.Activity.Spans[0]; span.StartMs != want && span.StartMs != want+1 && span.StartMs != want-1 || span.StartMs != span.EndMs {
		t.Fatalf("span %+v, want a change at %d ms", span, want)
	}
	if len(built.Activity.Unknown) != 1 {
		t.Fatalf("unknown %+v, want the failing period", built.Activity.Unknown)
	}
	if unknown := built.Activity.Unknown[0]; unknown.EndMs-unknown.StartMs < 20 {
		t.Fatalf("unknown span too short: %+v", unknown)
	}
}

// serveControlSocket answers each compositor control command with respond(command).
func serveControlSocket(t *testing.T, respond func(command string) string) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "ap")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	path := filepath.Join(dir, "c.sock")
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer func() { _ = conn.Close() }()
				command, _ := bufio.NewReader(conn).ReadString('\n')
				_, _ = io.WriteString(conn, respond(strings.TrimSpace(command))+"\n")
			}()
		}
	}()
	return path
}

func TestReadCaptureDamageAsksTheCompositor(t *testing.T) {
	socket := serveControlSocket(t, func(command string) string {
		if command == "damage-status capture-a" {
			return "ok 2500 17"
		}
		return "error output not found"
	})
	if _, err := readCaptureDamage(context.Background(), socket, "capture-b"); err == nil {
		t.Fatal("an unknown output must be an error")
	}
	before := time.Now()
	damage, err := readCaptureDamage(context.Background(), socket, "capture-a")
	if err != nil || damage.Count != 17 {
		t.Fatalf("damage %+v err %v", damage, err)
	}
	// The change is placed 2.5 s before the sample.
	if age := before.Sub(damage.LastChange); age < 2400*time.Millisecond || age > 2600*time.Millisecond {
		t.Fatalf("last change %v before the request", age)
	}
}

func TestSalvagedSegmentsGetTimelinesOfTheirOwn(t *testing.T) {
	root := t.TempDir()
	recordings := filepath.Join(root, "recordings")
	segmentDir := filepath.Join(recordings, ".recording-x")
	if err := os.MkdirAll(segmentDir, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"segment-0000.webm", "segment-0001.webm", "segment-0002.webm"} {
		content := []byte("video")
		if name == "segment-0001.webm" {
			content = nil
		}
		if err := os.WriteFile(filepath.Join(segmentDir, name), content, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	started := time.Now().Add(-time.Minute)
	builder := timeline.NewBuilder(timeline.Limits{})
	for index := range 3 {
		first := started.Add(time.Duration(index) * 10 * time.Second)
		builder.BeginSegment(timeline.SegmentInput{TargetID: "t", CaptureID: "c", Width: 100, Height: 100, Started: first,
			Clock: func() (timeline.Clock, bool) {
				return timeline.Clock{FirstFrame: first, FirstPTS: 30 * time.Millisecond, Duration: 10 * time.Second}, true
			}})
		builder.EndSegment(index, first.Add(10*time.Second))
	}
	recording := &wrapperRecording{
		ID: "x", Mode: wrapperRecordingModeTab, Codec: "vp8", FPS: 30, StartedAt: started, filesRoot: root,
		Path:     filepath.Join(recordings, "recording-x.webm"),
		timeline: &recordingTimeline{builder: builder, stopGestures: func() {}, cancelSampler: func() {}, samplerDone: make(chan struct{}), probes: []*screencastProbe{}},
	}
	close(recording.timeline.samplerDone)
	salvaged := abandonRecordingSegments(segmentDir, recording.Path)
	if len(salvaged) != 2 || salvaged[0].index != 0 || salvaged[1].index != 2 {
		t.Fatalf("salvaged %+v", salvaged)
	}
	first, _ := recording.salvageTimelines(salvaged)
	if want := filepath.Join(recordings, "recording-x-failed.webm.timeline.json"); first != want {
		t.Fatalf("first timeline %q, want %q", first, want)
	}
	loaded, err := timeline.Read(first)
	if err != nil {
		t.Fatal(err)
	}
	if !loaded.Recording.Salvaged || loaded.Recording.Video != "recordings/recording-x-failed.webm" || len(loaded.Segments) != 1 || loaded.Recording.ContainerStartMs != 30 {
		t.Fatalf("timeline %+v", loaded)
	}
	second, err := timeline.Read(filepath.Join(recordings, "recording-x-failed-1.webm.timeline.json"))
	if err != nil || second.Recording.Video != "recordings/recording-x-failed-1.webm" || second.Segments[0].TargetID != "t" {
		t.Fatalf("second timeline %+v err %v", second, err)
	}
}

func TestSampleRecordedScreenSamplesBothCapturesWhileSegmentsOverlap(t *testing.T) {
	builder := timeline.NewBuilder(timeline.Limits{})
	started := time.Now()
	clock := func() (timeline.Clock, bool) { return timeline.Clock{FirstFrame: started, Duration: time.Hour}, true }
	builder.BeginSegment(timeline.SegmentInput{TargetID: "a", CaptureID: "capA", Width: 100, Height: 100, ScaleX: 1, ScaleY: 1, Started: started, Clock: clock})
	builder.BeginSegment(timeline.SegmentInput{TargetID: "b", CaptureID: "capB", Width: 100, Height: 100, ScaleX: 1, ScaleY: 1, Started: started, Clock: clock})
	var mu sync.Mutex
	seen := map[string]int{}
	read := func(_ context.Context, capture string) (captureDamage, error) {
		mu.Lock()
		defer mu.Unlock()
		seen[capture]++
		return captureDamage{LastChange: time.Now()}, nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		sampleRecordedScreen(ctx, builder, read, 5*time.Millisecond)
	}()
	time.Sleep(40 * time.Millisecond)
	builder.EndSegment(0, time.Now())
	mu.Lock()
	oldSeen := seen["capA"]
	mu.Unlock()
	time.Sleep(40 * time.Millisecond)
	cancel()
	<-done
	mu.Lock()
	defer mu.Unlock()
	if oldSeen == 0 || seen["capB"] == 0 {
		t.Fatalf("both captures must be sampled during the overlap: %v", seen)
	}
	if seen["capA"] != oldSeen {
		t.Fatalf("the old capture was sampled after its segment ended: %v", seen)
	}
}

func TestCompositorQueryEndsWhenCancelledWhileTheCompositorIsSilent(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "control")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = listener.Close() }()
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			defer func() { _ = conn.Close() }()
		}
	}()
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(50*time.Millisecond, cancel)
	begin := time.Now()
	if _, err := readCaptureDamage(ctx, socket, "cap"); err == nil {
		t.Fatal("a silent compositor produced an answer")
	}
	if elapsed := time.Since(begin); elapsed > time.Second {
		t.Fatalf("query held for %v after cancel", elapsed)
	}
}

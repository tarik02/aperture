package browser

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"

	"github.com/aperture/aperture/internal/recording/timeline"
)

// recordingSampleInterval is how often a recording asks the compositor whether
// its screen changed. 20 Hz places a change within a frame or two of when it
// happened, and each sample is one round trip on a local socket.
const recordingSampleInterval = 50 * time.Millisecond

// recordingTimelineFlushWait is how long finishing a segment waits for the
// pipeline's last frame reports, which can still be in its output pipe when it exits.
const recordingTimelineFlushWait = time.Second

// recordingTimeline collects what a recording needs for its timeline file while
// it runs: the pointer gestures, samples of the recorded screen's changes, and
// where each segment's frames were captured.
type recordingTimeline struct {
	builder *timeline.Builder

	mu     sync.Mutex
	probes []*screencastProbe

	stopOnce      sync.Once
	stopGestures  func()
	cancelSampler context.CancelFunc
	samplerDone   chan struct{}
}

// newRecordingTimeline starts collecting for a recording whose first segment,
// captured from target by the pipeline the probe watches, starts now.
func (r *wrapperRuntime) newRecordingTimeline(target wrapperTargetSnapshot, probe *screencastProbe, started time.Time) *recordingTimeline {
	collector := newTimelineCollector()
	collector.beginSegment(target, probe, started, 0)
	r.startTimelineCollection(collector)
	return collector
}

// newBurstsTimeline starts collecting for a bursts recording, which has no
// segment until its first burst opens one.
func (r *wrapperRuntime) newBurstsTimeline() *recordingTimeline {
	collector := newTimelineCollector()
	r.startTimelineCollection(collector)
	return collector
}

func newTimelineCollector() *recordingTimeline {
	return &recordingTimeline{
		builder:     timeline.NewBuilder(timeline.Limits{SampleInterval: recordingSampleInterval}),
		samplerDone: make(chan struct{}),
	}
}

// startTimelineCollection has the collector take the pointer gestures and sample
// the recorded screen.
func (r *wrapperRuntime) startTimelineCollection(collector *recordingTimeline) {
	collector.stopGestures = r.pointer.observe(func(record pointerGestureRecord) {
		collector.builder.AddGesture(timelineGesture(record))
	})
	ctx, cancel := context.WithCancel(r.ctx)
	collector.cancelSampler = cancel
	go func() {
		defer close(collector.samplerDone)
		sampleRecordedScreen(ctx, collector.builder, func(ctx context.Context, captureID string) (captureDamage, error) {
			return readCaptureDamage(ctx, r.controlSocket, captureID)
		}, recordingSampleInterval)
	}()
}

// beginSegment starts the next segment, whose pipeline is watched by probe. burst
// is the number of the burst it belongs to in a bursts recording, or zero.
func (t *recordingTimeline) beginSegment(target wrapperTargetSnapshot, probe *screencastProbe, started time.Time, burst uint64) int {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.probes = append(t.probes, probe)
	input := timelineSegment(target, probe, started)
	input.Burst = burst
	return t.builder.BeginSegment(input)
}

// endSegment records that a segment's pipeline has stopped, after which its
// frame reports are complete.
func (t *recordingTimeline) endSegment(index int, at time.Time) {
	t.mu.Lock()
	var probe *screencastProbe
	if index >= 0 && index < len(t.probes) {
		probe = t.probes[index]
	}
	t.mu.Unlock()
	if probe == nil {
		return
	}
	probe.wait(recordingTimelineFlushWait)
	t.builder.EndSegment(index, at)
}

// discardSegment removes the newest segment, whose pipeline was abandoned.
func (t *recordingTimeline) discardSegment(index int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if index == len(t.probes)-1 {
		t.probes = t.probes[:index]
		t.builder.DiscardSegment(index)
	}
}

// stop ends the collection: no more gestures or samples are taken.
func (t *recordingTimeline) stop() {
	t.stopOnce.Do(func() {
		t.stopGestures()
		t.cancelSampler()
		// A sample in flight ends at once unless the compositor is not answering.
		timer := time.NewTimer(recordingTimelineFlushWait)
		defer timer.Stop()
		select {
		case <-t.samplerDone:
		case <-timer.C:
		}
	})
}

// timelineSegment describes what a capture pipeline records of a target.
func timelineSegment(target wrapperTargetSnapshot, probe *screencastProbe, started time.Time) timeline.SegmentInput {
	viewport := target.Viewport
	input := timeline.SegmentInput{
		TargetID:  target.TargetID,
		CaptureID: target.CaptureID,
		// The frame is the content area cropped to even sizes, from the canvas' top left.
		Width:   min(viewport.CanvasWidth, (viewport.ContentWidth+1)/2*2),
		Height:  min(viewport.CanvasHeight, (viewport.ContentHeight+1)/2*2),
		ScaleX:  1,
		ScaleY:  1,
		Started: started,
		Clock:   probe.clock,
	}
	// Page coordinates (surface pixels) reach the frame through the surface scale,
	// the device pixel ratio; the content is the surface size rounded after scaling.
	if viewport.Width > 0 && viewport.Height > 0 && viewport.ContentWidth > 0 && viewport.ContentHeight > 0 {
		input.ScaleX = float64(viewport.ContentWidth) / float64(viewport.Width)
		input.ScaleY = float64(viewport.ContentHeight) / float64(viewport.Height)
	}
	return input
}

// timelineGesture converts a finished pointer gesture.
func timelineGesture(record pointerGestureRecord) timeline.GestureInput {
	input := timeline.GestureInput{
		ID:       record.ID,
		Kind:     string(record.Kind),
		Tool:     record.Tool,
		Mode:     string(record.Mode),
		TargetID: record.TargetID,
		Start:    record.Start,
		End:      record.End,
		Hold:     record.Hold,
		ScrollX:  record.ScrollX,
		ScrollY:  record.ScrollY,
		Caption:  record.Caption,
		Path:     make([]timeline.PathInput, 0, len(record.Path)),
		Clicks:   make([]timeline.ClickInput, 0, len(record.Clicks)),
	}
	for _, point := range record.Path {
		input.Path = append(input.Path, timeline.PathInput{Offset: point.Offset, X: point.X, Y: point.Y})
	}
	for _, click := range record.Clicks {
		input.Clicks = append(input.Clicks, timeline.ClickInput{At: click.At, X: click.X, Y: click.Y, Button: click.Button, Count: click.Count})
	}
	return input
}

// damageReader reads the change counter of a capture output.
type damageReader func(ctx context.Context, captureID string) (captureDamage, error)

// recordingSampleTimeout bounds one sample, so a compositor that stopped
// answering costs one interval of unknown, not the sampler.
const recordingSampleTimeout = 500 * time.Millisecond

// captureSampleState is what the sampler remembers about one capture output.
type captureSampleState struct {
	count       uint64
	haveCount   bool
	failedSince time.Time
}

// sampleRecordedScreen polls the capture outputs of the builder's active segments
// until ctx ends, and records into the builder when their content changed. While
// a segment is replaced, the old pipeline keeps recording until the new one has
// its first frame, so both captures are sampled through the overlap. Each sample
// reports how long ago the last change was, so changes are placed at their time,
// not the sample's. Samples that fail are recorded as intervals nothing is known
// about.
func sampleRecordedScreen(ctx context.Context, builder *timeline.Builder, read damageReader, interval time.Duration) {
	states := map[string]*captureSampleState{}
	closeFailure := func(capture string, state *captureSampleState, until time.Time) {
		if !state.failedSince.IsZero() {
			builder.AddUnknown(capture, state.failedSince, until)
			state.failedSince = time.Time{}
		}
	}
	defer func() {
		now := time.Now()
		for capture, state := range states {
			closeFailure(capture, state, now)
		}
	}()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		active := builder.ActiveCaptures()
		// A capture whose segment ended is forgotten, so a later segment on it does
		// not compare against a stale count.
		for capture, state := range states {
			if !slices.Contains(active, capture) {
				closeFailure(capture, state, time.Now())
				delete(states, capture)
			}
		}
		for _, capture := range active {
			state := states[capture]
			if state == nil {
				state = &captureSampleState{}
				states[capture] = state
			}
			sampled := time.Now()
			sampleCtx, cancel := context.WithTimeout(ctx, recordingSampleTimeout)
			damage, err := read(sampleCtx, capture)
			cancel()
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				if state.failedSince.IsZero() {
					state.failedSince = sampled
				}
				state.haveCount = false
				continue
			}
			closeFailure(capture, state, sampled)
			builder.NoteSample()
			if state.haveCount && damage.Count != state.count {
				builder.AddChange(capture, damage.LastChange)
			}
			state.count, state.haveCount = damage.Count, true
		}
	}
}

// finishRecordingTimeline writes the timeline of a published video next to it
// and returns the timeline's path, or an empty path when there is none. A
// timeline is an addition to the video, so failing to write one is reported
// but never fails the recording.
func (recording *wrapperRecording) finishRecordingTimeline(videoPath string, segments []int) string {
	collector := recording.timeline
	if collector == nil {
		return ""
	}
	relative, err := filepath.Rel(recording.filesRoot, videoPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "browser-session-wrapper: recording %s timeline: %v\n", recording.ID, err)
		return ""
	}
	built, err := collector.builder.Build(timeline.BuildOptions{
		Recording: timeline.Recording{
			ID:        recording.ID,
			Video:     filepath.ToSlash(relative),
			Mode:      string(recording.Mode),
			Capture:   string(recording.Capture),
			Codec:     recording.Codec,
			FPS:       recording.FPS,
			StartedAt: recording.StartedAt,
			Salvaged:  segments != nil,
		},
		Segments: segments,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "browser-session-wrapper: recording %s timeline: %v\n", recording.ID, err)
		return ""
	}
	path, err := timeline.Write(timeline.PathFor(videoPath), built)
	if err != nil {
		fmt.Fprintf(os.Stderr, "browser-session-wrapper: recording %s timeline: %v\n", recording.ID, err)
		return ""
	}
	return path
}

// finishTimelineCollection ends a recording's timeline collection after its
// last pipeline has stopped: the segment ends, and no more gestures or samples
// are taken. It can be called more than once.
func (recording *wrapperRecording) finishTimelineCollection(lastSegment int) {
	if recording.timeline == nil {
		return
	}
	recording.timeline.endSegment(lastSegment, time.Now())
	recording.timeline.stop()
}

// salvageTimelines writes a timeline next to each segment kept from a failed
// recording, each covering just that segment, and returns the first one's path.
func (recording *wrapperRecording) salvageTimelines(salvaged []salvagedSegment) string {
	first := ""
	for position, segment := range salvaged {
		if segment.index < 0 {
			continue
		}
		path := recording.finishRecordingTimeline(segment.path, []int{segment.index})
		if position == 0 {
			first = path
		}
	}
	return first
}

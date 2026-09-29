package browser

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"sync"
	"time"
)

const (
	// Recordings keep at most this many of each entry; later ones are dropped.
	timelineMaxActions  = 2000
	timelineMaxGestures = 1000
	timelineMaxPath     = 600
	timelineMaxSpans    = 5000
	// Damage is sampled at 20 Hz; changes at most this far apart form one activity span.
	timelineSampleEvery = 50 * time.Millisecond
	timelineSpanGap     = 300 * time.Millisecond
)

// frameClock reads the frame reports of a recording pipeline's identity element to
// learn when its first frame happened, which places the video on the wall clock. A
// pipeline takes an unpredictable 0.1 to 0.3 seconds to start, so nothing else can.
// gst-launch prints each report as it is made (g_print flushes per line), so the
// time a line is read is the frame's time within a few milliseconds.
type frameClock struct {
	frame time.Duration
	mu    sync.Mutex
	buf   []byte
	first time.Time
	pts0  time.Duration
	last  time.Duration
}

const frameElement = "aperture_frames"

// A report line: "...aperture_frames: last-message = chain ... pts: 0:00:00.033233797, ..."
var frameReport = regexp.MustCompile(`last-message = chain .*pts: (\d+):(\d\d):(\d\d)\.(\d+)`)

// Write implements io.Writer for the pipeline's stdout.
func (c *frameClock) Write(p []byte) (int, error) {
	read := time.Now()
	c.mu.Lock()
	defer c.mu.Unlock()
	c.buf = append(c.buf, p...)
	for {
		end := bytes.IndexByte(c.buf, '\n')
		if end < 0 {
			return len(p), nil
		}
		if line := c.buf[:end]; bytes.Contains(line, []byte(frameElement+":")) {
			c.observe(read, line)
		}
		c.buf = c.buf[end+1:]
	}
}

func (c *frameClock) observe(read time.Time, line []byte) {
	match := frameReport.FindSubmatch(line)
	if match == nil || string(match[1]) == "99" { // GStreamer prints an unset time as 99:99:...
		return
	}
	number := func(i int) time.Duration { n, _ := strconv.Atoi(string(match[i])); return time.Duration(n) }
	pts := number(1)*time.Hour + number(2)*time.Minute + number(3)*time.Second + number(4)
	if c.first.IsZero() {
		c.first, c.pts0 = read, pts
	}
	c.last = max(c.last, pts)
}

// span reports when the first frame happened and how long the segment's video is.
func (c *frameClock) span() (time.Time, time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.first.IsZero() {
		return time.Time{}, 0
	}
	return c.first, c.last - c.pts0 + c.frame
}

type timelineSpan struct{ start, end time.Time }

// timelineSegment is one capture pipeline of a recording.
type timelineSegment struct {
	targetID, captureID string
	width, height       int
	// scaleX and scaleY take compositor surface pixels to video pixels.
	scaleX, scaleY float64
	clock          *frameClock
	ended          bool
	// spans are when content changed; unknown are stretches where it could not be sampled.
	spans, unknown []timelineSpan
}

// timelineGesture and timelineAction are what the browser MCP host reports in a tool
// result's `_meta.aperture` (wall-clock epoch milliseconds, compositor surface pixels)
// and what the timeline file holds (video milliseconds, video pixels).
type timelineGesture struct {
	Tool     string `json:"tool"`
	TargetID string `json:"targetId"`
	// Fallback: the page's own mouse was used, so coordinates are viewport CSS pixels
	// rather than surface pixels and are not kept.
	Fallback bool            `json:"fallback,omitempty"`
	Start    int64           `json:"start"`
	End      int64           `json:"end"`
	Hold     int64           `json:"hold"`
	Path     [][3]float64    `json:"path"` // t, x, y
	Clicks   []timelineClick `json:"clicks"`
	Scroll   *timelineScroll `json:"scroll,omitempty"`
}

type timelineClick struct {
	T      int64   `json:"t"`
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Button string  `json:"button"`
	Count  int     `json:"count"`
}

type timelineScroll struct {
	T      int64   `json:"t"`
	DeltaX float64 `json:"deltaX"`
	DeltaY float64 `json:"deltaY"`
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
}

type timelineAction struct {
	Tool     string `json:"tool"`
	TargetID string `json:"targetId"`
	Start    int64  `json:"start"`
	End      int64  `json:"end"`
	Caption  string `json:"caption,omitempty"`
	OK       bool   `json:"ok"`
}

// recordingTimeline collects what a recording's timeline file needs while it runs.
type recordingTimeline struct {
	mu       sync.Mutex
	segments []*timelineSegment
	actions  []timelineAction
	gestures []timelineGesture
}

// begin adds the segment a new capture pipeline records.
func (t *recordingTimeline) begin(target wrapperTargetSnapshot, clock *frameClock) {
	viewport := target.Viewport
	segment := &timelineSegment{
		targetID: target.TargetID, captureID: target.CaptureID, clock: clock, scaleX: 1, scaleY: 1,
		// The frame is the content area cropped to even sizes.
		width:  min(viewport.CanvasWidth, (viewport.ContentWidth+1)/2*2),
		height: min(viewport.CanvasHeight, (viewport.ContentHeight+1)/2*2),
	}
	if viewport.Width > 0 && viewport.Height > 0 {
		segment.scaleX = float64(viewport.ContentWidth) / float64(viewport.Width)
		segment.scaleY = float64(viewport.ContentHeight) / float64(viewport.Height)
	}
	t.mu.Lock()
	t.segments = append(t.segments, segment)
	t.mu.Unlock()
}

// discard removes the newest segment, whose pipeline was abandoned.
func (t *recordingTimeline) discard() {
	if t != nil {
		t.mu.Lock()
		t.segments = t.segments[:len(t.segments)-1]
		t.mu.Unlock()
	}
}

// end marks the oldest running segment as stopped; a replacement may already run.
func (t *recordingTimeline) end() {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, segment := range t.segments {
		if !segment.ended {
			segment.ended = true
			return
		}
	}
}

// add takes what a tool result reported, unless the recording has stopped capturing.
func (t *recordingTimeline) add(action *timelineAction, gesture *timelineGesture) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if len(t.segments) == 0 || t.segments[len(t.segments)-1].ended {
		return
	}
	if action != nil && len(t.actions) < timelineMaxActions {
		t.actions = append(t.actions, *action)
	}
	if gesture != nil && len(t.gestures) < timelineMaxGestures {
		gesture.Path = gesture.Path[:min(len(gesture.Path), timelineMaxPath)]
		t.gestures = append(t.gestures, *gesture)
	}
}

// sample polls the compositor for content changes on every capture still recording,
// including the old one while a replacement takes over, until all have ended.
func (t *recordingTimeline) sample(ctx context.Context, socket string) {
	counts := map[*timelineSegment]uint64{}
	ticker := time.NewTicker(timelineSampleEvery)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		t.mu.Lock()
		var live []*timelineSegment
		for _, segment := range t.segments {
			if !segment.ended {
				live = append(live, segment)
			}
		}
		t.mu.Unlock()
		if len(live) == 0 {
			return
		}
		for _, segment := range live {
			requested := time.Now()
			sampleCtx, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
			response, err := sendCompositorControlCommand(sampleCtx, socket, "damage-status "+segment.captureID+"\n")
			cancel()
			var sinceMS, count uint64
			if _, scanErr := fmt.Sscanf(response, "ok %d %d", &sinceMS, &count); err != nil || scanErr != nil {
				segment.unknown = addSpan(segment.unknown, requested, time.Now())
				continue
			}
			previous, seen := counts[segment]
			counts[segment] = count
			if seen && count != previous {
				answered := time.Now()
				at := requested.Add(answered.Sub(requested) / 2).Add(-time.Duration(sinceMS) * time.Millisecond)
				segment.spans = addSpan(segment.spans, at, at)
			}
		}
	}
}

// addSpan extends the last span when the new one is close to it, else starts another.
func addSpan(spans []timelineSpan, start, end time.Time) []timelineSpan {
	if n := len(spans); n > 0 && start.Sub(spans[n-1].end) <= timelineSpanGap {
		spans[n-1].end = end
	} else if n < timelineMaxSpans {
		spans = append(spans, timelineSpan{start, end})
	}
	return spans
}

// The timeline file. Times are milliseconds of video time; coordinates are video pixels.
type timelineDoc struct {
	Version     int                  `json:"version"`
	RecordingID string               `json:"recordingId"`
	Video       string               `json:"video"`
	DurationMS  int64                `json:"durationMs"`
	Segments    []timelineSegmentOut `json:"segments"`
	Actions     []timelineAction     `json:"actions"`
	Gestures    []timelineGesture    `json:"gestures"`
	Activity    []timelineSpanOut    `json:"activity"`
	// Unknown is where damage could not be sampled, so quiet there does not mean idle.
	Unknown []timelineSpanOut `json:"unknown"`
}

type timelineSegmentOut struct {
	TargetID string `json:"targetId"`
	Start    int64  `json:"start"`
	End      int64  `json:"end"`
	Width    int    `json:"width"`
	Height   int    `json:"height"`
}

type timelineSpanOut struct {
	Start int64 `json:"start"`
	End   int64 `json:"end"`
}

// placement maps wall-clock time onto one segment's stretch of the video.
type placement struct {
	*timelineSegment
	anchor         time.Time
	offset, length int64
}

func (p placement) ms(wall time.Time) int64 {
	return p.offset + min(max(wall.Sub(p.anchor).Milliseconds(), 0), p.length)
}

func (p placement) point(x, y float64) (float64, float64) {
	clamp := func(v float64, size int) float64 { return math.Round(min(max(v, 0), float64(max(size-1, 0)))) }
	return clamp(x*p.scaleX, p.width), clamp(y*p.scaleY, p.height)
}

// build converts what was collected into the timeline of the finished video: a
// segment's video time is the durations of the segments before it plus the time since
// its first frame.
func (t *recordingTimeline) build(recordingID, video string) timelineDoc {
	t.mu.Lock()
	defer t.mu.Unlock()
	doc := timelineDoc{Version: 1, RecordingID: recordingID, Video: video, Segments: []timelineSegmentOut{},
		Actions: []timelineAction{}, Gestures: []timelineGesture{}, Activity: []timelineSpanOut{}, Unknown: []timelineSpanOut{}}
	var placed []placement
	for _, segment := range t.segments {
		anchor, length := segment.clock.span()
		if anchor.IsZero() {
			continue
		}
		p := placement{segment, anchor, doc.DurationMS, length.Milliseconds()}
		placed = append(placed, p)
		doc.DurationMS += p.length
		doc.Segments = append(doc.Segments, timelineSegmentOut{segment.targetID, p.offset, p.offset + p.length, segment.width, segment.height})
		for _, span := range segment.spans {
			doc.Activity = append(doc.Activity, timelineSpanOut{p.ms(span.start), p.ms(span.end)})
		}
		for _, span := range segment.unknown {
			doc.Unknown = append(doc.Unknown, timelineSpanOut{p.ms(span.start), p.ms(span.end)})
		}
	}
	if len(placed) == 0 {
		return doc
	}
	// The segment showing a moment is the last one whose first frame has happened.
	at := func(wall time.Time, targetID string) *placement {
		for i := len(placed) - 1; i >= 0; i-- {
			if !placed[i].anchor.After(wall) && (targetID == "" || placed[i].targetID == targetID) {
				return &placed[i]
			}
		}
		return nil
	}
	epoch := func(ms int64) time.Time { return time.UnixMilli(ms) }
	for _, action := range t.actions {
		if epoch(action.End).Before(placed[0].anchor) {
			continue
		}
		start := at(epoch(action.Start), "")
		if start == nil {
			start = &placed[0]
		}
		action.Start, action.End = start.ms(epoch(action.Start)), at(epoch(action.End), "").ms(epoch(action.End))
		doc.Actions = append(doc.Actions, action)
	}
	for _, gesture := range t.gestures {
		p := at(epoch(gesture.Start), gesture.TargetID)
		if p == nil {
			continue // the gesture was on a target this recording was not showing
		}
		path, clicks, scroll := gesture.Path, gesture.Clicks, gesture.Scroll
		gesture.Start, gesture.End = p.ms(epoch(gesture.Start)), p.ms(epoch(gesture.End))
		if gesture.Fallback { // viewport CSS pixels, not surface pixels
			path, clicks, scroll = nil, nil, nil
		}
		gesture.Path, gesture.Clicks = make([][3]float64, len(path)), make([]timelineClick, len(clicks))
		for i, point := range path {
			x, y := p.point(point[1], point[2])
			gesture.Path[i] = [3]float64{float64(p.ms(epoch(int64(point[0])))), x, y}
		}
		for i, click := range clicks {
			click.X, click.Y = p.point(click.X, click.Y)
			click.T = p.ms(epoch(click.T))
			gesture.Clicks[i] = click
		}
		gesture.Scroll = nil
		if scroll != nil {
			moved := *scroll
			moved.T = p.ms(epoch(moved.T))
			moved.X, moved.Y = p.point(moved.X, moved.Y)
			gesture.Scroll = &moved
		}
		doc.Gestures = append(doc.Gestures, gesture)
	}
	return doc
}

// publishTimeline writes the timeline of a finished video next to it, named after it
// (`demo.webm.timeline.json`) and without replacing a file, and returns its path. A
// timeline only adds to the video, so failing to write one never fails the recording.
func (recording *wrapperRecording) publishTimeline(video string) string {
	if recording.timeline == nil {
		return ""
	}
	path, err := recording.writeTimeline(video)
	if err != nil {
		fmt.Fprintf(os.Stderr, "browser-session-wrapper: recording %s timeline: %v\n", recording.ID, err)
	}
	return path
}

func (recording *wrapperRecording) writeTimeline(video string) (string, error) {
	relative, err := filepath.Rel(recording.filesRoot, video)
	if err != nil {
		return "", err
	}
	contents, err := json.Marshal(recording.timeline.build(recording.ID, filepath.ToSlash(relative)))
	if err != nil {
		return "", err
	}
	temp, err := os.CreateTemp(filepath.Dir(video), ".timeline-*")
	if err != nil {
		return "", err
	}
	defer func() { _ = os.Remove(temp.Name()) }()
	if _, err := temp.Write(contents); err != nil {
		_ = temp.Close()
		return "", err
	}
	if err := temp.Close(); err != nil {
		return "", err
	}
	return publishRecording(temp.Name(), video+".timeline.json")
}

// recordTimeline hands what a Playwright tool result reported in `_meta.aperture` to
// the recordings that are running.
func (session *liveSession) recordTimeline(meta map[string]any) {
	encoded, err := json.Marshal(meta)
	var reported struct {
		Action  *timelineAction  `json:"action"`
		Gesture *timelineGesture `json:"gesture"`
	}
	if err != nil || json.Unmarshal(encoded, &reported) != nil {
		return
	}
	r := session.runtime
	r.mu.Lock()
	var timelines []*recordingTimeline
	for _, recording := range session.recordings {
		if recording.Status == wrapperRecordingRunning && recording.timeline != nil {
			timelines = append(timelines, recording.timeline)
		}
	}
	r.mu.Unlock()
	for _, timeline := range timelines {
		timeline.add(reported.Action, reported.Gesture)
	}
}

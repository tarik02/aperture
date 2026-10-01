package browser

import (
	"bytes"
	"context"
	"fmt"
	"regexp"
	"strconv"
	"sync"
	"time"
)

// frameClock reads the frame reports of a recording pipeline's identity element to
// learn when its first frame happened, which places the video on the wall clock (a
// pipeline takes an unpredictable 0.1 to 0.3 seconds to start). gst-launch flushes
// each report per line, so the time a line is read is the frame's time.
type frameClock struct {
	frame time.Duration
	mu    sync.Mutex
	buf   []byte
	ready chan struct{}
	first time.Time
	pts0  time.Duration
	last  time.Duration
}

const frameElement = "aperture_frames"

// A report line: "...aperture_frames: last-message = chain ... pts: 0:00:00.033233797, ..."
var frameReport = regexp.MustCompile(`last-message = chain .*pts: (\d+):(\d\d):(\d\d)\.(\d+)`)

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
		close(c.ready)
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

// captureSource contains only facts observed at the capture boundary.
type captureSource struct {
	mu               sync.Mutex
	segments         []*captureSegment
	activityComplete bool
	cancel           context.CancelFunc
	done             chan struct{}
}
type captureSegment struct {
	TargetID         string  `json:"targetId"`
	FirstFrameMS     int64   `json:"firstFrameMs"`
	DurationMS       float64 `json:"durationMs"`
	Width            int     `json:"width"`
	Height           int     `json:"height"`
	ViewportScaleX   float64 `json:"viewportScaleX"`
	ViewportScaleY   float64 `json:"viewportScaleY"`
	CompositorScaleX float64 `json:"compositorScaleX"`
	CompositorScaleY float64 `json:"compositorScaleY"`
	Damage           []int64 `json:"damage"`
	captureID        string
	clock            *frameClock
	ended            bool
}

func newCaptureSource(ctx context.Context, socket string) *captureSource {
	ctx, cancel := context.WithCancel(ctx)
	source := &captureSource{activityComplete: true, cancel: cancel, done: make(chan struct{})}
	go source.sample(ctx, socket)
	return source
}

func (source *captureSource) begin(target wrapperTargetSnapshot, clock *frameClock) {
	viewport := target.Viewport
	width := min(viewport.CanvasWidth, (viewport.ContentWidth+1)/2*2)
	height := min(viewport.CanvasHeight, (viewport.ContentHeight+1)/2*2)
	source.mu.Lock()
	defer source.mu.Unlock()
	source.segments = append(source.segments, &captureSegment{
		TargetID: target.TargetID, Width: width, Height: height,
		ViewportScaleX:   float64(viewport.ContentWidth) / float64(viewport.Width),
		ViewportScaleY:   float64(viewport.ContentHeight) / float64(viewport.Height),
		CompositorScaleX: float64(viewport.ContentWidth) / float64(viewport.Width),
		CompositorScaleY: float64(viewport.ContentHeight) / float64(viewport.Height),
		Damage:           []int64{}, captureID: target.CaptureID, clock: clock,
	})
}
func (source *captureSource) end() {
	source.mu.Lock()
	defer source.mu.Unlock()
	for _, segment := range source.segments {
		if !segment.ended {
			segment.ended = true
			return
		}
	}
}
func (source *captureSource) finish() {
	if source == nil {
		return
	}
	source.cancel()
	<-source.done
}
func (source *captureSource) snapshot() ([]captureSegment, bool) {
	source.mu.Lock()
	defer source.mu.Unlock()
	segments := make([]captureSegment, 0, len(source.segments))
	for _, segment := range source.segments {
		first, duration := segment.clock.span()
		facts := *segment
		facts.FirstFrameMS = first.UnixMilli()
		facts.DurationMS = float64(duration) / float64(time.Millisecond)
		segments = append(segments, facts)
	}
	return segments, source.activityComplete
}
func (source *captureSource) sample(ctx context.Context, socket string) {
	defer close(source.done)
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	counts := make(map[*captureSegment]uint64)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		source.mu.Lock()
		live := make([]*captureSegment, 0, len(source.segments))
		for _, segment := range source.segments {
			if !segment.ended {
				live = append(live, segment)
			}
		}
		source.mu.Unlock()
		for _, segment := range live {
			requested := time.Now()
			sampleCtx, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
			response, err := sendCompositorControlCommand(sampleCtx, socket, "damage-status "+segment.captureID+"\n")
			cancel()
			var since, count uint64
			_, scanErr := fmt.Sscanf(response, "ok %d %d", &since, &count)
			source.mu.Lock()
			if err != nil || scanErr != nil {
				if ctx.Err() == nil {
					source.activityComplete = false
				}
			} else {
				previous, known := counts[segment]
				counts[segment] = count
				if known && previous != count {
					if len(segment.Damage) >= 100000 {
						source.activityComplete = false
					} else {
						at := requested.Add(time.Since(requested) / 2).Add(-time.Duration(since) * time.Millisecond)
						segment.Damage = append(segment.Damage, at.UnixMilli())
					}
				}
			}
			source.mu.Unlock()
		}
	}
}

func waitForFirstRecordingFrame(ctx context.Context, clock *frameClock) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	select {
	case <-clock.ready:
		return nil
	case <-ctx.Done():
		return fmt.Errorf("wait for first capture frame: %w", ctx.Err())
	}
}

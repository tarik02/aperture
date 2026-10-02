package browser

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"sync"
	"time"
)

const (
	// frameElement names the pipeline's identity element, whose frame reports tell when frames happen.
	frameElement              = "aperture_frames"
	firstFrameTimeout         = 5 * time.Second
	firstFrameRepaintInterval = 250 * time.Millisecond
	captureFactsFile          = "capture.json"
	recordingJournalFile      = "journal.jsonl"
	recordingJournalBudget    = 4 << 20
)

// A report line: "...aperture_frames: last-message = chain ... pts: 0:00:00.033233797, ..."
var frameReport = regexp.MustCompile(`last-message = chain .*pts: (\d+):(\d\d):(\d\d)\.(\d+)`)

// frameClock reads the frame reports of a capture pipeline (gst-launch -v) to learn when its first
// frame happened, which places the video on the wall clock: a pipeline takes an unpredictable
// 0.1 to 0.3 s to start. gst-launch flushes each report as a line, so the time a line is read is
// the frame's time.
type frameClock struct {
	frame time.Duration // one frame's duration, which the last frame's report does not cover
	ready chan struct{} // closed at the first frame

	mu    sync.Mutex
	buf   []byte
	first time.Time
	pts0  time.Duration
	last  time.Duration
}

func newFrameClock(fps int) *frameClock {
	return &frameClock{frame: time.Second / time.Duration(fps), ready: make(chan struct{})}
}

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

// span reports the wall time of the first frame and how long the segment's video lasts.
func (c *frameClock) span() (time.Time, time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.first.IsZero() {
		return time.Time{}, 0
	}
	return c.first, c.last - c.pts0 + c.frame
}

var errCapturePipelineExited = errors.New("capture pipeline exited before its first frame")

// waitForFirstFrame returns once the pipeline has produced its first frame. A static page produces
// none until it repaints, so it asks for repaints meanwhile; the pipeline's exit ends the wait early.
func (c *frameClock) waitForFirstFrame(ctx context.Context, repaint func(), exited <-chan error) error {
	ctx, cancel := context.WithTimeout(ctx, firstFrameTimeout)
	defer cancel()
	ticker := time.NewTicker(firstFrameRepaintInterval)
	defer ticker.Stop()
	for {
		select {
		case <-c.ready:
			return nil
		case <-ticker.C:
			repaint()
		case err := <-exited:
			return fmt.Errorf("%w: %v", errCapturePipelineExited, err)
		case <-ctx.Done():
			return fmt.Errorf("wait for first capture frame: %w", ctx.Err())
		}
	}
}

// recordingSegment is one capture pipeline's file of a recording, which changes pipeline whenever
// it follows another target or the target's capture is replaced. The exported fields are the facts
// the capture boundary observed, saved for the finalizer.
type recordingSegment struct {
	TargetID       string  `json:"targetId"`
	FirstFrameMS   int64   `json:"firstFrameMs,omitempty"` // wall clock, set when the capture ends; absent when it produced no frame
	DurationMS     float64 `json:"durationMs"`             // set when the capture ends
	Width          int     `json:"width"`                  // encoded size
	Height         int     `json:"height"`
	ViewportWidth  int     `json:"viewportWidth"` // CSS px of the captured surface: Width/ViewportWidth is the scale to video pixels
	ViewportHeight int     `json:"viewportHeight"`

	path  string
	clock *frameClock
}

func newRecordingSegment(path string, target wrapperTargetSnapshot) *recordingSegment {
	width, height := recordingSize(target.Viewport)
	return &recordingSegment{TargetID: target.TargetID, Width: width, Height: height, ViewportWidth: target.Viewport.Width, ViewportHeight: target.Viewport.Height, path: path}
}

// recordingSize is the encoded size of a viewport's capture: its content, rounded up to even.
func recordingSize(viewport compositorViewport) (int, int) {
	return min(viewport.CanvasWidth, (viewport.ContentWidth+1)/2*2), min(viewport.CanvasHeight, (viewport.ContentHeight+1)/2*2)
}

// writeCaptureFacts saves the facts of a recording whose capture pipeline has ended.
func writeCaptureFacts(recording *wrapperRecording) error {
	for _, segment := range recording.segments {
		first, duration := segment.clock.span()
		if !first.IsZero() {
			segment.FirstFrameMS = first.UnixMilli()
		}
		segment.DurationMS = float64(duration) / float64(time.Millisecond)
	}
	encoded, err := json.Marshal(map[string]any{"segments": recording.segments, "journalDropped": recording.journal.droppedEntries()})
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(recording.segmentDir, captureFactsFile), encoded, 0o600)
}

package browser

import (
	"bufio"
	"io"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/aperture/aperture/internal/recording/timeline"
)

// screencastFrameElement names the identity element that reports every frame
// entering the encoder. gst-launch prints its "chain" lines to stdout in
// verbose mode, through g_print, which flushes after every call: over a pipe
// each line arrives as it is printed (checked with a pipe reader, one write per
// line, and against a 0.6 s and a 4 s recording, whose anchors agree within
// 2 ms), so no line buffering wrapper such as stdbuf is needed. Were a line to
// lag, the probe keeps the smallest read-minus-timestamp difference, which a
// later, on-time frame would still correct.
const screencastFrameElement = "aperture_frames"

// screencastProbe learns from a recording pipeline's own output when its frames
// happened, which is the only way to place the video on the wall clock: video
// time is the pipeline's running time, and a pipeline takes an unpredictable
// 0.1 to 0.3 seconds to start.
//
// The identity element in front of the encoder reports each frame's timestamp
// as it passes. The probe pairs those with the time it read them; a line is read
// slightly after its frame passes, never before, so the smallest difference
// between the two is the best estimate of when the pipeline's clock was zero.
type screencastProbe struct {
	fps int
	now func() time.Time
	// finished is closed when the pipeline's output has ended.
	finished chan struct{}
	// ready is closed when the first frame has been observed.
	ready chan struct{}

	mu       sync.Mutex
	frames   int
	firstPTS time.Duration
	// anchor is the wall time of the first frame's timestamp, the best estimate so far.
	anchor time.Time
	// lastEnd is the end of the last frame's presentation, in the pipeline's clock.
	lastEnd time.Duration
}

func newScreencastProbe(fps int) *screencastProbe {
	return &screencastProbe{fps: fps, now: time.Now, finished: make(chan struct{}), ready: make(chan struct{})}
}

// chainLine matches the frame report of an identity element:
//
//	... last-message = chain   ******* (aperture_frames:sink) (3686400 bytes, dts: 0:00:00.033233797, pts: 0:00:00.033233797, duration: 0:00:00.033333333, ...
var chainLine = regexp.MustCompile(`last-message = chain .*\(` + screencastFrameElement + `:sink\).* pts: (\d+):(\d\d):(\d\d)\.(\d{9})(?:, duration: (?:(\d+):(\d\d):(\d\d)\.(\d{9})|[0-9:.]+))?`)

// parseChainLine returns the timestamp and duration a frame report carries. The
// duration is zero when the frame has none.
func parseChainLine(line string) (pts, duration time.Duration, ok bool) {
	match := chainLine.FindStringSubmatch(line)
	if match == nil {
		return 0, 0, false
	}
	// GStreamer prints an unset time as 99:99:99.999999999.
	if match[1] == "99" {
		return 0, 0, false
	}
	pts = parseClockTime(match[1], match[2], match[3], match[4])
	if match[5] != "" && match[5] != "99" {
		duration = parseClockTime(match[5], match[6], match[7], match[8])
	}
	return pts, duration, true
}

func parseClockTime(hours, minutes, seconds, nanoseconds string) time.Duration {
	h, _ := strconv.Atoi(hours)
	m, _ := strconv.Atoi(minutes)
	s, _ := strconv.Atoi(seconds)
	n, _ := strconv.Atoi(nanoseconds)
	return time.Duration(h)*time.Hour + time.Duration(m)*time.Minute + time.Duration(s)*time.Second + time.Duration(n)
}

// consume reads the pipeline's output until it ends. Lines that are frame
// reports feed the probe, and the notifications gst-launch prints about pads and
// caps in verbose mode are dropped; everything else goes to forward.
func (p *screencastProbe) consume(reader io.Reader, forward io.Writer) {
	defer close(p.finished)
	buffered := bufio.NewReaderSize(reader, 64*1024)
	for {
		line, err := buffered.ReadString('\n')
		if line != "" {
			read := p.now()
			switch {
			case strings.Contains(line, screencastFrameElement+": last-message = chain"):
				if pts, duration, ok := parseChainLine(line); ok {
					p.observe(read, pts, duration)
				}
			case strings.HasPrefix(line, "/GstPipeline:"):
			default:
				_, _ = io.WriteString(forward, line)
			}
		}
		if err != nil {
			return
		}
	}
}

// observe records one frame read at wall time read.
func (p *screencastProbe) observe(read time.Time, pts, duration time.Duration) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if duration <= 0 && p.fps > 0 {
		duration = time.Second / time.Duration(p.fps)
	}
	if p.frames == 0 {
		p.firstPTS = pts
		p.anchor = read
		if p.ready != nil {
			close(p.ready)
		}
	} else if candidate := read.Add(-(pts - p.firstPTS)); candidate.Before(p.anchor) {
		p.anchor = candidate
	}
	p.frames++
	p.lastEnd = max(p.lastEnd, pts+duration)
}

// clock returns what the probe knows, and false before the first frame.
func (p *screencastProbe) clock() (timeline.Clock, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.frames == 0 {
		return timeline.Clock{}, false
	}
	return timeline.Clock{FirstFrame: p.anchor, FirstPTS: p.firstPTS, Duration: p.lastEnd - p.firstPTS}, true
}

// wait blocks until the pipeline's output has ended, or the timeout passes.
// After a pipeline exits, its last frame reports may still be in the pipe.
func (p *screencastProbe) wait(timeout time.Duration) {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-p.finished:
	case <-timer.C:
	}
}

// attachScreencastProbe returns the write end of a pipe for a pipeline's stdout
// and the reader that feeds the probe from the other end. The parent closes its
// copy of the write end after the pipeline has started.
func attachScreencastProbe(probe *screencastProbe) (*os.File, error) {
	reader, writer, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	go func() {
		defer func() { _ = reader.Close() }()
		probe.consume(reader, os.Stdout)
	}()
	return writer, nil
}

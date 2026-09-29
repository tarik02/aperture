package edit

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/aperture/aperture/internal/recording/timeline"
)

// ffmpegTools finds ffmpeg and ffprobe for the integration tests: APERTURE_TEST_FFMPEG
// names the ffmpeg (ffprobe sits beside it), else they are looked up on PATH.
// The test is skipped when they are missing or ffmpeg lacks what edits need.
func ffmpegTools(t *testing.T) (ffmpeg, ffprobe string) {
	t.Helper()
	ffmpeg = os.Getenv("APERTURE_TEST_FFMPEG")
	if ffmpeg == "" {
		found, err := exec.LookPath("ffmpeg")
		if err != nil {
			t.Skip("ffmpeg is not installed")
		}
		ffmpeg = found
	}
	ffprobe = filepath.Join(filepath.Dir(ffmpeg), "ffprobe")
	if _, err := os.Stat(ffprobe); err != nil {
		t.Skip("ffprobe is not installed beside ffmpeg")
	}
	encoders, err := exec.Command(ffmpeg, "-hide_banner", "-encoders").Output()
	if err != nil || !strings.Contains(string(encoders), "libx264") {
		t.Skip("ffmpeg has no libx264")
	}
	filters, err := exec.Command(ffmpeg, "-hide_banner", "-filters").Output()
	if err != nil {
		t.Skip("ffmpeg cannot list its filters")
	}
	for _, name := range []string{" ass ", " perspective ", " geq ", " select ", " setpts "} {
		if !strings.Contains(string(filters), name) {
			t.Skipf("ffmpeg lacks the%sfilter", name)
		}
	}
	return ffmpeg, ffprobe
}

// marks are the places syntheticSource marks with a red square, in frame pixels.
var marks = []struct{ x, y int }{{400, 300}, {900, 500}, {500, 400}, {600, 450}}

// syntheticSource writes a white video with a grey grid and a red square at each
// of the marks, of the given size, length and rate, as a .webm (VP8) or, when
// ffmpeg has no VP8 encoder, .mkv (MPEG-4) file.
func syntheticSource(t *testing.T, ffmpeg, dir string, width, height, fps, seconds int) string {
	t.Helper()
	filter := "drawgrid=w=80:h=80:t=1:c=gray"
	for _, mark := range marks {
		filter += ",drawbox=x=" + strconv.Itoa(mark.x-5) + ":y=" + strconv.Itoa(mark.y-5) + ":w=10:h=10:color=red:t=fill"
	}
	input := "color=c=white:s=" + strconv.Itoa(width) + "x" + strconv.Itoa(height) + ":r=" + strconv.Itoa(fps) + ":d=" + strconv.Itoa(seconds)
	for _, candidate := range []struct {
		name string
		args []string
	}{
		{"source.webm", []string{"-c:v", "libvpx", "-b:v", "4M", "-g", "30", "-deadline", "realtime", "-cpu-used", "8", "-pix_fmt", "yuv420p"}},
		{"source.mkv", []string{"-c:v", "mpeg4", "-q:v", "3", "-g", "30", "-pix_fmt", "yuv420p"}},
	} {
		path := filepath.Join(dir, candidate.name)
		args := append([]string{"-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", input, "-vf", filter}, candidate.args...)
		if out, err := exec.Command(ffmpeg, append(args, path)...).CombinedOutput(); err == nil {
			return path
		} else if testing.Verbose() {
			t.Logf("%s: %v: %s", candidate.name, err, out)
		}
	}
	t.Skip("ffmpeg cannot encode a test video")
	return ""
}

// probeVideo returns the codec, size, frame count and duration of a video file.
func probeVideo(t *testing.T, ffprobe, path string) (codec string, width, height, frames int, seconds float64) {
	t.Helper()
	out, err := exec.Command(ffprobe, "-v", "error", "-count_frames", "-select_streams", "v:0",
		"-show_entries", "stream=codec_name,width,height,nb_read_frames:format=duration", "-of", "json", path).Output()
	if err != nil {
		t.Fatalf("ffprobe %s: %v", path, err)
	}
	var parsed struct {
		Streams []struct {
			Codec  string `json:"codec_name"`
			Width  int    `json:"width"`
			Height int    `json:"height"`
			Frames string `json:"nb_read_frames"`
		} `json:"streams"`
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
	}
	if err := json.Unmarshal(out, &parsed); err != nil || len(parsed.Streams) != 1 {
		t.Fatalf("ffprobe output %s: %v", out, err)
	}
	frames, _ = strconv.Atoi(parsed.Streams[0].Frames)
	seconds, _ = strconv.ParseFloat(parsed.Format.Duration, 64)
	return parsed.Streams[0].Codec, parsed.Streams[0].Width, parsed.Streams[0].Height, frames, seconds
}

// extractFrame saves the frame at a time of a video as a PNG.
func extractFrame(t *testing.T, ffmpeg, video string, seconds float64, out string) {
	t.Helper()
	cmd := exec.Command(ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", video, "-ss", strconv.FormatFloat(seconds, 'f', 3, 64), "-frames:v", "1", out)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("extract frame at %.3f: %v: %s", seconds, err, output)
	}
}

// syntheticTimeline is a 12 second, 30 fps recording of one 1280x720 segment: a
// click at 2 s, a scroll at 4 s and a drag at 5 s, all zoomed, a caption, and a
// screen that changes only until 6.5 s and after 10.5 s.
func syntheticTimeline(edit *timeline.EditOptions) *timeline.Timeline {
	return &timeline.Timeline{
		Version: timeline.Version,
		Recording: timeline.Recording{
			ID: "test", Video: "recordings/test.webm", Mode: "tab", Codec: "vp8", FPS: 30,
			Width: 1280, Height: 720, DurationMs: 12000, Edit: edit,
		},
		Segments: []timeline.Segment{{Index: 0, StartMs: 0, EndMs: 12000, Width: 1280, Height: 720, ScaleX: 1, ScaleY: 1, Clock: timeline.ClockPipeline}},
		Gestures: []timeline.Gesture{
			{
				ID: 1, Kind: "click", Tool: "browser_click", Mode: "compositor", StartMs: 1500, EndMs: 2050, HoldMs: 400, Zoom: 2, Ripple: true,
				Caption: "Click the blue button",
				Path:    []timeline.PathPoint{{TMs: 1500, X: 100, Y: 100}, {TMs: 2000, X: 400, Y: 300}},
				Clicks:  []timeline.Click{{TMs: 2000, X: 400, Y: 300, Button: "left", Count: 1}},
			},
			{
				ID: 2, Kind: "scroll", Tool: "browser_scroll", Mode: "cdp", StartMs: 4000, EndMs: 4300, Zoom: 1.6,
				Scroll: &timeline.Scroll{DY: 300, At: &timeline.Point{X: 900, Y: 500}},
			},
			{
				ID: 3, Kind: "drag", Tool: "browser_drag", Mode: "compositor", StartMs: 5000, EndMs: 6000, Zoom: 1.6,
				Path:   []timeline.PathPoint{{TMs: 5000, X: 300, Y: 200}, {TMs: 5300, X: 500, Y: 400}, {TMs: 6000, X: 600, Y: 450}},
				Clicks: []timeline.Click{{TMs: 5300, X: 500, Y: 400, Button: "left", Count: 1}},
			},
		},
		Captions: []timeline.Caption{{StartMs: 1500, EndMs: 2450, Text: "Click the blue button", Gesture: 1}},
		Activity: timeline.Activity{
			Available: true, SampleIntervalMs: 50, MergeGapMs: 250,
			Spans: []timeline.Span{{StartMs: 0, EndMs: 6500}, {StartMs: 10500, EndMs: 12000}},
		},
	}
}

// frameRGB returns the pixels of the frame at a time of a video as RGB.
func frameRGB(t *testing.T, ffmpeg, video string, seconds float64, width, height int) []byte {
	t.Helper()
	cmd := exec.Command(ffmpeg, "-hide_banner", "-loglevel", "error", "-ss", strconv.FormatFloat(seconds, 'f', 3, 64), "-i", video,
		"-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-")
	out, err := cmd.Output()
	if err != nil || len(out) != width*height*3 {
		t.Fatalf("frame at %.3f s: %v, %d bytes", seconds, err, len(out))
	}
	return out
}

// redMark finds the centre and side of the red square within 30 pixels of a
// place in a frame, from the pixels that are clearly red.
func redMark(pixels []byte, width, height int, nearX, nearY int) (cx, cy float64, side int, found bool) {
	minX, minY, maxX, maxY := width, height, -1, -1
	for y := max(nearY-30, 0); y < min(nearY+30, height); y++ {
		for x := max(nearX-30, 0); x < min(nearX+30, width); x++ {
			offset := (y*width + x) * 3
			if pixels[offset] > 200 && pixels[offset+1] < 70 && pixels[offset+2] < 70 {
				minX, maxX = min(minX, x), max(maxX, x)
				minY, maxY = min(minY, y), max(maxY, y)
			}
		}
	}
	if maxX < 0 {
		return 0, 0, 0, false
	}
	return float64(minX+maxX) / 2, float64(minY+maxY) / 2, maxX - minX + 1, true
}

// countPixels counts the pixels of a rectangle that satisfy a test on their red, green and blue.
func countPixels(pixels []byte, width int, x0, y0, x1, y1 int, test func(r, g, b byte) bool) int {
	count := 0
	for y := y0; y < y1; y++ {
		for x := x0; x < x1; x++ {
			offset := (y*width + x) * 3
			if test(pixels[offset], pixels[offset+1], pixels[offset+2]) {
				count++
			}
		}
	}
	return count
}

// ring counts the pixels between two distances of a point that are darker than
// the white page (its grid lines are grey and are counted by both frames compared).
func ring(pixels []byte, width, height int, cx, cy, inner, outer float64) int {
	count := 0
	for y := range height {
		for x := range width {
			distance := math.Hypot(float64(x)-cx, float64(y)-cy)
			if distance < inner || distance > outer {
				continue
			}
			offset := (y*width + x) * 3
			if pixels[offset] < 235 && pixels[offset+1] < 235 && pixels[offset+2] < 235 && pixels[offset+1] > 40 {
				count++
			}
		}
	}
	return count
}

func TestRunRendersEffects(t *testing.T) {
	ffmpeg, ffprobe := ffmpegTools(t)
	dir := t.TempDir()
	if keep := os.Getenv("APERTURE_EDIT_KEEP"); keep != "" {
		dir = keep
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	source := syntheticSource(t, ffmpeg, dir, 1280, 720, 30, 12)
	before, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	tl := syntheticTimeline(&timeline.EditOptions{Idle: timeline.IdleSpeed})
	work := filepath.Join(dir, "work")
	if err := os.MkdirAll(work, 0o755); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	result, err := Run(context.Background(), RunOptions{FFmpeg: ffmpeg, Source: source, WorkDir: work, Threads: 2}, tl)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	t.Logf("rendered in %s, plan %+v, warnings %v", time.Since(started), result.Plan.Report, result.Plan.Warnings)
	if result.Output == "" {
		t.Fatal("no output")
	}
	plan := result.Plan
	codec, width, height, frames, seconds := probeVideo(t, ffprobe, result.Output)
	if codec != "h264" || width != 1280 || height != 720 {
		t.Errorf("output is %s %dx%d, want h264 1280x720", codec, width, height)
	}
	planned := float64(plan.OutDurationMs) / 1000
	if diff := seconds - planned; diff < -0.1 || diff > 0.1 {
		t.Errorf("output lasts %.3f s, plan says %.3f s", seconds, planned)
	}
	if want := int(planned * 30); frames < want-3 || frames > want+3 {
		t.Errorf("output has %d frames, want about %d", frames, want)
	}
	if plan.Report.IdleRegions != 1 || plan.OutDurationMs >= 12000-1500 {
		t.Errorf("the idle stretch is sped up: %+v, %d ms", plan.Report, plan.OutDurationMs)
	}
	after, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Error("the source video was modified")
	}
	at := func(sourceMs int64) float64 { return float64(plan.TimeMap.Map(sourceMs)) / 1000 }

	// While the zoom holds on the click, the marked place is in the middle of the
	// frame, twice as big.
	hold := frameRGB(t, ffmpeg, result.Output, at(2800), 1280, 720)
	cx, cy, side, found := redMark(hold, 1280, 720, 640, 360)
	if !found || math.Abs(cx-640) > 6 || math.Abs(cy-360) > 6 || side < 17 || side > 23 {
		t.Errorf("zoomed on the click: mark at (%.1f, %.1f) side %d found %v, want the middle, side 20", cx, cy, side, found)
	}
	// Zoomed out again, the picture is the source's.
	out := frameRGB(t, ffmpeg, result.Output, at(7500), 1280, 720)
	cx, cy, side, found = redMark(out, 1280, 720, 400, 300)
	if !found || math.Abs(cx-400) > 3 || math.Abs(cy-300) > 3 || side < 9 || side > 12 {
		t.Errorf("zoomed out: mark at (%.1f, %.1f) side %d found %v, want (400, 300) side 10", cx, cy, side, found)
	}
	// The ripple spreads around the click, which sits in the middle at the zoom.
	spreading := frameRGB(t, ffmpeg, result.Output, at(2300), 1280, 720)
	after3 := frameRGB(t, ffmpeg, result.Output, at(3200), 1280, 720)
	if with, without := ring(spreading, 1280, 720, 640, 360, 45, 110), ring(after3, 1280, 720, 640, 360, 45, 110); with < without+150 {
		t.Errorf("ring pixels while the ripple spreads: %d, after it: %d", with, without)
	}
	// The caption is burned in while it shows, and gone after.
	dark := func(r, g, b byte) bool { return r < 90 && g < 90 && b < 90 }
	if shown, gone := countPixels(hold, 1280, 380, 630, 900, 700, dark), countPixels(out, 1280, 380, 630, 900, 700, dark); shown < 800 || gone > 0 {
		t.Errorf("caption box pixels: %d while shown, %d after", shown, gone)
	}
	if os.Getenv("APERTURE_EDIT_KEEP") != "" {
		for name, ms := range map[string]int64{"click": 2000, "mid": 2300, "hold": 2800, "scroll": 4200, "drag": 5500, "out": 7500} {
			extractFrame(t, ffmpeg, result.Output, at(ms), filepath.Join(dir, "frame-"+name+".png"))
		}
	}
}

func TestRunWithNothingToApplyRendersNothing(t *testing.T) {
	ffmpeg, _ := ffmpegTools(t)
	dir := t.TempDir()
	source := syntheticSource(t, ffmpeg, dir, 640, 360, 30, 2)
	tl := syntheticTimeline(nil)
	tl.Recording.Width, tl.Recording.Height, tl.Recording.DurationMs = 640, 360, 2000
	tl.Segments[0].Width, tl.Segments[0].Height = 640, 360
	tl.Gestures, tl.Captions = nil, nil
	result, err := Run(context.Background(), RunOptions{FFmpeg: ffmpeg, Source: source, WorkDir: dir}, tl)
	if err != nil {
		t.Fatal(err)
	}
	if result.Output != "" || !result.Plan.Trivial() {
		t.Errorf("result %+v", result)
	}
	if _, err := os.Stat(filepath.Join(dir, OutputName)); err == nil {
		t.Error("a video was written")
	}
}

func TestRunRefusesAVideoWhoseFramesChangeSize(t *testing.T) {
	ffmpeg, _ := ffmpegTools(t)
	dir := t.TempDir()
	var parts []string
	for index, size := range []string{"640x360", "480x270"} {
		path := filepath.Join(dir, "part"+strconv.Itoa(index)+".webm")
		args := []string{"-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=" + size + ":r=30:d=1", "-c:v", "libvpx", "-g", "15", "-pix_fmt", "yuv420p", path}
		if out, err := exec.Command(ffmpeg, args...).CombinedOutput(); err != nil {
			t.Skipf("cannot encode a test video: %v: %s", err, out)
		}
		parts = append(parts, path)
	}
	list := filepath.Join(dir, "list.txt")
	if err := os.WriteFile(list, []byte("file '"+parts[0]+"'\nfile '"+parts[1]+"'\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	joined := filepath.Join(dir, "joined.mkv")
	if out, err := exec.Command(ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", joined).CombinedOutput(); err != nil {
		t.Skipf("cannot join test videos: %v: %s", err, out)
	}
	// The timeline of a recording that never noticed: one size all through.
	tl := syntheticTimeline(&timeline.EditOptions{Idle: timeline.IdleCut})
	tl.Recording.Width, tl.Recording.Height, tl.Recording.DurationMs = 640, 360, 2000
	tl.Segments[0].Width, tl.Segments[0].Height = 640, 360
	_, err := Run(context.Background(), RunOptions{FFmpeg: ffmpeg, Source: joined, WorkDir: dir}, tl)
	var failure *Error
	if !errors.As(err, &failure) || failure.Code != CodeMixedSizes {
		t.Fatalf("error %v, want %s", err, CodeMixedSizes)
	}
}

func TestRunRefusesWhatIsNotAPlainVideoFile(t *testing.T) {
	ffmpeg, _ := ffmpegTools(t)
	dir := t.TempDir()
	source := syntheticSource(t, ffmpeg, dir, 320, 180, 30, 1)
	tl := syntheticTimeline(nil)
	options := RunOptions{FFmpeg: ffmpeg, WorkDir: dir}
	link := filepath.Join(dir, "link"+filepath.Ext(source))
	if err := os.Symlink(source, link); err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(dir, "clip.avi")
	if err := os.WriteFile(other, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	playlist := filepath.Join(dir, "list.mkv")
	if err := os.WriteFile(playlist, []byte("ffconcat version 1.0\nfile '"+source+"'\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for name, path := range map[string]string{"a symbolic link": link, "an unknown extension": other, "a missing file": filepath.Join(dir, "missing.webm"), "a playlist": playlist} {
		options.Source = path
		_, err := Run(context.Background(), options, tl)
		var failure *Error
		if !errors.As(err, &failure) || failure.Code != CodeSourceUnreadable {
			t.Errorf("%s: error %v, want %s", name, err, CodeSourceUnreadable)
		}
	}
}

func TestRunStopsWhenCancelled(t *testing.T) {
	ffmpeg, _ := ffmpegTools(t)
	dir := t.TempDir()
	source := syntheticSource(t, ffmpeg, dir, 320, 180, 30, 1)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := Run(ctx, RunOptions{FFmpeg: ffmpeg, Source: source, WorkDir: dir}, syntheticTimeline(&timeline.EditOptions{Idle: timeline.IdleSpeed}))
	var failure *Error
	if !errors.As(err, &failure) || failure.Code != CodeCanceled {
		t.Fatalf("error %v, want %s", err, CodeCanceled)
	}
}

func TestRunWithoutFFmpegIsUnavailable(t *testing.T) {
	_, err := Run(context.Background(), RunOptions{Source: "x.webm", WorkDir: t.TempDir()}, syntheticTimeline(nil))
	var failure *Error
	if !errors.As(err, &failure) || failure.Code != CodeUnavailable {
		t.Fatalf("error %v", err)
	}
}

func TestRenderTimeoutScalesWithTheVideoWithinBounds(t *testing.T) {
	for _, test := range []struct {
		durationMs int64
		max        time.Duration
		want       time.Duration
	}{
		// 30 seconds and ten times the video, at least two minutes, at most the limit.
		{1_000, 0, 2 * time.Minute},
		{10_000, 0, 130 * time.Second},
		{600_000, 0, 30 * time.Minute},
		{600_000, 5 * time.Minute, 5 * time.Minute},
		{1_000, 30 * time.Second, 30 * time.Second},
	} {
		if got := renderTimeout(test.durationMs, test.max); got != test.want {
			t.Errorf("renderTimeout(%d, %v) = %v, want %v", test.durationMs, test.max, got, test.want)
		}
	}
}

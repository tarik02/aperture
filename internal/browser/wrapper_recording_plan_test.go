package browser

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// Wall clock 1_000_000 ms is the first frame of segment A (10 s, 1280x720 for a 640x360 viewport);
// segment B (8 s, 640x360) starts 2 s of wall time after A ends.
func planSegments() []*recordingSegment {
	return []*recordingSegment{
		{TargetID: "A", FirstFrameMS: 1_000_000, DurationMS: 10_000, Width: 1280, Height: 720, ViewportWidth: 640, ViewportHeight: 360},
		{TargetID: "B", FirstFrameMS: 1_012_000, DurationMS: 8_000, Width: 640, Height: 360, ViewportWidth: 640, ViewportHeight: 360},
	}
}

// entry builds a journal entry from wall offsets in ms since 1_000_000.
func entry(kind string, start, end int64, fields map[string]any) journalEntry {
	e := journalEntry{"kind": kind, "startMs": float64(1_000_000 + start), "endMs": float64(1_000_000 + end)}
	for key, value := range fields {
		e[key] = value
	}
	return e
}

func TestPlacingTheJournalAndKeepingBursts(t *testing.T) {
	plan := placeJournal(planSegments(), []journalEntry{
		entry("call", 2000, 3000, nil), entry("call", 3500, 4000, nil), entry("call", 13_000, 14_000, nil),
	})
	// Segment B starts at 10 s of video; its first frame was at 12 s of wall time.
	if plan.total != 18_000 || plan.events[0].span() != (span{2000, 3000}) || plan.events[2].span() != (span{11_000, 12_000}) {
		t.Fatalf("total %d, events %v", plan.total, plan.events)
	}
	// A time between segments lands on the boundary.
	if got := plan.videoTime(1_011_000); got != 10_000 {
		t.Fatalf("a time between segments = %d", got)
	}
	// The picture changed until 4.3 s and then stood still, so the first tail runs to 4.3 s plus the settle time. The
	// second burst overlaps it, and the third never settles, so it runs to its maximum.
	pieces := burstPieces(defaultBurst, plan.events, []span{{2000, 4300}, {11_500, 18_000}}, plan.total)
	want := []piece{{1500, 4800, 1}, {10_500, 15_000, 1}}
	if !slices.Equal(pieces, want) {
		t.Fatalf("pieces = %v, want %v", pieces, want)
	}
	// One time map serves every time: the cut stretches collapse.
	if mapTime(pieces, 2000) != 500 || mapTime(pieces, 11_000) != 3300+500 || mapTime(pieces, 6000) != 3300 {
		t.Fatalf("map: %d %d %d", mapTime(pieces, 2000), mapTime(pieces, 11_000), mapTime(pieces, 6000))
	}
}

func TestIdleIsCutOrSpedUpAroundWhatHappens(t *testing.T) {
	events := []journalEntry{{"kind": "call", "startMs": 5000.0, "endMs": 6000.0}}
	cut := idlePieces("cut", events, nil, 20_000)
	if want := []piece{{4700, 6300, 1}}; !slices.Equal(cut, want) {
		t.Fatalf("cut = %v", cut)
	}
	// The picture changed between 8 s and 8.5 s, which is not worth fast-forwarding past.
	speed := idlePieces("speed", events, []span{{8000, 8500}}, 20_000)
	want := []piece{{0, 4700, 8}, {4700, 6300, 1}, {6300, 7700, 8}, {7700, 8800, 1}, {8800, 20_000, 8}}
	if !slices.Equal(speed, want) {
		t.Fatalf("speed = %v", speed)
	}
	if mapTime(speed, 20_000) != 4863 {
		t.Fatalf("edited length = %d", mapTime(speed, 20_000))
	}
}

func TestPlanLowersEffectsOntoEditedTime(t *testing.T) {
	cfg := recordingConfig{Capture: "bursts", Burst: &burstConfig{LeadMS: 500, TailMS: 500, SettleMS: 400, MaxTailMS: 1000}, Ripple: true}
	plan := placeJournal(planSegments(), []journalEntry{
		entry("call", 4000, 5000, nil),
		entry("press", 4200, 4200, map[string]any{"x": 100.0, "y": 50.0}),
		entry("caption", 3600, 3600, map[string]any{"text": `a\b {c}  d`, "durationMs": 2000.0}),
		entry("focus", 4500, 5000, map[string]any{"zoom": 2.0, "rect": map[string]any{"x": 10.0, "y": 10.0, "width": 100.0, "height": 40.0}}),
		entry("call", 13_000, 14_000, nil),
	})
	if err := plan.plan(cfg, 30, nil); err != nil {
		t.Fatal(err)
	}
	for _, part := range []string{"select='", "setpts='", "scale=1280:720", "perspective=", "enable='between(t,", "ass=captions.ass"} {
		if !strings.Contains(plan.filter, part) {
			t.Errorf("filter lacks %s: %s", part, plan.filter)
		}
	}
	// Backslashes and braces cannot start an override tag; whitespace collapses.
	if !strings.Contains(string(plan.ass), "Dialogue: 0,0:00:00.10,0:00:02.10,Default,,0,0,0,,a＼b \\{c\\} d") {
		t.Errorf("ass: %s", plan.ass)
	}
	// The timeline reports edited times only for an edit that exists.
	if _, ok := plan.timeline(false).Events[0]["editedStartMs"]; ok {
		t.Error("an unedited timeline has edited times")
	}
	edited := plan.timeline(true)
	if edited.EditedDurationMS != 4000 || edited.Map[1].EditedStartMS != 2000 || edited.Events[1]["editedStartMs"] != 500.0 {
		t.Errorf("timeline = %+v", edited)
	}
	// Nothing to apply, nothing to render.
	idle := placeJournal(planSegments(), nil)
	if err := idle.plan(recordingConfig{Capture: "continuous"}, 30, nil); err != nil || idle.filter != "" {
		t.Errorf("empty plan: %q %v", idle.filter, err)
	}
}

func TestFocusWindowsCloseTogetherShareOneZoom(t *testing.T) {
	zoom := func(start, end int64, x float64) focus { return focus{start, end, 2, x, 100} }
	near := focusFilters([]focus{zoom(1000, 2000, 100), zoom(2300, 3000, 400)}, 640, 360, 30)
	apart := focusFilters([]focus{zoom(1000, 2000, 100), zoom(5000, 6000, 400)}, 640, 360, 30)
	if len(near) != 1 || len(apart) != 2 {
		t.Fatalf("near %d, apart %d", len(near), len(apart))
	}
	// The zoom is out of the frame outside its window, and the pan between the windows is one ease.
	if !strings.Contains(near[0], "enable='between(t,0.9") || !strings.Contains(near[0], "clip((in-61)/19,0,1)") {
		t.Errorf("filter: %s", near[0])
	}
}

func TestVideoAnalysisLogs(t *testing.T) {
	// A run of close frames is a change; a frame alone, as a blinking caret makes, is not.
	log := "pts_time:0\npts_time:0.5\npts_time:1.2\npts_time:1.25\npts_time:1.3\npts_time:2.5\n"
	if active := parseActive(log); !slices.Equal(active, []span{{1200, 1300}}) {
		t.Errorf("active = %v", active)
	}
}

func TestRecordingConfigRules(t *testing.T) {
	for config, wantErr := range map[string]bool{
		`{}`: false, `{"capture":"bursts"}`: false, `{"capture":"bursts","burst":{"leadMs":100}}`: false, `{"idle":"speed","ripple":true}`: false,
		`{"capture":"bursts","idle":"cut"}`: true, `{"capture":"burst"}`: true, `{"idle":"fast"}`: true, `{"burst":{"leadMs":1}}`: true,
		`{"capture":"bursts","burst":{"tailMs":5000}}`: true, `{"capture":"bursts","burst":{"leadMs":-1}}`: true,
	} {
		var c recordingConfig
		if err := json.Unmarshal([]byte(config), &c); err != nil {
			t.Fatal(err)
		}
		if err := c.validate(); (err != nil) != wantErr || (err != nil && !errors.Is(err, errRecordingConfigInvalid)) {
			t.Errorf("%s: %v", config, err)
		}
	}
	c := recordingConfig{Capture: "bursts", Burst: &burstConfig{LeadMS: 100}}
	if _ = c.validate(); *c.Burst != (burstConfig{100, 800, 400, 3000}) {
		t.Errorf("defaults = %+v", *c.Burst)
	}
}

// ffmpegForTest finds an ffmpeg that can encode h264, or skips.
func ffmpegForTest(t *testing.T) string {
	t.Helper()
	path, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("no ffmpeg")
	}
	if out, _ := exec.Command(path, "-hide_banner", "-encoders").Output(); !strings.Contains(string(out), "libx264") {
		t.Skip("ffmpeg has no libx264")
	}
	return path
}

// finalizeFixture is a stopped recording of 6 s: a red box moves for 2 s, then the screen stands still.
func finalizeFixture(t *testing.T, ffmpeg string, config recordingConfig, journal ...journalEntry) (*liveSession, *wrapperRecording, string) {
	t.Helper()
	recordings := t.TempDir()
	raw := filepath.Join(recordings, "demo.mkv")
	source := exec.Command(ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=white:s=320x240:r=30:d=6",
		"-vf", "drawbox=x='mod(t*60,200)':y=100:w=40:h=40:color=red:t=fill:enable='lt(t,2)'", "-c:v", "libx264", "-y", raw)
	if out, err := source.CombinedOutput(); err != nil {
		t.Fatalf("fixture: %v: %s", err, out)
	}
	session := newJournalSession(t, &wrapperRecording{ID: "r1", Status: wrapperRecordingRunning})
	session.runtime.values.RecordingFFmpegExecutable = ffmpeg
	recording := session.recordings["r1"]
	recording.FPS, recording.config = 30, config
	recording.segments = []*recordingSegment{{FirstFrameMS: 1_000_000, DurationMS: 6000, Width: 320, Height: 240, ViewportWidth: 320, ViewportHeight: 240}}
	var lines []byte
	for _, e := range journal {
		line, _ := json.Marshal(e)
		lines = append(lines, append(line, '\n')...)
	}
	if err := os.WriteFile(filepath.Join(recording.segmentDir, recordingJournalFile), lines, 0o600); err != nil {
		t.Fatal(err)
	}
	return session, recording, raw
}

func TestFinalizeEditsTheRecording(t *testing.T) {
	ffmpeg := ffmpegForTest(t)
	session, recording, raw := finalizeFixture(t, ffmpeg, recordingConfig{Idle: "cut", Ripple: true},
		entry("call", 500, 1500, nil),
		entry("press", 600, 600, map[string]any{"x": 100.0, "y": 100.0}),
		entry("caption", 700, 700, map[string]any{"text": `Hello {world} \ !`, "durationMs": 1500.0}),
		entry("focus", 800, 1800, map[string]any{"zoom": 2.0, "rect": map[string]any{"x": 100.0, "y": 100.0, "width": 40.0, "height": 40.0}}))
	// An edit published earlier is never overwritten.
	if err := os.WriteFile(filepath.Join(filepath.Dir(raw), "demo.edited.mp4"), []byte("earlier"), 0o600); err != nil {
		t.Fatal(err)
	}
	video, err := openRecordingVideo(raw)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = video.Close() }()
	edited, timeline, failure := session.finalizeRecording(context.Background(), recording, video, raw)
	if failure != nil {
		t.Fatalf("failure: %+v", failure)
	}
	if filepath.Base(edited) != "demo.edited-1.mp4" || filepath.Base(timeline) != "demo.timeline.json" {
		t.Fatalf("published %s, %s", edited, timeline)
	}
	// The picture stands still after 2 s, so the cut keeps about the first 2.3 s plus the padding of the journal.
	probe, _ := exec.Command(ffmpeg, "-hide_banner", "-i", edited).CombinedOutput()
	duration := regexp.MustCompile(`Duration: 00:00:0(\d\.\d+)`).FindStringSubmatch(string(probe))
	if duration == nil || !strings.Contains(string(probe), "h264") || duration[1] >= "4" || duration[1] < "2" {
		t.Errorf("edited video: %s", probe)
	}
	var published map[string]any
	body, _ := os.ReadFile(timeline)
	if err := json.Unmarshal(body, &published); err != nil || published["editedDurationMs"] == nil || len(published["events"].([]any)) != 4 || published["map"] == nil {
		t.Errorf("timeline: %v %s", err, body)
	}
}

func TestFinalizeFailureKeepsTheRawVideoAndSaysWhy(t *testing.T) {
	ffmpeg := ffmpegForTest(t)
	session, recording, raw := finalizeFixture(t, ffmpeg, recordingConfig{Ripple: true}, entry("press", 600, 600, map[string]any{"x": 1.0, "y": 1.0}))
	for executable, code := range map[string]string{"": "ffmpeg_unavailable", "/nonexistent/ffmpeg": "render_failed"} {
		session.runtime.values.RecordingFFmpegExecutable = executable
		video, err := openRecordingVideo(raw)
		if err != nil {
			t.Fatal(err)
		}
		edited, timeline, failure := session.finalizeRecording(context.Background(), recording, video, raw)
		_ = video.Close()
		if edited != "" || failure == nil || failure.Code != code {
			t.Errorf("%q: edited %q, failure %+v", executable, edited, failure)
		}
		// The timeline still tells what happened, without edited times.
		if body, _ := os.ReadFile(timeline); strings.Contains(string(body), "editedStartMs") || !strings.Contains(string(body), `"press"`) {
			t.Errorf("timeline: %s", body)
		}
		_ = os.Remove(timeline)
	}
	if _, err := os.Stat(raw); err != nil {
		t.Error("the raw video is gone")
	}
}

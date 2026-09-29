package browser

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
)

func yes(v bool) *bool { return &v }

// editDoc is a 10 s, 1280x720 recording with a click at (640,360) at 2 s.
func editDoc() timelineDoc {
	return timelineDoc{
		DurationMS: 10000,
		Segments:   []timelineSegmentOut{{Start: 0, End: 10000, Width: 1280, Height: 720}},
		Gestures: []timelineGesture{{
			Tool: "browser_click", Start: 1800, End: 2200, Hold: 45,
			Path:   [][3]float64{{1800, 100, 100}, {2000, 640, 360}},
			Clicks: []timelineClick{{T: 2000, X: 640, Y: 360, Button: "left", Count: 1}},
		}},
		Activity: timelineActivity{Complete: true, Spans: []timelineSpanOut{{1800, 2400}}},
	}
}

func TestEditPlanIsNilWhenNothingApplies(t *testing.T) {
	// Defaults alone apply to nothing: this click asks for no effect and the recording has none.
	plan, err := buildEditPlan(editDoc(), recordingEffects{}, 30)
	if plan != nil || err != nil {
		t.Fatalf("plan = %+v, err = %v", plan, err)
	}
	// A recording default reaches gestures that do not say otherwise, but not ones that opt out.
	fx := recordingEffects{Zoom: 2, Ripple: true}
	if plan, _ = buildEditPlan(editDoc(), fx, 30); plan == nil || !strings.Contains(plan.filter, "perspective=") || !strings.Contains(plan.filter, "geq=") {
		t.Fatalf("defaults were not applied: %+v", plan)
	}
	doc := editDoc()
	doc.Gestures[0].Zoom, doc.Gestures[0].Ripple = false, yes(false)
	if plan, err = buildEditPlan(doc, fx, 30); plan != nil || err != nil {
		t.Fatalf("a gesture that opts out still applies: %+v, %v", plan, err)
	}
}

func TestEditPlanZoomFollowsGestures(t *testing.T) {
	doc := editDoc()
	doc.Gestures[0].Zoom = float64(3)
	moved := doc.Gestures[0]
	moved.Start, moved.End = 3000, 3400
	moved.Clicks = []timelineClick{{T: 3200, X: 1100, Y: 600}}
	far := doc.Gestures[0]
	far.Start, far.End = 8000, 8400
	far.Clicks = []timelineClick{{T: 8200, X: 100, Y: 100}}
	doc.Gestures = append(doc.Gestures, moved, far)
	// A gesture without a position (made through Playwright's mouse) cannot be followed.
	doc.Gestures = append(doc.Gestures, timelineGesture{Tool: "browser_click", Zoom: true, Start: 5000, End: 5100})

	plan, err := buildEditPlan(doc, recordingEffects{}, 30)
	if err != nil {
		t.Fatal(err)
	}
	// The close pair shares one zoom; the far one has its own.
	if n := strings.Count(plan.filter, "perspective="); n != 2 {
		t.Fatalf("scenes = %d, want 2: %s", n, plan.filter)
	}
	if len(plan.warnings) != 1 || !strings.Contains(plan.warnings[0], "not followed") {
		t.Fatalf("warnings = %v", plan.warnings)
	}
}

func TestEditPlanCaptionsBurnAfterIdleIsCut(t *testing.T) {
	doc := editDoc()
	doc.Gestures = nil
	doc.Activity = timelineActivity{Complete: true}
	// Nothing happens for 6 s before the caption, so idle cut removes 5.4 s of them.
	doc.Actions = []timelineAction{{Tool: "browser_type", Start: 7000, End: 7100, Caption: "Type {a\\b}\n now"}}

	plan, err := buildEditPlan(doc, recordingEffects{Idle: "cut"}, 30)
	if err != nil {
		t.Fatal(err)
	}
	ass := string(plan.ass)
	if !strings.Contains(ass, `Type \{a＼b\} now`) {
		t.Fatalf("caption is not escaped: %s", ass)
	}
	// The first 6.7 s are cut, so the cue starts at the 300 ms that were kept.
	if !strings.Contains(ass, "Dialogue: 0,0:00:00.30,") {
		t.Fatalf("cue not mapped onto the shortened video: %s", ass)
	}
	if !strings.Contains(plan.filter, "select=") || !strings.HasSuffix(plan.filter, "ass=captions.ass") {
		t.Fatalf("filter = %s", plan.filter)
	}
}

func TestEditPlanIdleKeepsWhatIsBusy(t *testing.T) {
	// Idle stretches keep 300 ms at each end; a stretch shorter than 2.1 s between changes is left alone.
	pieces, regions := idlePieces("cut", []span{{100, 900}, {5000, 5200}}, 10000)
	if len(regions) != 2 || regions[0] != (span{1200, 4700}) || regions[1] != (span{5500, 10000}) {
		t.Fatalf("regions = %v", regions)
	}
	if got := mapTime(pieces, 5000); got != 1500 {
		t.Fatalf("5000 ms maps to %d, want 1500", got)
	}
	if _, regions = idlePieces("cut", []span{{100, 900}, {2500, 9500}}, 10000); len(regions) != 0 {
		t.Fatalf("regions = %v", regions)
	}

	doc := editDoc()
	doc.Gestures = nil
	doc.Activity = timelineActivity{Complete: true, Spans: []timelineSpanOut{{100, 900}, {5000, 5200}}}
	plan, err := buildEditPlan(doc, recordingEffects{Idle: "speed"}, 30)
	if err != nil {
		t.Fatal(err)
	}
	if n := strings.Count(plan.filter, ")/8"); n != 2 {
		t.Fatalf("sped up stretches = %d: %s", n, plan.filter)
	}
	// Screen changes that could not all be seen make no stretch known to be idle.
	doc.Activity.Complete = false
	if plan, err = buildEditPlan(doc, recordingEffects{Idle: "cut"}, 30); err != nil || plan.filter != "" || len(plan.warnings) != 1 {
		t.Fatalf("plan = %+v, err = %v", plan, err)
	}
}

func TestEditPlanRejectsFramesOfDifferentSizes(t *testing.T) {
	doc := editDoc()
	doc.Segments = append(doc.Segments, timelineSegmentOut{Start: 10000, End: 12000, Width: 800, Height: 600})
	doc.Actions = []timelineAction{{Caption: "hi", Start: 100, End: 200}}
	if _, err := buildEditPlan(doc, recordingEffects{}, 30); err == nil || !strings.Contains(err.Error(), "change size") {
		t.Fatalf("err = %v", err)
	}
}

func TestValidateRecordingEffects(t *testing.T) {
	for _, ok := range []struct {
		idle string
		zoom any
	}{{"", nil}, {"cut", true}, {"speed", false}, {"", 1.1}, {"", float64(4)}} {
		if err := ValidateRecordingEffects(ok.idle, ok.zoom, "", nil); err != nil {
			t.Errorf("%v: %v", ok, err)
		}
	}
	for _, bad := range []struct {
		idle string
		zoom any
	}{{"fast", nil}, {"", 1.0}, {"", float64(5)}, {"", "yes"}} {
		if err := ValidateRecordingEffects(bad.idle, bad.zoom, "", nil); err == nil {
			t.Errorf("%v was accepted", bad)
		}
	}
}

// The plan renders with a real ffmpeg: a clip with a caption, a rippled and zoomed
// click, and cut idle time comes out as a shorter H.264 video of the same size.
func TestRenderEditWithFFmpeg(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg is not installed")
	}
	dir := t.TempDir()
	video := filepath.Join(dir, "clip.webm")
	source := exec.Command(ffmpeg, "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=8", "-c:v", "libvpx", "-b:v", "1M", video)
	if out, err := source.CombinedOutput(); err != nil {
		t.Skipf("ffmpeg cannot make a test clip: %v: %s", err, out)
	}
	doc := timelineDoc{
		DurationMS: 8000,
		Segments:   []timelineSegmentOut{{End: 8000, Width: 640, Height: 360}},
		Actions:    []timelineAction{{Tool: "browser_click", Start: 1000, End: 1500, Caption: "Click here"}},
		Gestures: []timelineGesture{{
			Tool: "browser_click", Start: 1000, End: 1500, Zoom: true, Ripple: yes(true),
			Path:   [][3]float64{{1000, 50, 50}, {1300, 320, 180}},
			Clicks: []timelineClick{{T: 1300, X: 320, Y: 180}},
		}},
		Activity: timelineActivity{Complete: true, Spans: []timelineSpanOut{{1000, 1500}}},
	}
	plan, err := buildEditPlan(doc, recordingEffects{Idle: "cut"}, 30)
	if err != nil || plan == nil || plan.filter == "" {
		t.Fatalf("plan = %+v, err = %v", plan, err)
	}
	values := RuntimeEnvValues{RecordingFFmpegExecutable: ffmpeg, CacheDir: dir}
	edited, err := renderEdit(context.Background(), values, dir, "id", video, plan)
	if err != nil {
		t.Fatalf("%v\nfilter: %s", err, plan.filter)
	}
	if edited != video+".edited.mp4" {
		t.Fatalf("edited = %s", edited)
	}
	if _, err := os.Stat(filepath.Join(dir, ".edit-id")); !os.IsNotExist(err) {
		t.Fatalf("work directory was left behind: %v", err)
	}
	probe, err := exec.Command("ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height:format=duration", "-of", "json", edited).Output()
	if err != nil {
		t.Skipf("ffprobe: %v", err)
	}
	var info struct {
		Streams []struct {
			Codec  string `json:"codec_name"`
			Width  int    `json:"width"`
			Height int    `json:"height"`
		} `json:"streams"`
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
	}
	if err := json.Unmarshal(probe, &info); err != nil || len(info.Streams) != 1 {
		t.Fatalf("probe %s: %v", probe, err)
	}
	seconds, _ := strconv.ParseFloat(info.Format.Duration, 64)
	if s := info.Streams[0]; s.Codec != "h264" || s.Width != 640 || s.Height != 360 {
		t.Fatalf("stream = %+v", s)
	}
	// 8 s minus the idle stretch after the click and its ripple, zoom and caption windows.
	if seconds < 3 || seconds > 6 {
		t.Fatalf("duration = %.2f s, want the idle tail cut", seconds)
	}
}

func TestBurstPiecesKeepTheTimeAroundActions(t *testing.T) {
	burst := RecordingBurst{LeadMs: 400, TailMs: 600, SettleMs: 500, MaxTailMs: 4000}
	spans := func(times ...int64) (out []span) {
		for i := 0; i < len(times); i += 2 {
			out = append(out, span{times[i], times[i+1]})
		}
		return out
	}
	action := func(start, end int64) timelineAction { return timelineAction{Start: start, End: end} }
	for _, c := range []struct {
		name     string
		actions  []timelineAction
		hold     int64 // hold of a gesture that starts with the first action
		activity []span
		complete bool
		want     []piece
	}{
		{"lead and tail", []timelineAction{action(5000, 5200)}, 0, nil, true, []piece{{4600, 5800, 1}}},
		{"hold outlasts the tail", []timelineAction{action(5000, 5200)}, 1500, nil, true, []piece{{4600, 6700, 1}}},
		{"the tail waits for the screen to settle", []timelineAction{action(5000, 5200)}, 0, spans(5300, 6400, 6600, 6900), true, []piece{{4600, 7400, 1}}},
		{"a screen that never settles is cut at maxTail", []timelineAction{action(5000, 5200)}, 0, spans(5300, 20000), true, []piece{{4600, 9200, 1}}},
		{"unknown activity means the plain tail", []timelineAction{action(5000, 5200)}, 0, spans(5300, 20000), false, []piece{{4600, 5800, 1}}},
		{"clamped to the video", []timelineAction{action(100, 200), action(9800, 9900)}, 0, nil, true, []piece{{0, 800, 1}, {9400, 10000, 1}}},
		{"overlapping and touching pieces merge", []timelineAction{action(2000, 2100), action(2900, 3000), action(3800, 3900), action(6000, 6100)}, 0, nil, true,
			[]piece{{1600, 4500, 1}, {5600, 6700, 1}}},
	} {
		doc := timelineDoc{DurationMS: 10000, Actions: c.actions}
		if c.hold > 0 {
			doc.Gestures = []timelineGesture{{Start: c.actions[0].Start + 100, End: c.actions[0].End, Hold: c.hold}}
		}
		if got := burstPieces(doc, burst, c.activity, c.complete); !slices.Equal(got, c.want) {
			t.Errorf("%s: pieces = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestEditPlanBurstsCutEverythingElse(t *testing.T) {
	doc := editDoc()
	doc.Actions = []timelineAction{{Tool: "browser_click", Start: 1800, End: 2200, Caption: "Click"}}
	burst := RecordingBurst{}.withDefaults()
	plan, err := buildEditPlan(doc, recordingEffects{Burst: &burst, Zoom: 2}, 30)
	if err != nil {
		t.Fatal(err)
	}
	// One kept stretch: 1400 to 2900 (activity ends at 2400, settles 500 ms later), which
	// the time map moves to the start; zoom is rendered before the cut, captions after.
	for _, want := range []string{"perspective=", "select='gte(t,1.3833)*lt(t,2.8833)'", "setpts='((min(max(T,1.400),2.900)-1.400))/TB'"} {
		if !strings.Contains(plan.filter, want) {
			t.Errorf("filter lacks %q: %s", want, plan.filter)
		}
	}
	if i, j := strings.Index(plan.filter, "perspective="), strings.Index(plan.filter, "select="); i > j || !strings.Contains(string(plan.ass), "0:00:00.40,0:00:01.50") {
		t.Errorf("effects and captions are not around the cut: %s\n%s", plan.filter, plan.ass)
	}
	doc.Actions = nil
	if _, err := buildEditPlan(doc, recordingEffects{Burst: &burst}, 30); err == nil || !strings.Contains(err.Error(), "has none") {
		t.Errorf("a recording without actions: err = %v", err)
	}
}

func TestValidateBursts(t *testing.T) {
	for _, c := range []struct {
		idle, capture string
		burst         *RecordingBurst
		want          string // a part of the error, or empty for none
	}{
		{"", "", nil, ""},
		{"cut", "continuous", nil, ""},
		{"", "bursts", &RecordingBurst{LeadMs: 0, TailMs: 1000, MaxTailMs: 1000}, ""},
		{"cut", "bursts", nil, "idle cannot be combined"},
		{"", "bursts", &RecordingBurst{TailMs: 5000}, "maxTailMs must not be less"},
		{"", "bursts", &RecordingBurst{LeadMs: -1}, "0 to"},
		{"", "continuous", &RecordingBurst{}, "needs capture"},
		{"", "clips", nil, "capture must be"},
	} {
		err := ValidateRecordingEffects(c.idle, nil, c.capture, c.burst)
		if (err == nil) != (c.want == "") || (err != nil && !strings.Contains(err.Error(), c.want)) {
			t.Errorf("%+v: err = %v, want %q", c, err, c.want)
		}
	}
}

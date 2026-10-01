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
	fx := recordingEffects{Ripple: true}
	if plan, _ = buildEditPlan(editDoc(), fx, 30); plan == nil || !strings.Contains(plan.filter, "geq=") {
		t.Fatalf("defaults were not applied: %+v", plan)
	}
	doc := editDoc()
	doc.Gestures[0].Ripple = yes(false)
	if plan, err = buildEditPlan(doc, fx, 30); plan != nil || err != nil {
		t.Fatalf("a gesture that opts out still applies: %+v, %v", plan, err)
	}
}

func TestEditPlanZoomFollowsExplicitFocus(t *testing.T) {
	doc := editDoc()
	doc.Focuses = []timelineFocus{
		{Start: 1000, End: 3000, X: 500, Y: 250, Width: 200, Height: 100, Zoom: 2},
		{Start: 6000, End: 8500, X: 50, Y: 50, Width: 200, Height: 100, Zoom: 3},
	}

	plan, err := buildEditPlan(doc, recordingEffects{}, 30)
	if err != nil {
		t.Fatal(err)
	}
	if n := strings.Count(plan.filter, "perspective="); n != 2 {
		t.Fatalf("scenes = %d, want 2: %s", n, plan.filter)
	}
}

func TestEditPlanCaptionsBurnAfterIdleIsCut(t *testing.T) {
	doc := editDoc()
	doc.Gestures = nil
	doc.Activity = timelineActivity{Complete: true}
	// Nothing happens for 6 s before the caption, so idle cut removes 5.4 s of them.
	doc.Actions = []timelineAction{{Tool: "browser_type", Start: 7000, End: 7100, Caption: "Type {a\\b}\n now", OK: true}}

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
	if pieces, regions = idlePieces("cut", nil, 10000); !slices.Equal(pieces, []piece{{0, 300, 1}, {9700, 10000, 1}}) ||
		!slices.Equal(regions, []span{{300, 9700}}) {
		t.Fatalf("static recording: pieces = %v, regions = %v", pieces, regions)
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

func TestValidateRecordingEffects(t *testing.T) {
	if ValidateRecordingEffects("fast", "", nil) == nil {
		t.Error("idle fast was accepted")
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
		Actions:    []timelineAction{{Tool: "browser_click", Start: 1000, End: 1500, Caption: "Click here", OK: true}},
		Gestures: []timelineGesture{{
			Tool: "browser_click", Start: 1000, End: 1500, Ripple: yes(true),
			Path:   [][3]float64{{1000, 50, 50}, {1300, 320, 180}},
			Clicks: []timelineClick{{T: 1300, X: 320, Y: 180}},
		}},
		Focuses:  []timelineFocus{{Start: 1000, End: 1500, X: 270, Y: 130, Width: 100, Height: 100, Zoom: 2}},
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
	if seconds < 2 || seconds > 4 {
		t.Fatalf("duration = %.2f s, want the idle tail cut", seconds)
	}
}

func TestBurstPiecesKeepTheTimeAroundActions(t *testing.T) {
	spans := func(times ...int64) (out []timelineSpanOut) {
		for i := 0; i < len(times); i += 2 {
			out = append(out, timelineSpanOut{times[i], times[i+1]})
		}
		return out
	}
	action := func(start, end int64) timelineAction { return timelineAction{Start: start, End: end, OK: true} }
	for _, c := range []struct {
		name     string
		actions  []timelineAction
		activity []timelineSpanOut
		complete bool
		gap      int64
		want     []piece
	}{
		{"lead and tail", []timelineAction{action(5000, 5200)}, nil, true, 0, []piece{{4850, 5450, 1}}},
		{"the tail waits for the screen to settle", []timelineAction{action(5000, 5200)}, spans(5300, 6400, 6600, 6900), true, 0, []piece{{4850, 6400, 1}}},
		{"a screen that never settles is cut at maxTail", []timelineAction{action(5000, 5200)}, spans(5300, 20000), true, 0, []piece{{4850, 6400, 1}}},
		{"unknown activity means the plain tail", []timelineAction{action(5000, 5200)}, spans(5300, 20000), false, 0, []piece{{4850, 5450, 1}}},
		{"clamped to the video", []timelineAction{action(100, 200), action(9800, 9900)}, nil, true, 0, []piece{{0, 450, 1}, {9650, 10000, 1}}},
		{"overlapping and touching pieces merge", []timelineAction{action(2000, 2100), action(2300, 2400), action(2600, 2700), action(6000, 6100)}, nil, true, 0,
			[]piece{{1850, 2950, 1}, {5850, 6350, 1}}},
		{"a gap joins pieces that are near", []timelineAction{action(2000, 2100), action(2700, 2800), action(6000, 6100)}, nil, true, 500,
			[]piece{{1850, 3050, 1}, {5850, 6350, 1}}},
		{"failed calls are omitted", []timelineAction{{Start: 2000, End: 7000}, action(8000, 8100)}, nil, true, 0,
			[]piece{{7850, 8350, 1}}},
	} {
		doc := timelineDoc{DurationMS: 10000, Actions: c.actions, Activity: timelineActivity{Complete: c.complete, Spans: c.activity}}
		if got := burstPieces(doc, RecordingBurst{}, c.gap); !slices.Equal(got, c.want) {
			t.Errorf("%s: pieces = %v, want %v", c.name, got, c.want)
		}
	}
	// A tail longer than the default cap raises it, and 0 is a setting of its own.
	one, five := 1000, 5000
	doc := timelineDoc{DurationMS: 10000, Actions: []timelineAction{action(2000, 2100)}}
	if got := burstPieces(doc, RecordingBurst{TailMs: &five}, 0); !slices.Equal(got, []piece{{1850, 7100, 1}}) {
		t.Errorf("tail 5000: pieces = %v", got)
	}
	zero := 0
	if got := burstPieces(doc, RecordingBurst{LeadMs: &zero, TailMs: &one}, 0); !slices.Equal(got, []piece{{2000, 3100, 1}}) {
		t.Errorf("lead 0: pieces = %v", got)
	}
}

func TestEditPlanBurstsCutEverythingElse(t *testing.T) {
	doc := editDoc()
	doc.Actions = []timelineAction{{Tool: "browser_click", Start: 1800, End: 2200, Caption: "Click", OK: true}}
	burst := RecordingBurst{}
	doc.Focuses = []timelineFocus{{Start: 1800, End: 2200, X: 560, Y: 300, Width: 160, Height: 120, Zoom: 2}}
	plan, err := buildEditPlan(doc, recordingEffects{Burst: &burst}, 30)
	if err != nil {
		t.Fatal(err)
	}
	// One kept stretch: 1650 to 3000. Activity settles at 2600, but the caption lasts
	// until 3000, so the cut preserves it before mapping the effects into edited time.
	for _, want := range []string{"perspective=", "select='gte(t,1.6333)*lt(t,2.9833)'", "setpts='((min(max(T,1.650),3.000)-1.650))/TB'"} {
		if !strings.Contains(plan.filter, want) {
			t.Errorf("filter lacks %q: %s", want, plan.filter)
		}
	}
	if i, j := strings.Index(plan.filter, "perspective="), strings.Index(plan.filter, "select="); i < j || !strings.Contains(string(plan.ass), "0:00:00.15,0:00:01.35") {
		t.Errorf("effects and captions are not around the cut: %s\n%s", plan.filter, plan.ass)
	}
	doc.Actions = append(doc.Actions, timelineAction{Tool: "browser_click", Start: 5000, End: 9000, Caption: "Failed"})
	if plan, err = buildEditPlan(doc, recordingEffects{Burst: &burst}, 30); err != nil || len(plan.warnings) != 1 ||
		!strings.Contains(plan.warnings[0], "1 failed browser tool call was omitted") || strings.Contains(string(plan.ass), "Failed") {
		t.Errorf("failed action was presented: plan = %+v, err = %v", plan, err)
	}
	// Far more pieces than a command line holds are joined, never dropped.
	doc.Actions = nil
	for i := range 1900 {
		doc.Actions = append(doc.Actions, timelineAction{Start: int64(i) * 2000, End: int64(i)*2000 + 10, OK: true})
	}
	doc.DurationMS = 4_000_000
	doc.Activity.Spans = nil
	if plan, err = buildEditPlan(doc, recordingEffects{Burst: &burst}, 30); err != nil || len(plan.filter) > editMaxFilterBytes || len(plan.warnings) != 1 {
		t.Errorf("many bursts: err = %v, %d warnings", err, len(plan.warnings))
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
		{"", "bursts", &RecordingBurst{LeadMs: ptr(0), TailMs: ptr(1000), MaxTailMs: ptr(1000)}, ""},
		{"", "bursts", &RecordingBurst{TailMs: ptr(5000)}, ""},
		{"cut", "bursts", nil, "idle cannot be combined"},
		{"", "bursts", &RecordingBurst{TailMs: ptr(5000), MaxTailMs: ptr(4000)}, "maxTailMs must not be less"},
		{"", "bursts", &RecordingBurst{LeadMs: ptr(-1)}, "0 to"},
		{"", "continuous", &RecordingBurst{}, "needs capture"},
		{"", "clips", nil, "capture must be"},
	} {
		err := ValidateRecordingEffects(c.idle, c.capture, c.burst)
		if (err == nil) != (c.want == "") || (err != nil && !strings.Contains(err.Error(), c.want)) {
			t.Errorf("%+v: err = %v, want %q", c, err, c.want)
		}
	}
}

func ptr(v int) *int { return &v }

package browser

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/aperture/aperture/internal/recording/edit"
	"github.com/aperture/aperture/internal/recording/timeline"
)

func zoomArg(level float64) *edit.Zoom {
	zoom := edit.Zoom(level)
	return &zoom
}

func boolArg(value bool) *bool { return &value }

func TestRecordingEffectsRequestValidates(t *testing.T) {
	for _, idle := range []string{"", "speed", "cut"} {
		if _, err := (recordingEffectsRequest{Idle: idle}).resolve(wrapperRecordingCaptureContinuous); err != nil {
			t.Errorf("idle %q: %v", idle, err)
		}
	}
	if _, err := (recordingEffectsRequest{Idle: "fast"}).resolve(wrapperRecordingCaptureContinuous); err == nil {
		t.Error("an unknown idle mode is refused")
	}
	effects, err := recordingEffectsRequest{Idle: "cut", Ripple: boolArg(true), Zoom: zoomArg(2.5)}.resolve(wrapperRecordingCaptureContinuous)
	if err != nil || effects.idle != "cut" || !effects.ripple || effects.zoom != 2.5 {
		t.Errorf("effects %+v err %v", effects, err)
	}
	if effects, _ := (recordingEffectsRequest{Zoom: zoomArg(0)}).resolve(wrapperRecordingCaptureContinuous); effects.any() {
		t.Errorf("zoom false is off: %+v", effects)
	}
	if (recordingEffects{}).timelineOptions() != nil {
		t.Error("no effects leave the timeline without options")
	}
	if options := (recordingEffects{idle: "speed", zoom: 1.6}).timelineOptions(); options == nil || options.Idle != "speed" || options.Zoom != 1.6 || options.Ripple {
		t.Errorf("options %+v", options)
	}
}

func TestRecordingEffectsRequestDecodesFromTheStartBody(t *testing.T) {
	var request wrapperRecordingRequest
	body := `{"mode":"tab","targetId":"t","fps":30,"idle":"speed","ripple":true,"zoom":true}`
	if err := json.Unmarshal([]byte(body), &request); err != nil {
		t.Fatal(err)
	}
	effects, err := request.resolve(wrapperRecordingCaptureContinuous)
	if err != nil || effects.idle != "speed" || !effects.ripple || effects.zoom != edit.DefaultZoomLevel {
		t.Errorf("effects %+v err %v", effects, err)
	}
	if err := json.Unmarshal([]byte(`{"zoom": 9}`), &request); err == nil {
		t.Error("a magnification out of range is refused")
	}
}

func TestRecordingEffectsResolveGestures(t *testing.T) {
	defaults := recordingEffects{ripple: true, zoom: 1.6}
	for _, test := range []struct {
		name       string
		effects    recordingEffects
		record     pointerGestureRecord
		wantZoom   float64
		wantRipple bool
	}{
		{"click takes the defaults", defaults, pointerGestureRecord{Kind: pointerGestureClick}, 1.6, true},
		{"drag takes the zoom default", defaults, pointerGestureRecord{Kind: pointerGestureDrag}, 1.6, false},
		{"scroll takes the zoom default", defaults, pointerGestureRecord{Kind: pointerGestureScroll}, 1.6, false},
		{"a move only zooms when it asks", defaults, pointerGestureRecord{Kind: pointerGestureMove}, 0, false},
		{"a move that asks", defaults, pointerGestureRecord{Kind: pointerGestureMove, Zoom: zoomArg(2)}, 2, false},
		{"zoom false overrides the default", defaults, pointerGestureRecord{Kind: pointerGestureClick, Zoom: zoomArg(0)}, 0, true},
		{"its own level", defaults, pointerGestureRecord{Kind: pointerGestureClick, Zoom: zoomArg(3)}, 3, true},
		{"ripple false overrides the default", defaults, pointerGestureRecord{Kind: pointerGestureClick, Ripple: boolArg(false)}, 1.6, false},
		{"ripple when the recording does not", recordingEffects{}, pointerGestureRecord{Kind: pointerGestureClick, Ripple: boolArg(true)}, 0, true},
		{"only clicks ripple", recordingEffects{}, pointerGestureRecord{Kind: pointerGestureDrag, Ripple: boolArg(true)}, 0, false},
		{"nothing without defaults", recordingEffects{}, pointerGestureRecord{Kind: pointerGestureClick}, 0, false},
		{"a scroll's own zoom", recordingEffects{}, pointerGestureRecord{Kind: pointerGestureScroll, Zoom: zoomArg(1.8)}, 1.8, false},
	} {
		zoom, ripple := test.effects.gesture(test.record)
		if zoom != test.wantZoom || ripple != test.wantRipple {
			t.Errorf("%s: zoom %v ripple %v, want %v %v", test.name, zoom, ripple, test.wantZoom, test.wantRipple)
		}
	}
}

func TestParsePointerGestureTakesZoomAndRipple(t *testing.T) {
	spec, err := parsePointerGesture(pointerToolClick, json.RawMessage(`{"x": 1, "y": 2, "zoom": true, "ripple": false}`))
	if err != nil {
		t.Fatal(err)
	}
	if spec.Zoom == nil || *spec.Zoom != edit.DefaultZoomLevel || spec.Ripple == nil || *spec.Ripple {
		t.Errorf("spec %+v", spec)
	}
	spec, err = parsePointerGesture(pointerToolScroll, json.RawMessage(`{"deltaY": 200, "zoom": 2.5}`))
	if err != nil || spec.Zoom == nil || *spec.Zoom != 2.5 {
		t.Errorf("spec %+v err %v", spec, err)
	}
	spec, err = parsePointerGesture(pointerToolMove, json.RawMessage(`{"x": 1, "y": 2, "zoom": false}`))
	if err != nil || spec.Zoom == nil || *spec.Zoom != 0 {
		t.Errorf("spec %+v err %v", spec, err)
	}
	spec, err = parsePointerGesture(pointerToolDrag, json.RawMessage(`{"startX": 1, "startY": 2, "endX": 5, "endY": 6, "zoom": 1.2}`))
	if err != nil || spec.Zoom == nil || *spec.Zoom != 1.2 {
		t.Errorf("spec %+v err %v", spec, err)
	}
	spec, err = parsePointerGesture(pointerToolClick, json.RawMessage(`{"x": 1, "y": 2}`))
	if err != nil || spec.Zoom != nil || spec.Ripple != nil {
		t.Errorf("effects left out stay unset: %+v err %v", spec, err)
	}
	for name, args := range map[string]string{
		"zoom too small":     `{"x": 1, "y": 2, "zoom": 1}`,
		"zoom too large":     `{"x": 1, "y": 2, "zoom": 5}`,
		"zoom a string":      `{"x": 1, "y": 2, "zoom": "yes"}`,
		"ripple not boolean": `{"x": 1, "y": 2, "ripple": 1}`,
	} {
		if _, err := parsePointerGesture(pointerToolClick, json.RawMessage(args)); err == nil {
			t.Errorf("%s should be refused", name)
		}
	}
	// Only a click ripples.
	if _, err := parsePointerGesture(pointerToolMove, json.RawMessage(`{"x": 1, "y": 2, "ripple": true}`)); err == nil {
		t.Error("browser_move takes no ripple")
	}
	if _, err := parsePointerGesture(pointerToolDrag, json.RawMessage(`{"startX": 1, "startY": 2, "endX": 5, "endY": 6, "ripple": true}`)); err == nil {
		t.Error("browser_drag takes no ripple")
	}
}

func TestPointerRecordsCarryTheirEffects(t *testing.T) {
	spec := pointerGestureSpec{Tool: pointerToolClick, Kind: pointerGestureClick, Zoom: zoomArg(2), Ripple: boolArg(true), Caption: "c"}
	record := pointerCDPRecord(spec, pointerScrollContext{}, nil, time.Now(), time.Now())
	if record.Zoom == nil || *record.Zoom != 2 || record.Ripple == nil || !*record.Ripple {
		t.Errorf("record %+v", record)
	}
}

func TestToolCaptionsReachRecordingsOfSuccessfulCallsOnly(t *testing.T) {
	var runtime wrapperRuntime
	var got []toolCaptionRecord
	stop := runtime.captions.observe(func(record toolCaptionRecord) { got = append(got, record) })
	started := time.Now().Add(-time.Second)
	ok := &mcp.CallToolResult{}
	failed := &mcp.CallToolResult{IsError: true}

	runtime.noteToolCaption(playwrightCallRequest{Name: "browser_type", Caption: "Type a name"}, started, ok, nil)
	runtime.noteToolCaption(playwrightCallRequest{Name: "browser_type", Caption: "  "}, started, ok, nil)
	runtime.noteToolCaption(playwrightCallRequest{Name: "browser_type"}, started, ok, nil)
	runtime.noteToolCaption(playwrightCallRequest{Name: "browser_navigate", Caption: "failed"}, started, failed, nil)
	runtime.noteToolCaption(playwrightCallRequest{Name: "browser_navigate", Caption: "errored"}, started, nil, errors.New("boom"))
	stop()
	runtime.noteToolCaption(playwrightCallRequest{Name: "browser_type", Caption: "after stop"}, started, ok, nil)

	if len(got) != 1 || got[0].Tool != "browser_type" || got[0].Text != "Type a name" || !got[0].Start.Equal(started) || !got[0].End.After(started) {
		t.Fatalf("captions %+v", got)
	}
}

func TestValidateToolCaption(t *testing.T) {
	if err := validateToolCaption(strings.Repeat("é", edit.MaxCaptionLength)); err != nil {
		t.Errorf("500 characters are allowed: %v", err)
	}
	if err := validateToolCaption(strings.Repeat("é", edit.MaxCaptionLength+1)); err == nil {
		t.Error("501 characters are not")
	}
}

func TestPlaywrightCallRejectsALongCaption(t *testing.T) {
	runtime := &wrapperRuntime{values: RuntimeEnvValues{WrapperControlToken: "token"}, playwright: &playwrightMCPBackend{}}
	body := `{"name":"browser_navigate","arguments":{"url":"http://x"},"caption":"` + strings.Repeat("x", edit.MaxCaptionLength+1) + `"}`
	request := httptest.NewRequest(http.MethodPost, "/automation/playwright", strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	runtime.handlePlaywrightCall(recorder, request)
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "caption") {
		t.Errorf("status %d body %s", recorder.Code, recorder.Body.String())
	}
}

// A recording started with effects resolves each gesture against them and keeps
// captions from tools other than the pointer tools, in its timeline.
func TestRecordingTimelineCollectsEffectsAndToolCaptions(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runtime := &wrapperRuntime{ctx: ctx}
	target := wrapperTargetSnapshot{
		TargetID: "t", CaptureID: "c",
		Viewport: compositorViewport{Width: 1280, Height: 720, ContentWidth: 1280, ContentHeight: 720, CanvasWidth: 1280, CanvasHeight: 720},
	}
	started := time.Now().Add(-10 * time.Second)
	collector := runtime.newRecordingTimeline(target, newScreencastProbe(30), started, recordingEffects{idle: "speed", ripple: true, zoom: 1.6})

	begin := started.Add(2 * time.Second)
	runtime.pointer.record(pointerGestureRecord{
		Kind: pointerGestureClick, Tool: "browser_click", Mode: pointerModeCompositor, TargetID: "t", Start: begin, End: begin.Add(300 * time.Millisecond),
		Path:    []pointerPathPoint{{X: 1, Y: 2}, {Offset: 300 * time.Millisecond, X: 400, Y: 300}},
		Clicks:  []pointerClickPoint{{At: begin.Add(250 * time.Millisecond), X: 400, Y: 300, Button: "left", Count: 1}},
		Caption: "Click it",
	})
	runtime.pointer.record(pointerGestureRecord{Kind: pointerGestureMove, Tool: "browser_move", Mode: pointerModeCompositor, TargetID: "t", Start: begin.Add(time.Second), End: begin.Add(1500 * time.Millisecond), Zoom: zoomArg(2)})
	runtime.pointer.record(pointerGestureRecord{Kind: pointerGestureDrag, Tool: "browser_drag", Mode: pointerModeCompositor, TargetID: "t", Start: begin.Add(2 * time.Second), End: begin.Add(3 * time.Second), Ripple: boolArg(true), Zoom: zoomArg(0)})
	runtime.noteToolCaption(playwrightCallRequest{Name: "browser_navigate", Caption: "Go there"}, begin.Add(4*time.Second), &mcp.CallToolResult{}, nil)
	collector.stop()

	built, err := collector.builder.Build(timeline.BuildOptions{
		Recording: timeline.Recording{ID: "r", Video: "recordings/r.webm", Mode: "tab", Codec: "vp8", FPS: 30, Edit: recordingEffects{idle: "speed", ripple: true, zoom: 1.6}.timelineOptions()},
		End:       started.Add(9 * time.Second),
	})
	if err != nil {
		t.Fatal(err)
	}
	if built.Recording.Edit == nil || built.Recording.Edit.Idle != "speed" || !built.Recording.Edit.Ripple {
		t.Errorf("edit options %+v", built.Recording.Edit)
	}
	if len(built.Gestures) != 3 {
		t.Fatalf("gestures %+v", built.Gestures)
	}
	click, move, drag := built.Gestures[0], built.Gestures[1], built.Gestures[2]
	if click.Zoom != 1.6 || !click.Ripple {
		t.Errorf("a click takes the recording's defaults: %+v", click)
	}
	if move.Zoom != 2 || move.Ripple {
		t.Errorf("a move zooms only as asked: %+v", move)
	}
	if drag.Zoom != 0 || drag.Ripple {
		t.Errorf("zoom false turns the default off and a drag never ripples: %+v", drag)
	}
	if len(built.Captions) != 2 || built.Captions[0].Text != "Click it" || built.Captions[0].Gesture == 0 ||
		built.Captions[1].Text != "Go there" || built.Captions[1].Tool != "browser_navigate" || built.Captions[1].Gesture != 0 {
		t.Errorf("captions %+v", built.Captions)
	}
	if got := built.Captions[1].StartMs; got < 5900 || got > 6100 {
		t.Errorf("the tool caption starts when the call did: %d ms", got)
	}
}

func TestRecordingEffectsRefuseIdleForBursts(t *testing.T) {
	if _, err := (recordingEffectsRequest{Idle: "speed"}).resolve(wrapperRecordingCaptureBursts); err == nil || !strings.Contains(err.Error(), "already skip idle time") {
		t.Errorf("idle with bursts: %v", err)
	}
	if _, err := (recordingEffectsRequest{Ripple: boolArg(true), Zoom: zoomArg(2)}).resolve(wrapperRecordingCaptureBursts); err != nil {
		t.Errorf("other effects with bursts: %v", err)
	}
}

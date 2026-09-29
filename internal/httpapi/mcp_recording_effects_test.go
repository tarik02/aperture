package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"

	"github.com/aperture/aperture/internal/playwrightmcp"
	"github.com/aperture/aperture/internal/recording/edit"
)

func TestPlaywrightCaptionToolsAreRealTools(t *testing.T) {
	metadata, err := playwrightmcp.MetadataFromEmbedded()
	if err != nil {
		t.Fatal(err)
	}
	for name, tool := range metadata.Tools {
		if !takesProxiedCaption(name) {
			continue
		}
		if _, taken := tool.InputSchema["properties"].(map[string]any)["caption"]; taken {
			t.Errorf("%s already has a caption parameter", name)
		}
	}
	// A tool that only reads the page has nothing to caption.
	for _, name := range []string{"browser_snapshot", "browser_take_screenshot", "browser_console_messages", "browser_network_requests", "browser_cookie_list", "browser_find"} {
		if takesProxiedCaption(name) {
			t.Errorf("%s reads and does not change the page", name)
		}
	}
}

func TestMCPCaptionIsAddedToPageChangingToolsOnly(t *testing.T) {
	for _, pathBound := range []bool{true, false} {
		tools := listMCPTools(t, mcpAuth{profiles: []string{"core", "vision", "network", "storage"}, sessionID: "session-1", sessionOnly: true, pathBound: pathBound})
		for name, tool := range tools {
			if !takesProxiedCaption(name) {
				continue
			}
			caption, ok := schemaProperties(t, tool)["caption"].(map[string]any)
			if !ok || caption["type"] != "string" || caption["maxLength"] != float64(edit.MaxCaptionLength) {
				t.Errorf("pathBound=%t: %s caption %v", pathBound, name, caption)
			}
		}
		for _, name := range []string{"browser_navigate", "browser_type", "browser_navigate_back", "browser_wait_for"} {
			if tools[name] == nil {
				t.Errorf("pathBound=%t: %s is missing", pathBound, name)
			}
		}
		for name, tool := range tools {
			if takesProxiedCaption(name) || isPointerTool(name) {
				continue
			}
			if _, ok := schemaProperties(t, tool)["caption"]; ok && strings.HasPrefix(name, "browser_") {
				t.Errorf("pathBound=%t: %s takes a caption though it does not change the page", pathBound, name)
			}
		}
	}
}

func TestMCPPointerToolsTakeZoomAndRipple(t *testing.T) {
	tools := listMCPTools(t, mcpAuth{profiles: []string{"core"}, sessionID: "session-1", sessionOnly: true, pathBound: true})
	for _, name := range []string{"browser_click", "browser_move", "browser_drag", "browser_scroll"} {
		properties := schemaProperties(t, tools[name])
		zoom, ok := properties["zoom"].(map[string]any)
		if !ok {
			t.Fatalf("%s has no zoom", name)
		}
		options, _ := zoom["oneOf"].([]any)
		if len(options) != 2 {
			t.Errorf("%s zoom %v", name, zoom)
		}
		_, hasRipple := properties["ripple"]
		if want := name == "browser_click"; hasRipple != want {
			t.Errorf("%s has ripple = %t, want %t", name, hasRipple, want)
		}
	}
}

func TestPlaywrightToolCaptionIsTakenOutOfTheArguments(t *testing.T) {
	arguments := map[string]any{"url": "http://x", "caption": "Go there"}
	caption, err := playwrightToolCaption("browser_navigate", arguments)
	if err != nil || caption != "Go there" {
		t.Fatalf("caption %q err %v", caption, err)
	}
	if _, left := arguments["caption"]; left || arguments["url"] != "http://x" {
		t.Errorf("arguments %v", arguments)
	}
	if caption, err := playwrightToolCaption("browser_navigate", map[string]any{"url": "x"}); err != nil || caption != "" {
		t.Errorf("no caption: %q %v", caption, err)
	}
	// A tool that does not take captions keeps whatever it is given, for Playwright to judge.
	other := map[string]any{"caption": "x"}
	if caption, err := playwrightToolCaption("browser_snapshot", other); err != nil || caption != "" || other["caption"] != "x" {
		t.Errorf("snapshot: %q %v %v", caption, err, other)
	}
	if _, err := playwrightToolCaption("browser_type", map[string]any{"caption": 7}); err == nil {
		t.Error("a caption must be text")
	}
	if _, err := playwrightToolCaption("browser_type", map[string]any{"caption": strings.Repeat("é", edit.MaxCaptionLength+1)}); err == nil {
		t.Error("a caption is at most 500 characters")
	}
	if _, err := playwrightToolCaption("browser_type", map[string]any{"caption": strings.Repeat("é", edit.MaxCaptionLength)}); err != nil {
		t.Errorf("500 characters are allowed: %v", err)
	}
}

func TestCaptionTravelsBesideTheArgumentsToTheWrapper(t *testing.T) {
	var received map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &received)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"ok"}]}`))
	}))
	defer server.Close()
	address, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	port, _ := strconv.Atoi(address.Port())
	if _, err := callPlaywrightCaptioned(context.Background(), port, "token", "browser_navigate", "Go there", map[string]any{"url": "http://x"}, 1<<20); err != nil {
		t.Fatal(err)
	}
	if received["caption"] != "Go there" || received["name"] != "browser_navigate" || received["arguments"].(map[string]any)["url"] != "http://x" {
		t.Errorf("request %v", received)
	}
	received = nil
	if _, err := callPlaywrightCaptioned(context.Background(), port, "token", "browser_navigate", "", map[string]any{}, 1<<20); err != nil {
		t.Fatal(err)
	}
	if _, has := received["caption"]; has {
		t.Errorf("without a caption none is sent: %v", received)
	}
}

func TestRecordingStartTakesEffects(t *testing.T) {
	for _, pathBound := range []bool{true, false} {
		tools := listMCPTools(t, mcpAuth{profiles: []string{"core"}, sessionID: "session-1", tenantID: "tenant", sessionOnly: pathBound, pathBound: pathBound, principal: nil})
		tool := tools["recording.start"]
		if tool == nil {
			t.Fatalf("pathBound=%t: recording.start is missing", pathBound)
		}
		properties := schemaProperties(t, tool)
		for _, name := range []string{"targetId", "fps", "bitrateKbps", "codec", "idle", "ripple", "zoom"} {
			if _, ok := properties[name]; !ok {
				t.Errorf("pathBound=%t: recording.start lacks %s", pathBound, name)
			}
		}
		idle := properties["idle"].(map[string]any)
		if values, _ := idle["enum"].([]any); len(values) != 2 {
			t.Errorf("idle %v", idle)
		}
		if !strings.Contains(tool.Description, "edited video") {
			t.Errorf("description %q", tool.Description)
		}
		if tools["recording.stop"] == nil || !strings.Contains(tools["recording.stop"].Description, "editedRelativePath") {
			t.Errorf("pathBound=%t: recording.stop should say it renders", pathBound)
		}
	}
}

func TestRecordingEffectsRequestValidation(t *testing.T) {
	var request recordingEffectsRequest
	if err := json.Unmarshal([]byte(`{"idle":"speed","ripple":true,"zoom":2}`), &request); err != nil {
		t.Fatal(err)
	}
	if err := request.validate(); err != nil || request.Zoom == nil || *request.Zoom != 2 || request.Ripple == nil || !*request.Ripple {
		t.Errorf("request %+v err %v", request, err)
	}
	if err := (recordingEffectsRequest{Idle: "hover"}).validate(); err == nil {
		t.Error("an unknown idle mode is refused")
	}
	if err := json.Unmarshal([]byte(`{"zoom": 12}`), &request); err == nil {
		t.Error("an out of range zoom is refused")
	}
	fields := map[string]any{}
	trueValue, zoom := true, edit.Zoom(1.6)
	recordingEffectsRequest{Idle: "cut", Ripple: &trueValue, Zoom: &zoom}.wrapperFields(fields)
	encoded, _ := json.Marshal(fields)
	if string(encoded) != `{"idle":"cut","ripple":true,"zoom":1.6}` {
		t.Errorf("wrapper fields %s", encoded)
	}
	fields = map[string]any{}
	recordingEffectsRequest{}.wrapperFields(fields)
	if len(fields) != 0 {
		t.Errorf("a recording without effects sends none: %v", fields)
	}
}

func TestCreateSessionRecordingRequestValidatesEffects(t *testing.T) {
	ok := createSessionRecordingRequest{TargetID: "t", recordingEffectsRequest: recordingEffectsRequest{Idle: "speed"}}
	if err := ok.Validate(); err != nil {
		t.Errorf("valid: %v", err)
	}
	bad := createSessionRecordingRequest{TargetID: "t", recordingEffectsRequest: recordingEffectsRequest{Idle: "loud"}}
	if err := bad.Validate(); err == nil {
		t.Error("a bad idle mode is refused")
	}
	var decoded createSessionRecordingRequest
	if err := json.Unmarshal([]byte(`{"targetId":"t","zoom":true,"ripple":false}`), &decoded); err != nil || decoded.Zoom == nil || *decoded.Zoom != edit.DefaultZoomLevel {
		t.Errorf("decoded %+v err %v", decoded, err)
	}
}

func TestRecordingEditedRelativePathIsChecked(t *testing.T) {
	for path, ok := range map[string]bool{
		"":                                  true,
		"recordings/recording-a.edited.mp4": true,
		"recordings/demo/x.edited-1.mp4":    true,
		"../secret.mp4":                     false,
		"uploads/x.mp4":                     false,
		"recordings/x.webm":                 false,
		"/etc/x.mp4":                        false,
	} {
		got, err := recordingEditedRelativePath(wrapperRecordingStatus{EditedRelativePath: path})
		if (err == nil) != ok || (ok && got != path) {
			t.Errorf("%q: %q, %v", path, got, err)
		}
	}
}

func TestWrapperStatusCarriesTheEditIntoResponses(t *testing.T) {
	var status wrapperRecordingStatus
	body := `{"recordingId":"r","mode":"tab","targetId":"t","status":"stopped","relativePath":"recordings/r.webm",` +
		`"editedRelativePath":"recordings/r.edited.mp4","editError":{"code":"ffmpeg_failed","message":"bad"},"editWarnings":["w"]}`
	if err := json.Unmarshal([]byte(body), &status); err != nil {
		t.Fatal(err)
	}
	server := &Server{}
	response, err := server.recordingResponse("session", status)
	if err != nil || response.EditedRelativePath != "recordings/r.edited.mp4" || response.EditError == nil || response.EditError.Code != "ffmpeg_failed" || len(response.EditWarnings) != 1 {
		t.Errorf("response %+v err %v", response, err)
	}
	output, err := server.mcpRecordingOutputFromStatus("session", status)
	if err != nil || output.EditedRelativePath != "recordings/r.edited.mp4" || output.EditError == nil || len(output.EditWarnings) != 1 {
		t.Errorf("output %+v err %v", output, err)
	}
	encoded, _ := json.Marshal(response)
	if !strings.Contains(string(encoded), `"editedRelativePath":"recordings/r.edited.mp4"`) {
		t.Errorf("response JSON %s", encoded)
	}
}

func TestWrapperStatusesMapToErrors(t *testing.T) {
	unavailable := mapWrapperRecordingRequestError(&wrapperRecordingRequestError{StatusCode: http.StatusNotImplemented, Message: "no ffmpeg"})
	if status, code, _ := mapError(unavailable); status != http.StatusUnprocessableEntity || code != "recording_edit_unavailable" {
		t.Errorf("%d %s", status, code)
	}
	invalid := mapWrapperRecordingRequestError(&wrapperRecordingRequestError{StatusCode: http.StatusBadRequest, Message: "idle must be speed or cut"})
	if status, code, _ := mapError(invalid); status != http.StatusBadRequest || code != "validation_failed" {
		t.Errorf("%d %s", status, code)
	}
}

func TestIdleIsRejectedForBurstsRecordings(t *testing.T) {
	bursts := recordingCaptureBursts
	bad := createSessionRecordingRequest{TargetID: "t", Capture: bursts, recordingEffectsRequest: recordingEffectsRequest{Idle: "cut"}}
	if err := bad.Validate(); err == nil || !strings.Contains(err.Error(), "bursts recordings already skip idle time") {
		t.Errorf("idle with bursts: %v", err)
	}
	if err := (recordingEffectsRequest{Idle: "cut"}).validateFor(recordingCaptureContinuous); err != nil {
		t.Errorf("idle with continuous: %v", err)
	}
	ok := createSessionRecordingRequest{TargetID: "t", Capture: bursts}
	if err := ok.Validate(); err != nil {
		t.Errorf("bursts without idle: %v", err)
	}
}

func TestCaptionOnTimeOnlyWaitIsForwarded(t *testing.T) {
	arguments := map[string]any{"time": 2, "caption": "Give it a moment"}
	caption, err := playwrightToolCaption("browser_wait_for", arguments)
	if err != nil || caption != "Give it a moment" {
		t.Fatalf("caption %q err %v", caption, err)
	}
	if _, left := arguments["caption"]; left || arguments["time"] != 2 {
		t.Errorf("arguments %v", arguments)
	}
}

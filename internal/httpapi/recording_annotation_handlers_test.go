package httpapi

import (
	"net/http"
	"testing"

	"github.com/aperture/aperture/internal/db"
)

func TestRecordingAnnotationsREST(t *testing.T) {
	env := newRecordingTestEnv(t, "/usr/bin/ffmpeg")
	for _, tc := range []struct {
		kind     string
		body     map[string]any
		duration float64
	}{
		{"caption", map[string]any{"text": "  Hello  "}, 3000},
		{"focus", map[string]any{"selector": "#main", "zoom": 2}, 2000},
		{"attention", map[string]any{"point": map[string]any{"x": 10, "y": 20}}, 1200},
	} {
		rec := env.recordings(t, http.MethodPost, "/"+testRecordingID+"/"+tc.kind, tc.body)
		if rec.Code != http.StatusNoContent {
			t.Fatalf("%s: %d %s", tc.kind, rec.Code, rec.Body.String())
		}
		calls := env.wrapper.requests()
		call := calls[len(calls)-1]
		if call.Path != "/recordings/annotations/"+tc.kind || call.Body["recordingId"] != testRecordingID || call.Body["durationMs"] != tc.duration {
			t.Fatalf("wrapper request %+v", call)
		}
		if tc.kind == "caption" && call.Body["text"] != "Hello" {
			t.Fatalf("caption %+v", call)
		}
	}
}

func TestRecordingAnnotationsRejectInvalidInputBeforeWrapper(t *testing.T) {
	env := newRecordingTestEnv(t, "/usr/bin/ffmpeg")
	for _, tc := range []struct {
		kind string
		body map[string]any
	}{
		{"caption", map[string]any{"text": " ", "durationMs": 100}},
		{"focus", map[string]any{"selector": "#main", "rect": map[string]any{"x": 0, "y": 0, "width": 10, "height": 10}, "zoom": 2}},
		{"attention", map[string]any{"point": map[string]any{"x": 0, "y": 0}, "radius": 7}},
	} {
		rec := env.recordings(t, http.MethodPost, "/"+testRecordingID+"/"+tc.kind, tc.body)
		if rec.Code != http.StatusBadRequest || errorCode(t, rec) != "validation_failed" {
			t.Fatalf("%s: %d %s", tc.kind, rec.Code, rec.Body.String())
		}
	}
	if calls := env.wrapper.requests(); len(calls) != 0 {
		t.Fatalf("invalid requests reached wrapper: %v", calls)
	}
}

func TestRecordingAnnotationsNeverWakeAndPropagateMissingRecording(t *testing.T) {
	env := newRecordingTestEnv(t, "/usr/bin/ffmpeg")
	env.wrapper.refuseWith(http.StatusNotFound, "recording not found")
	rec := env.recordings(t, http.MethodPost, "/"+testRecordingID+"/caption", map[string]any{"text": "Hello"})
	if rec.Code != http.StatusNotFound || errorCode(t, rec) != "recording_not_found" {
		t.Fatalf("missing: %d %s", rec.Code, rec.Body.String())
	}
	env.suspend(t)
	rec = env.recordings(t, http.MethodPost, "/"+testRecordingID+"/caption", map[string]any{"text": "Hello"})
	if rec.Code != http.StatusConflict || env.status(t) != db.SessionStatusSuspended || len(env.wrapper.requests()) != 1 {
		t.Fatalf("suspended: %d %s", rec.Code, rec.Body.String())
	}
}

func TestCaptionAndFocusNeedFFmpegButAttentionDoesNot(t *testing.T) {
	env := newRecordingTestEnv(t, "")
	for kind, body := range map[string]map[string]any{"caption": {"text": "Hello"}, "focus": {"selector": "#main", "zoom": 2}} {
		rec := env.recordings(t, http.MethodPost, "/"+testRecordingID+"/"+kind, body)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: %d %s", kind, rec.Code, rec.Body.String())
		}
	}
	rec := env.recordings(t, http.MethodPost, "/"+testRecordingID+"/attention", map[string]any{"selector": "#main"})
	if rec.Code != http.StatusNoContent || len(env.wrapper.requests()) != 1 {
		t.Fatalf("attention: %d %s", rec.Code, rec.Body.String())
	}
}

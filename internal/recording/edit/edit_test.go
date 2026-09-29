package edit

import (
	"encoding/json"
	"testing"

	"github.com/aperture/aperture/internal/recording/timeline"
)

func TestZoomJSON(t *testing.T) {
	type args struct {
		Zoom *Zoom `json:"zoom"`
	}
	for _, test := range []struct {
		json    string
		want    Zoom
		present bool
		wantErr bool
	}{
		{json: `{}`},
		{json: `{"zoom": null}`},
		{json: `{"zoom": true}`, want: DefaultZoomLevel, present: true},
		{json: `{"zoom": false}`, want: 0, present: true},
		{json: `{"zoom": 2.5}`, want: 2.5, present: true},
		{json: `{"zoom": 1.1}`, want: 1.1, present: true},
		{json: `{"zoom": 4}`, want: 4, present: true},
		{json: `{"zoom": 1}`, wantErr: true},
		{json: `{"zoom": 1.09}`, wantErr: true},
		{json: `{"zoom": 4.01}`, wantErr: true},
		{json: `{"zoom": -2}`, wantErr: true},
		{json: `{"zoom": "2"}`, wantErr: true},
		{json: `{"zoom": {"level": 2}}`, wantErr: true},
	} {
		var parsed args
		err := json.Unmarshal([]byte(test.json), &parsed)
		if test.wantErr {
			if err == nil {
				t.Errorf("%s should fail", test.json)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: %v", test.json, err)
			continue
		}
		if (parsed.Zoom != nil) != test.present || (test.present && *parsed.Zoom != test.want) {
			t.Errorf("%s decoded to %v, want present=%v %v", test.json, parsed.Zoom, test.present, test.want)
		}
	}
}

func TestZoomMarshalsWhatItReads(t *testing.T) {
	for _, zoom := range []Zoom{0, 1.6, 3} {
		body, err := json.Marshal(zoom)
		if err != nil {
			t.Fatal(err)
		}
		var back Zoom
		if err := json.Unmarshal(body, &back); err != nil || back != zoom {
			t.Errorf("%v marshalled to %s and read back as %v (%v)", zoom, body, back, err)
		}
	}
}

func TestWantedNeedsAnEffect(t *testing.T) {
	base := func() *timeline.Timeline {
		return &timeline.Timeline{Gestures: []timeline.Gesture{{Kind: "click"}}, Captions: []timeline.Caption{{Text: "  \n"}}}
	}
	if Wanted(nil) || Wanted(base()) {
		t.Error("a timeline with no effect is not wanted")
	}
	tl := base()
	tl.Recording.Edit = &timeline.EditOptions{Ripple: true, Zoom: 2}
	if Wanted(tl) {
		t.Error("defaults alone do nothing: they are resolved onto the gestures")
	}
	tl.Recording.Edit.Idle = timeline.IdleCut
	if !Wanted(tl) {
		t.Error("an idle mode is wanted")
	}
	tl = base()
	tl.Captions[0].Text = "hello"
	if !Wanted(tl) {
		t.Error("a caption is wanted")
	}
	tl = base()
	tl.Gestures[0].Zoom = 1.6
	if !Wanted(tl) {
		t.Error("a zoomed gesture is wanted")
	}
	tl = base()
	tl.Gestures[0].Ripple = true
	if !Wanted(tl) {
		t.Error("a rippled click is wanted")
	}
}

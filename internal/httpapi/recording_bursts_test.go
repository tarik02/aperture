package httpapi

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/aperture/aperture/internal/pointer"
)

func TestCreateSessionRecordingBurstValidation(t *testing.T) {
	ptr := func(value int) *int { return &value }
	bursts := recordingCaptureBursts
	for name, test := range map[string]struct {
		request createSessionRecordingRequest
		wantErr string
	}{
		"continuous":          {request: createSessionRecordingRequest{TargetID: "t"}},
		"bursts":              {request: createSessionRecordingRequest{TargetID: "t", Capture: bursts, Burst: &recordingBurstRequest{LeadMs: ptr(0), TailMs: ptr(500), MaxTailMs: ptr(500)}}},
		"unknown":             {request: createSessionRecordingRequest{TargetID: "t", Capture: "always"}, wantErr: "capture must be"},
		"burst alone":         {request: createSessionRecordingRequest{TargetID: "t", Burst: &recordingBurstRequest{}}, wantErr: "needs capture bursts"},
		"burst on continuous": {request: createSessionRecordingRequest{TargetID: "t", Capture: recordingCaptureContinuous, Burst: &recordingBurstRequest{}}, wantErr: "needs capture bursts"},
		"lead":                {request: createSessionRecordingRequest{TargetID: "t", Capture: bursts, Burst: &recordingBurstRequest{LeadMs: ptr(10001)}}, wantErr: "burst.leadMs"},
		"tail":                {request: createSessionRecordingRequest{TargetID: "t", Capture: bursts, Burst: &recordingBurstRequest{TailMs: ptr(30001)}}, wantErr: "burst.tailMs"},
		"settle":              {request: createSessionRecordingRequest{TargetID: "t", Capture: bursts, Burst: &recordingBurstRequest{SettleMs: ptr(-5)}}, wantErr: "burst.settleMs"},
		"max tail":            {request: createSessionRecordingRequest{TargetID: "t", Capture: bursts, Burst: &recordingBurstRequest{MaxTailMs: ptr(60001)}}, wantErr: "burst.maxTailMs"},
		"max tail < tail":     {request: createSessionRecordingRequest{TargetID: "t", Capture: bursts, Burst: &recordingBurstRequest{TailMs: ptr(700), MaxTailMs: ptr(600)}}, wantErr: "must not be less"},
		"motion":              {request: createSessionRecordingRequest{TargetID: "t", Motion: &pointer.Motion{Kind: pointer.KindSpeed, Speed: 1}}, wantErr: "motion speed"},
	} {
		t.Run(name, func(t *testing.T) {
			err := test.request.Validate()
			if test.wantErr == "" && err != nil {
				t.Fatal(err)
			}
			if test.wantErr != "" && (err == nil || !strings.Contains(err.Error(), test.wantErr)) {
				t.Fatalf("error %v, want one about %q", err, test.wantErr)
			}
		})
	}
}

func TestRecordingStatusCarriesBurstFields(t *testing.T) {
	var status wrapperRecordingStatus
	body := `{"recordingId":"r","mode":"tab","relativePath":"recordings/x.webm","capture":"bursts","motion":{"speed":900},"burst":{"leadMs":400,"tailMs":600,"settleMs":500,"maxTailMs":4000,"state":"idle","count":2,"capped":1,"skipped":0}}`
	if err := json.Unmarshal([]byte(body), &status); err != nil {
		t.Fatal(err)
	}
	server := &Server{}
	output, err := server.mcpRecordingOutputFromStatus("s", status)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(output)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"capture":"bursts"`, `"motion":{"speed":900}`, `"count":2`, `"capped":1`} {
		if !strings.Contains(string(encoded), want) {
			t.Errorf("%s is missing %s", encoded, want)
		}
	}
}

func TestMCPRecordingStartInputSchema(t *testing.T) {
	for _, pathBound := range []bool{true, false} {
		schema := mcpRecordingStartInputSchema(pathBound)
		properties := schema["properties"].(map[string]any)
		for _, name := range []string{"targetId", "capture", "motion", "burst"} {
			if properties[name] == nil {
				t.Errorf("pathBound %v: no %s", pathBound, name)
			}
		}
		_, hasSession := properties["sessionId"]
		if hasSession == pathBound {
			t.Errorf("pathBound %v: sessionId present %v", pathBound, hasSession)
		}
	}
}

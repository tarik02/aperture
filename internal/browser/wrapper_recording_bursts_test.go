package browser

import (
	"strings"
	"testing"
)

func TestValidateRecordingEffects(t *testing.T) {
	if ValidateRecordingEffects("fast", "", nil) == nil {
		t.Error("idle fast was accepted")
	}
}

func TestValidateBursts(t *testing.T) {
	for _, c := range []struct {
		idle, capture string
		burst         *RecordingBurst
		want          string
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

func ptr(value int) *int { return &value }

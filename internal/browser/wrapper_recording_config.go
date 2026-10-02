package browser

import (
	"errors"
	"fmt"
)

var errRecordingConfigInvalid = errors.New("invalid recording config")

// recordingConfig is what recording.start says about the edit made when the recording stops.
// Capture "bursts" keeps only the stretches around browser tool calls (and follows the tab they
// act on); it cannot be combined with idle, which shortens the quiet stretches of a continuous
// recording instead.
type recordingConfig struct {
	Capture string       `json:"capture,omitempty"` // "continuous" (default) or "bursts"
	Idle    string       `json:"idle,omitempty"`    // "cut" or "speed"; "" keeps idle stretches
	Ripple  bool         `json:"ripple,omitempty"`  // mark clicks with a ripple
	Burst   *burstConfig `json:"burst,omitempty"`   // bursts only; zero fields take the defaults
}

// burstConfig sizes a burst around a tool call: LeadMS before it, TailMS after it, and more of the
// tail until the screen has stood still for SettleMS, but never past MaxTailMS.
type burstConfig struct {
	LeadMS    int64 `json:"leadMs"`
	TailMS    int64 `json:"tailMs"`
	SettleMS  int64 `json:"settleMs"`
	MaxTailMS int64 `json:"maxTailMs"`
}

const burstMaxMS = 60_000

var defaultBurst = burstConfig{LeadMS: 500, TailMS: 800, SettleMS: 400, MaxTailMS: 3000}

// validate checks the config and fills its defaults.
func (c *recordingConfig) validate() error {
	invalid := func(format string, args ...any) error {
		return fmt.Errorf("%w: "+format, append([]any{errRecordingConfigInvalid}, args...)...)
	}
	switch c.Capture {
	case "":
		c.Capture = "continuous"
	case "continuous", "bursts":
	default:
		return invalid(`capture must be "continuous" or "bursts"`)
	}
	if c.Idle != "" && c.Idle != "cut" && c.Idle != "speed" {
		return invalid(`idle must be "cut" or "speed"`)
	}
	if c.Capture == "bursts" && c.Idle != "" {
		return invalid("idle applies to continuous capture, not to bursts")
	}
	if c.Burst != nil && c.Capture != "bursts" {
		return invalid("burst applies only to capture bursts")
	}
	if c.Capture == "bursts" {
		if c.Burst == nil {
			c.Burst = &burstConfig{}
		}
		for _, field := range []struct {
			value    *int64
			fallback int64
		}{{&c.Burst.LeadMS, defaultBurst.LeadMS}, {&c.Burst.TailMS, defaultBurst.TailMS}, {&c.Burst.SettleMS, defaultBurst.SettleMS}, {&c.Burst.MaxTailMS, defaultBurst.MaxTailMS}} {
			if *field.value < 0 || *field.value > burstMaxMS {
				return invalid("burst values must be 0 to %d ms", burstMaxMS)
			}
			if *field.value == 0 {
				*field.value = field.fallback
			}
		}
		if c.Burst.TailMS > c.Burst.MaxTailMS {
			return invalid("burst tailMs must not exceed maxTailMs")
		}
	}
	return nil
}

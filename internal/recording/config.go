// Package recording holds the contracts that every recording surface shares: the daemon's API and
// MCP tools, the live-session commands and the wrapper that records. They are checked at the daemon
// before a session is woken and again in the wrapper.
package recording

import (
	"errors"
	"fmt"
)

// ErrInvalid is behind every rejected request; the message after it says why.
var ErrInvalid = errors.New("invalid recording request")

func invalidf(format string, args ...any) error {
	return fmt.Errorf("%w: "+format, append([]any{ErrInvalid}, args...)...)
}

const (
	CaptureContinuous = "continuous"
	CaptureBursts     = "bursts"
	IdleCut           = "cut"
	IdleSpeed         = "speed"
)

// Config is what recording.start says about the edit made when the recording stops, and how
// automation goes meanwhile. Capture "bursts" keeps only the stretches around browser tool calls
// (and follows the tab they act on); it cannot be combined with idle, which shortens the quiet
// stretches of a continuous recording instead.
type Config struct {
	Capture      string `json:"capture,omitempty" jsonschema:"continuous (default) or bursts. Bursts keep only the stretches around browser tool calls in the edited video and follow the tab they act on; it excludes idle."`
	Presentation bool   `json:"presentation,omitempty" jsonschema:"Run browser automation at presentation pace while recording."`
	Idle         string `json:"idle,omitempty" jsonschema:"cut or speed: remove, or fast-forward, the stretches in which nothing happens. Continuous capture only."`
	Ripple       bool   `json:"ripple,omitempty" jsonschema:"Mark clicks with a ripple in the edited video."`
	Burst        *Burst `json:"burst,omitempty" jsonschema:"Burst sizes in ms for capture bursts; omitted or zero fields take the defaults."`
}

// Burst sizes a burst around a tool call: LeadMS before it, TailMS after it, and more of the tail
// until the screen has stood still for SettleMS, but never past MaxTailMS.
type Burst struct {
	LeadMS    int64 `json:"leadMs,omitempty" jsonschema:"Kept before a tool call. Defaults to 500."`
	TailMS    int64 `json:"tailMs,omitempty" jsonschema:"Kept after a tool call. Defaults to 800."`
	SettleMS  int64 `json:"settleMs,omitempty" jsonschema:"How long the screen must stand still to count as settled. Defaults to 400."`
	MaxTailMS int64 `json:"maxTailMs,omitempty" jsonschema:"Longest wait for the screen to settle after a call. Defaults to 3000."`
}

// BurstMaxMS bounds every burst size.
const BurstMaxMS = 60_000

// DefaultBurst is what a zero burst field means.
var DefaultBurst = Burst{LeadMS: 500, TailMS: 800, SettleMS: 400, MaxTailMS: 3000}

// Validate checks the config and fills its defaults.
func (c *Config) Validate() error {
	switch c.Capture {
	case "":
		c.Capture = CaptureContinuous
	case CaptureContinuous, CaptureBursts:
	default:
		return invalidf(`capture must be "continuous" or "bursts"`)
	}
	if c.Idle != "" && c.Idle != IdleCut && c.Idle != IdleSpeed {
		return invalidf(`idle must be "cut" or "speed"`)
	}
	if c.Capture == CaptureBursts && c.Idle != "" {
		return invalidf("idle applies to continuous capture, not to bursts")
	}
	if c.Burst != nil && c.Capture != CaptureBursts {
		return invalidf("burst applies only to capture bursts")
	}
	if c.Capture == CaptureBursts {
		if c.Burst == nil {
			c.Burst = &Burst{}
		}
		for _, field := range []struct {
			value    *int64
			fallback int64
		}{{&c.Burst.LeadMS, DefaultBurst.LeadMS}, {&c.Burst.TailMS, DefaultBurst.TailMS}, {&c.Burst.SettleMS, DefaultBurst.SettleMS}, {&c.Burst.MaxTailMS, DefaultBurst.MaxTailMS}} {
			if *field.value < 0 || *field.value > BurstMaxMS {
				return invalidf("burst values must be 0 to %d ms", BurstMaxMS)
			}
			if *field.value == 0 {
				*field.value = field.fallback
			}
		}
		if c.Burst.TailMS > c.Burst.MaxTailMS {
			return invalidf("burst tailMs must not exceed maxTailMs")
		}
	}
	return nil
}

// Edits says whether the stop renders an edited video from these settings, which needs ffmpeg.
// Presentation only paces the automation, so it needs nothing.
func (c Config) Edits() bool {
	return c.Capture == CaptureBursts || c.Idle != "" || c.Ripple
}

// ErrFFmpegRequired names the instance setting an edit needs.
var ErrFFmpegRequired = fmt.Errorf("%w: recording edits need recording_ffmpeg_executable, which this instance does not set", ErrInvalid)

// EditErrorCode says why a recording that asked for an edit, or has a timeline to publish, has none.
type EditErrorCode string

const (
	EditFFmpegUnavailable EditErrorCode = "ffmpeg_unavailable"
	EditOpenFailed        EditErrorCode = "open_failed"
	EditNothingKept       EditErrorCode = "nothing_kept"
	EditAnalysisFailed    EditErrorCode = "analysis_failed"
	EditPlanFailed        EditErrorCode = "plan_failed"
	EditRenderFailed      EditErrorCode = "render_failed"
	EditTimeout           EditErrorCode = "timeout"
	EditCancelled         EditErrorCode = "cancelled"
	EditTimelineFailed    EditErrorCode = "timeline_failed"
)

// EditError is reported on a stopped recording in place of its edit. It never fails the stop: the
// raw video is always published.
type EditError struct {
	Code    EditErrorCode `json:"code"`
	Message string        `json:"message"`
}

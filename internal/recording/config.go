// Package recording holds the contracts that every recording surface shares: the daemon's API and
// MCP tools, the live-session commands and the wrapper that records. They are checked at the daemon
// before a session is woken and again in the wrapper.
package recording

import (
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
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

	PaceInstant = "instant"
	PaceFast    = "fast"
	PaceSlow    = "slow"

	MotionLinear  = "linear"
	MotionNatural = "natural"

	BurstTight   = "tight"
	BurstDefault = "default"
	BurstRelaxed = "relaxed"
)

// Config is what recording.start says about the edit made when the recording stops, and how
// automation goes meanwhile. Capture "bursts" keeps only the stretches around browser tool calls
// (and follows the tab they act on); it cannot be combined with idle, which shortens the quiet
// stretches of a continuous recording instead.
type Config struct {
	Capture string  `json:"capture,omitempty" jsonschema:"continuous (default) or bursts. Bursts keep only the stretches around browser tool calls in the edited video and follow the tab they act on; it excludes idle."`
	Pace    string  `json:"pace,omitempty" jsonschema:"How fast automation acts while recording: instant (the pointer jumps to each action), fast (default; quick but followable pointer travel) or slow (unhurried travel and longer rests, for demos)."`
	Motion  *Motion `json:"motion,omitempty" jsonschema:"Pointer path for fast and slow pace: linear (default; a straight eased path), natural (a curved eased path with an occasional small overshoot) or {type: natural, seed} to replay the same paths. Ignored at pace instant."`
	Idle    string  `json:"idle,omitempty" jsonschema:"cut or speed: remove, or fast-forward, the stretches in which nothing happens. Continuous capture only."`
	Ripple  bool    `json:"ripple,omitempty" jsonschema:"Mark clicks with a ripple in the edited video."`
	Burst   *Burst  `json:"burst,omitempty" jsonschema:"Burst sizes for capture bursts: a preset, and ms fields that override it."`
}

// Motion is the pointer path of a paced glide. A natural motion without a seed gets one at
// validation, so the recording reports the seed that replays its paths.
type Motion struct {
	Type string `json:"type"`
	Seed *int64 `json:"seed,omitempty"`
}

// MotionSeedMax keeps seeds exact as JSON numbers in JavaScript clients.
const MotionSeedMax = 1<<53 - 1

// UnmarshalJSON takes the short form "linear" or "natural" as well as the object.
func (m *Motion) UnmarshalJSON(data []byte) error {
	var name string
	if json.Unmarshal(data, &name) == nil {
		*m = Motion{Type: name}
		return nil
	}
	type plain Motion
	var value plain
	if err := json.Unmarshal(data, &value); err != nil {
		return invalidf(`motion must be "linear", "natural" or {"type": "natural", "seed": n}`)
	}
	*m = Motion(value)
	return nil
}

// Burst sizes a burst around a tool call: LeadMS before it, TailMS after it, and more of the tail
// until the screen has stood still for SettleMS, but never past MaxTailMS. Preset fills the
// fields left out.
type Burst struct {
	Preset    string `json:"preset,omitempty" jsonschema:"tight (lead 200, tail 400, settle 200, maxTail 1500), default (lead 500, tail 800, settle 400, maxTail 3000) or relaxed (lead 800, tail 1200, settle 600, maxTail 4000). Defaults to default."`
	LeadMS    int64  `json:"leadMs,omitempty" jsonschema:"Kept before a tool call. Overrides the preset."`
	TailMS    int64  `json:"tailMs,omitempty" jsonschema:"Kept after a tool call. Overrides the preset."`
	SettleMS  int64  `json:"settleMs,omitempty" jsonschema:"How long the screen must stand still to count as settled. Overrides the preset."`
	MaxTailMS int64  `json:"maxTailMs,omitempty" jsonschema:"Longest wait for the screen to settle after a call. Overrides the preset."`
}

// BurstMaxMS bounds every burst size.
const BurstMaxMS = 60_000

// BurstPresets are what a burst's preset fills its zero fields with.
var BurstPresets = map[string]Burst{
	BurstTight:   {Preset: BurstTight, LeadMS: 200, TailMS: 400, SettleMS: 200, MaxTailMS: 1500},
	BurstDefault: {Preset: BurstDefault, LeadMS: 500, TailMS: 800, SettleMS: 400, MaxTailMS: 3000},
	BurstRelaxed: {Preset: BurstRelaxed, LeadMS: 800, TailMS: 1200, SettleMS: 600, MaxTailMS: 4000},
}

// DefaultBurst is the burst of a config that names none.
var DefaultBurst = BurstPresets[BurstDefault]

// Validate checks the config and fills its defaults.
func (c *Config) Validate() error {
	switch c.Capture {
	case "":
		c.Capture = CaptureContinuous
	case CaptureContinuous, CaptureBursts:
	default:
		return invalidf(`capture must be "continuous" or "bursts"`)
	}
	switch c.Pace {
	case "":
		c.Pace = PaceFast
	case PaceInstant, PaceFast, PaceSlow:
	default:
		return invalidf(`pace must be "instant", "fast" or "slow"`)
	}
	if err := c.validateMotion(); err != nil {
		return err
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
		if c.Burst.Preset == "" {
			c.Burst.Preset = BurstDefault
		}
		preset, ok := BurstPresets[c.Burst.Preset]
		if !ok {
			return invalidf(`burst preset must be "tight", "default" or "relaxed"`)
		}
		for _, field := range []struct {
			value    *int64
			fallback int64
		}{{&c.Burst.LeadMS, preset.LeadMS}, {&c.Burst.TailMS, preset.TailMS}, {&c.Burst.SettleMS, preset.SettleMS}, {&c.Burst.MaxTailMS, preset.MaxTailMS}} {
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

func (c *Config) validateMotion() error {
	if c.Motion == nil {
		c.Motion = &Motion{Type: MotionLinear}
	}
	switch c.Motion.Type {
	case MotionLinear:
		if c.Motion.Seed != nil {
			return invalidf("a motion seed applies only to natural motion")
		}
	case MotionNatural:
		if c.Motion.Seed == nil {
			seed := rand.Int64N(MotionSeedMax + 1)
			c.Motion.Seed = &seed
		}
		if *c.Motion.Seed < 0 || *c.Motion.Seed > MotionSeedMax {
			return invalidf("motion seed must be 0 to %d", int64(MotionSeedMax))
		}
	default:
		return invalidf(`motion must be "linear" or "natural"`)
	}
	return nil
}

// Edits says whether the stop renders an edited video from these settings, which needs ffmpeg.
// Pace and motion only steer the automation, so they need nothing.
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

package recording

import "errors"

// Config is the public recording policy persisted verbatim for the finalizer.
// Capture timing and browser interaction defaults belong to their producers.
type Config struct {
	Capture      string        `json:"capture,omitempty"`
	Presentation bool          `json:"presentation,omitempty"`
	Idle         string        `json:"idle,omitempty"`
	Ripple       *bool         `json:"ripple,omitempty"`
	Burst        *BurstOptions `json:"burst,omitempty"`
}

type BurstOptions struct {
	LeadMS    *int `json:"leadMs,omitempty"`
	TailMS    *int `json:"tailMs,omitempty"`
	SettleMS  *int `json:"settleMs,omitempty"`
	MaxTailMS *int `json:"maxTailMs,omitempty"`
}

func (config Config) Validate() error {
	if config.Capture != "" && config.Capture != "continuous" && config.Capture != "bursts" {
		return errors.New("capture must be continuous or bursts")
	}
	if config.Idle != "" && config.Idle != "cut" && config.Idle != "speed" {
		return errors.New("idle must be cut or speed")
	}
	if config.Capture == "bursts" && config.Idle != "" {
		return errors.New("bursts and idle are mutually exclusive")
	}
	if config.Burst != nil {
		if config.Capture != "bursts" {
			return errors.New("burst options require capture: bursts")
		}
		for _, value := range []*int{config.Burst.LeadMS, config.Burst.TailMS, config.Burst.SettleMS, config.Burst.MaxTailMS} {
			if value != nil && (*value < 0 || *value > 60000) {
				return errors.New("burst durations must be between 0 and 60000 milliseconds")
			}
		}
	}
	return nil
}

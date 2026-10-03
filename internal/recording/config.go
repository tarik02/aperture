package recording

import "errors"

// Edit is the public finalization policy selected when capture stops.
// Timeline window sizes and cut policy belong to the recording worker.
type Edit struct {
	Trim     string `json:"trim,omitempty"`
	CutStyle string `json:"cutStyle,omitempty"`
	Ripple   *bool  `json:"ripple,omitempty"`
}

func (edit Edit) Validate() error {
	if edit.Trim != "" && edit.Trim != "none" && edit.Trim != "idle" && edit.Trim != "actions" {
		return errors.New("trim must be none, idle, or actions")
	}
	if edit.CutStyle != "" && edit.CutStyle != "natural" && edit.CutStyle != "tight" {
		return errors.New("cutStyle must be natural or tight")
	}
	return nil
}

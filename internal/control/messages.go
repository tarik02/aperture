package control

import (
	"encoding/json"
)

const (
	msgTargetsList      = "targets.list"
	msgTargetsActivate  = "targets.activate"
	msgTargetsCreate    = "targets.create"
	msgTargetsClose     = "targets.close"
	msgPageNavigate     = "page.navigate"
	msgPageReload       = "page.reload"
	msgPageStopLoading  = "page.stopLoading"
	msgViewportSet      = "viewport.set"
	msgScreencastStart  = "screencast.start"
	msgScreencastStop   = "screencast.stop"
	msgInputMouse       = "input.mouse"
	msgInputWheel       = "input.wheel"
	msgInputKey         = "input.key"
	msgClipboardCopy    = "clipboard.copy"
	msgClipboardCut     = "clipboard.cut"
	msgClipboardPaste   = "clipboard.paste"

	msgTargetsSnapshot  = "targets.snapshot"
	msgTargetChanged    = "target.changed"
	msgScreencastFrame  = "screencast.frame"
	msgScreencastStopped = "screencast.stopped"
	msgError            = "error"

	errCodeInvalidRequest      = "invalid_request"
	errCodeNotImplemented      = "not_implemented"
	errCodeBrowserControlFailed = "browser_control_failed"
	errCodeTargetNotFound      = "target_not_found"
)

type clientMessage struct {
	Type string `json:"type"`

	TargetID string `json:"targetId,omitempty"`

	Format          string `json:"format,omitempty"`
	Quality         *int64 `json:"quality,omitempty"`
	MaxWidth        *int64 `json:"maxWidth,omitempty"`
	MaxHeight       *int64 `json:"maxHeight,omitempty"`
	EveryNthFrame   *int64 `json:"everyNthFrame,omitempty"`
}

type targetView struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Title    string `json:"title"`
	URL      string `json:"url"`
	Attached bool   `json:"attached"`
}

type targetsSnapshotMessage struct {
	Type           string       `json:"type"`
	SessionID      string       `json:"sessionId"`
	ActiveTargetID string       `json:"activeTargetId,omitempty"`
	Targets        []targetView `json:"targets"`
}

type targetChangedMessage struct {
	Type   string     `json:"type"`
	Change string     `json:"change"`
	Target targetView `json:"target"`
}

type screencastFrameMessage struct {
	Type              string  `json:"type"`
	SessionID         string  `json:"sessionId"`
	TargetID          string  `json:"targetId"`
	FrameID           int64   `json:"frameId"`
	Format            string  `json:"format"`
	Data              string  `json:"data"`
	Width             float64 `json:"width"`
	Height            float64 `json:"height"`
	DeviceScaleFactor float64 `json:"deviceScaleFactor"`
	ScrollOffsetX     float64 `json:"scrollOffsetX"`
	ScrollOffsetY     float64 `json:"scrollOffsetY"`
	Timestamp         float64 `json:"timestamp,omitempty"`
}

type screencastStoppedMessage struct {
	Type      string `json:"type"`
	SessionID string `json:"sessionId"`
	TargetID  string `json:"targetId,omitempty"`
}

type errorMessage struct {
	Type    string `json:"type"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

func parseClientMessage(data []byte) (clientMessage, error) {
	var msg clientMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		return clientMessage{}, err
	}
	return msg, nil
}

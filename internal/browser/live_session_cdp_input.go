package browser

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"

	remoteinput "github.com/tarik02/webdesktop/input"
)

const liveSessionCDPInputTimeout = 5 * time.Second

type liveSessionCDPInput struct {
	port        int
	connection  *liveSessionCDP
	targetID    string
	sessionID   string
	pointerX    float64
	pointerY    float64
	buttons     int
	pressedKeys map[string]liveSessionClientMessage
}

func newLiveSessionCDPInput(port int) *liveSessionCDPInput {
	return &liveSessionCDPInput{
		port:        port,
		pressedKeys: make(map[string]liveSessionClientMessage),
	}
}

func (input *liveSessionCDPInput) bind(_ uint64, targetID string, _ func()) error {
	targetID = strings.TrimSpace(targetID)
	if targetID == "" {
		return remoteinput.ErrNotReady
	}
	if input.connection != nil && input.targetID == targetID && input.sessionID != "" {
		return nil
	}
	found, err := input.hasTarget(targetID)
	if err != nil {
		return err
	}
	if !found {
		return remoteinput.ErrNotReady
	}
	if input.sessionID != "" {
		if err := input.release(0); err != nil {
			return err
		}
		if err := input.call("Target.detachFromTarget", map[string]any{"sessionId": input.sessionID}, "", nil); err != nil {
			input.closeConnection()
			return err
		}
		input.sessionID = ""
		input.targetID = ""
	}
	var attached struct {
		SessionID string `json:"sessionId"`
	}
	if err := input.call("Target.attachToTarget", map[string]any{"targetId": targetID, "flatten": true}, "", &attached); err != nil {
		input.closeConnection()
		return err
	}
	if strings.TrimSpace(attached.SessionID) == "" {
		input.closeConnection()
		return errors.New("CDP input target attachment omitted session id")
	}
	input.targetID = targetID
	input.sessionID = attached.SessionID
	input.pointerX = 0
	input.pointerY = 0
	input.buttons = 0
	clear(input.pressedKeys)
	return nil
}

func (input *liveSessionCDPInput) hasTarget(targetID string) (bool, error) {
	targetID = strings.TrimSpace(targetID)
	if targetID == "" {
		return false, nil
	}
	if err := input.ensureConnection(); err != nil {
		return false, err
	}
	var targets struct {
		TargetInfos []cdpTargetInfo `json:"targetInfos"`
	}
	if err := input.call("Target.getTargets", map[string]any{}, "", &targets); err != nil {
		input.closeConnection()
		return false, err
	}
	for _, target := range targets.TargetInfos {
		if target.TargetID == targetID && isUserCDPTarget(target) {
			return true, nil
		}
	}
	return false, nil
}

func (input *liveSessionCDPInput) submit(_ uint64, message liveSessionClientMessage) (err error) {
	defer func() {
		if err != nil {
			input.closeConnection()
		}
	}()
	if input.connection == nil || input.sessionID == "" || input.targetID != message.TargetID {
		return remoteinput.ErrNotReady
	}
	switch message.Type {
	case "input.pointer.motion.absolute":
		if message.Width <= 0 || message.Height <= 0 || message.X < 0 || message.X > 1 || message.Y < 0 || message.Y > 1 {
			return errors.New("pointer position is invalid")
		}
		input.pointerX = message.X * message.Width
		input.pointerY = message.Y * message.Height
		button := "none"
		switch {
		case input.buttons&1 != 0:
			button = "left"
		case input.buttons&2 != 0:
			button = "right"
		case input.buttons&4 != 0:
			button = "middle"
		}
		return input.send("Input.dispatchMouseEvent", map[string]any{
			"type":      "mouseMoved",
			"x":         input.pointerX,
			"y":         input.pointerY,
			"button":    button,
			"buttons":   input.buttons,
			"modifiers": message.Modifiers,
		}, input.sessionID)
	case "input.pointer.button":
		if message.Width <= 0 || message.Height <= 0 || message.X < 0 || message.X > 1 || message.Y < 0 || message.Y > 1 {
			return errors.New("pointer position is invalid")
		}
		input.pointerX = message.X * message.Width
		input.pointerY = message.Y * message.Height
		button, mask, ok := liveSessionCDPMouseButton(message.ButtonCode)
		if !ok {
			return errors.New("pointer button is invalid")
		}
		if message.Pressed {
			input.buttons |= mask
		} else {
			input.buttons &^= mask
		}
		clickCount := message.ClickCount
		if clickCount <= 0 {
			clickCount = 1
		}
		eventType := "mouseReleased"
		if message.Pressed {
			eventType = "mousePressed"
		}
		return input.call("Input.dispatchMouseEvent", map[string]any{
			"type":       eventType,
			"x":          input.pointerX,
			"y":          input.pointerY,
			"button":     button,
			"buttons":    input.buttons,
			"clickCount": clickCount,
			"modifiers":  message.Modifiers,
		}, input.sessionID, nil)
	case "input.pointer.scroll":
		if message.Width <= 0 || message.Height <= 0 || message.X < 0 || message.X > 1 || message.Y < 0 || message.Y > 1 {
			return errors.New("pointer position is invalid")
		}
		input.pointerX = message.X * message.Width
		input.pointerY = message.Y * message.Height
		if message.Horizontal == 0 && message.Vertical == 0 {
			return nil
		}
		return input.send("Input.dispatchMouseEvent", map[string]any{
			"type":      "mouseWheel",
			"x":         input.pointerX,
			"y":         input.pointerY,
			"button":    "none",
			"buttons":   input.buttons,
			"deltaX":    message.Horizontal,
			"deltaY":    message.Vertical,
			"modifiers": message.Modifiers,
		}, input.sessionID)
	case "input.keyboard.key":
		if err := input.dispatchKey(message); err != nil {
			return err
		}
		keyID := liveSessionCDPKeyID(message)
		if keyID != "" {
			if message.Pressed {
				input.pressedKeys[keyID] = message
			} else {
				delete(input.pressedKeys, keyID)
			}
		}
		return nil
	case "input.keyboard.text":
		return input.call("Input.insertText", map[string]any{"text": message.Text}, input.sessionID, nil)
	default:
		return errors.New("unsupported CDP input event")
	}
}

func (input *liveSessionCDPInput) dispatchKey(message liveSessionClientMessage) error {
	eventType := "rawKeyDown"
	if !message.Pressed {
		eventType = "keyUp"
	} else if message.Text != "" {
		eventType = "keyDown"
	}
	params := map[string]any{
		"type":                  eventType,
		"modifiers":             message.Modifiers,
		"windowsVirtualKeyCode": message.WindowsVirtualKeyCode,
		"nativeVirtualKeyCode":  message.NativeVirtualKeyCode,
		"autoRepeat":            message.AutoRepeat,
		"isKeypad":              message.IsKeypad,
	}
	if message.Key != "" {
		params["key"] = message.Key
	}
	if message.Code != "" {
		params["code"] = message.Code
	}
	if message.Text != "" {
		params["text"] = message.Text
	}
	if message.UnmodifiedText != "" {
		params["unmodifiedText"] = message.UnmodifiedText
	}
	if message.Location != 0 {
		params["location"] = message.Location
	}
	return input.call("Input.dispatchKeyEvent", params, input.sessionID, nil)
}

func (input *liveSessionCDPInput) release(_ uint64) error {
	if input.connection == nil || input.sessionID == "" {
		clear(input.pressedKeys)
		input.buttons = 0
		return nil
	}
	for keyID, message := range input.pressedKeys {
		message.Pressed = false
		message.Text = ""
		message.UnmodifiedText = ""
		message.Modifiers = 0
		message.AutoRepeat = false
		if err := input.dispatchKey(message); err != nil {
			input.closeConnection()
			return err
		}
		delete(input.pressedKeys, keyID)
	}
	for _, button := range []struct {
		name string
		mask int
	}{
		{name: "left", mask: 1},
		{name: "right", mask: 2},
		{name: "middle", mask: 4},
	} {
		if input.buttons&button.mask == 0 {
			continue
		}
		input.buttons &^= button.mask
		if err := input.call("Input.dispatchMouseEvent", map[string]any{
			"type":       "mouseReleased",
			"x":          input.pointerX,
			"y":          input.pointerY,
			"button":     button.name,
			"buttons":    input.buttons,
			"clickCount": 1,
		}, input.sessionID, nil); err != nil {
			input.closeConnection()
			return err
		}
	}
	return nil
}

func (input *liveSessionCDPInput) close() error {
	input.closeConnection()
	return nil
}

func (input *liveSessionCDPInput) ensureConnection() error {
	if input.connection != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), liveSessionCDPInputTimeout)
	defer cancel()
	connection, err := connectLiveSessionCDP(ctx, input.port)
	if err != nil {
		return err
	}
	input.connection = connection
	return nil
}

func (input *liveSessionCDPInput) call(method string, params any, sessionID string, result any) error {
	if input.connection == nil {
		return errors.New("CDP input connection is unavailable")
	}
	ctx, cancel := context.WithTimeout(context.Background(), liveSessionCDPInputTimeout)
	defer cancel()
	return input.connection.call(ctx, method, params, sessionID, result)
}

func (input *liveSessionCDPInput) send(method string, params any, sessionID string) error {
	if input.connection == nil {
		return errors.New("CDP input connection is unavailable")
	}
	ctx, cancel := context.WithTimeout(context.Background(), liveSessionCDPInputTimeout)
	defer cancel()
	return input.connection.send(ctx, method, params, sessionID)
}

func (input *liveSessionCDPInput) closeConnection() {
	if input.connection != nil {
		input.connection.close()
	}
	input.connection = nil
	input.targetID = ""
	input.sessionID = ""
	input.pointerX = 0
	input.pointerY = 0
	input.buttons = 0
	clear(input.pressedKeys)
}

func liveSessionCDPKeyID(message liveSessionClientMessage) string {
	if message.Code != "" {
		return "code:" + message.Code
	}
	if message.Key != "" {
		return "key:" + message.Key + ":" + strconv.Itoa(message.Location)
	}
	if message.WindowsVirtualKeyCode != 0 {
		return "virtual:" + strconv.Itoa(message.WindowsVirtualKeyCode)
	}
	return ""
}

func liveSessionCDPMouseButton(code uint32) (string, int, bool) {
	switch code {
	case 272:
		return "left", 1, true
	case 273:
		return "right", 2, true
	case 274:
		return "middle", 4, true
	default:
		return "", 0, false
	}
}

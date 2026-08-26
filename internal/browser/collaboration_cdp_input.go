package browser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"
	remoteinput "github.com/tarik02/webdesktop/input"
)

const collaborationCDPInputTimeout = 5 * time.Second

type collaborationCDPInput struct {
	port        int
	connection  *websocket.Conn
	nextID      int64
	targetID    string
	sessionID   string
	pointerX    float64
	pointerY    float64
	buttons     int
	pressedKeys map[string]collaborationClientMessage
}

func newCollaborationCDPInput(port int) *collaborationCDPInput {
	return &collaborationCDPInput{
		port:        port,
		pressedKeys: make(map[string]collaborationClientMessage),
	}
}

func (input *collaborationCDPInput) bind(_ uint64, targetID string, _ func()) error {
	targetID = strings.TrimSpace(targetID)
	if targetID == "" {
		return remoteinput.ErrNotReady
	}
	if input.connection != nil && input.targetID == targetID && input.sessionID != "" {
		return nil
	}
	if err := input.ensureConnection(); err != nil {
		return err
	}
	var targets struct {
		TargetInfos []cdpTargetInfo `json:"targetInfos"`
	}
	if err := input.call("Target.getTargets", map[string]any{}, "", &targets); err != nil {
		input.closeConnection()
		return err
	}
	found := false
	for _, target := range targets.TargetInfos {
		if target.TargetID == targetID && isUserCDPTarget(target) {
			found = true
			break
		}
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

func (input *collaborationCDPInput) submit(_ uint64, message collaborationClientMessage) (err error) {
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
		return input.call("Input.dispatchMouseEvent", map[string]any{
			"type":      "mouseMoved",
			"x":         input.pointerX,
			"y":         input.pointerY,
			"button":    "none",
			"buttons":   input.buttons,
			"modifiers": message.Modifiers,
		}, input.sessionID, nil)
	case "input.pointer.button":
		button, mask, ok := collaborationCDPMouseButton(message.ButtonCode)
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
		if message.Horizontal == 0 && message.Vertical == 0 {
			return nil
		}
		return input.call("Input.dispatchMouseEvent", map[string]any{
			"type":      "mouseWheel",
			"x":         input.pointerX,
			"y":         input.pointerY,
			"button":    "none",
			"buttons":   input.buttons,
			"deltaX":    message.Horizontal,
			"deltaY":    message.Vertical,
			"modifiers": message.Modifiers,
		}, input.sessionID, nil)
	case "input.keyboard.key":
		if err := input.dispatchKey(message); err != nil {
			return err
		}
		keyID := collaborationCDPKeyID(message)
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

func (input *collaborationCDPInput) dispatchKey(message collaborationClientMessage) error {
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

func (input *collaborationCDPInput) release(_ uint64) error {
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

func (input *collaborationCDPInput) close() error {
	input.closeConnection()
	return nil
}

func (input *collaborationCDPInput) ensureConnection() error {
	if input.connection != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), collaborationCDPInputTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+net.JoinHostPort("127.0.0.1", strconv.Itoa(input.port))+"/json/version", nil)
	if err != nil {
		return err
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return fmt.Errorf("discover CDP input endpoint: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("discover CDP input endpoint: status %d", response.StatusCode)
	}
	var version struct {
		WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
	}
	if err := json.NewDecoder(response.Body).Decode(&version); err != nil {
		return fmt.Errorf("decode CDP input endpoint: %w", err)
	}
	if strings.TrimSpace(version.WebSocketDebuggerURL) == "" {
		return errors.New("CDP input endpoint omitted websocket URL")
	}
	connection, _, err := websocket.Dial(ctx, version.WebSocketDebuggerURL, nil)
	if err != nil {
		return fmt.Errorf("connect CDP input endpoint: %w", err)
	}
	connection.SetReadLimit(cdpDiscoveryMessageLimit)
	input.connection = connection
	return nil
}

func (input *collaborationCDPInput) call(method string, params any, sessionID string, result any) error {
	if input.connection == nil {
		return errors.New("CDP input connection is unavailable")
	}
	ctx, cancel := context.WithTimeout(context.Background(), collaborationCDPInputTimeout)
	defer cancel()
	input.nextID++
	request := map[string]any{"id": input.nextID, "method": method, "params": params}
	if sessionID != "" {
		request["sessionId"] = sessionID
	}
	body, err := json.Marshal(request)
	if err != nil {
		return err
	}
	if err := input.connection.Write(ctx, websocket.MessageText, body); err != nil {
		return err
	}
	for {
		_, body, err := input.connection.Read(ctx)
		if err != nil {
			return err
		}
		var response struct {
			ID     int64           `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  *struct {
				Code    int    `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(body, &response); err != nil || response.ID != input.nextID {
			continue
		}
		if response.Error != nil {
			return fmt.Errorf("CDP %s failed (%d): %s", method, response.Error.Code, response.Error.Message)
		}
		if result == nil {
			return nil
		}
		return json.Unmarshal(response.Result, result)
	}
}

func (input *collaborationCDPInput) closeConnection() {
	if input.connection != nil {
		_ = input.connection.CloseNow()
	}
	input.connection = nil
	input.targetID = ""
	input.sessionID = ""
	input.pointerX = 0
	input.pointerY = 0
	input.buttons = 0
	clear(input.pressedKeys)
}

func collaborationCDPKeyID(message collaborationClientMessage) string {
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

func collaborationCDPMouseButton(code uint32) (string, int, bool) {
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

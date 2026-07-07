package browser

import (
	"context"
	"encoding/json"
	"fmt"
)

type inputClient interface {
	Connect(ctx context.Context) error
	HandleJSON(ctx context.Context, body []byte) error
	Close() error
}

type inputPingMessage struct {
	Type string `json:"type"`
	Seq  int64  `json:"seq"`
}

func newInputClient(cfg webRTCProducerConfig) (inputClient, error) {
	return compositorInputClient{controlSocket: cfg.controlSocket}, nil
}

type compositorInputClient struct {
	controlSocket string
}

func (compositorInputClient) Connect(context.Context) error {
	return nil
}

func (c compositorInputClient) HandleJSON(ctx context.Context, body []byte) error {
	var envelope struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return err
	}
	switch envelope.Type {
	case "input.mouse":
		var msg struct {
			Action string  `json:"action"`
			X      float64 `json:"x"`
			Y      float64 `json:"y"`
			Button string  `json:"button"`
		}
		if err := json.Unmarshal(body, &msg); err != nil {
			return err
		}
		return c.handleMouse(ctx, msg.Action, msg.X, msg.Y, msg.Button)
	case "input.wheel":
		var msg struct {
			X      float64 `json:"x"`
			Y      float64 `json:"y"`
			DeltaX float64 `json:"deltaX"`
			DeltaY float64 `json:"deltaY"`
		}
		if err := json.Unmarshal(body, &msg); err != nil {
			return err
		}
		if err := c.motion(ctx, msg.X, msg.Y); err != nil {
			return err
		}
		_, err := sendCompositorControlCommand(
			ctx,
			c.controlSocket,
			fmt.Sprintf("axis %.3f %.3f\n", msg.DeltaX, msg.DeltaY),
		)
		return err
	case "input.key":
		var msg struct {
			Action string `json:"action"`
			Code   string `json:"code"`
			Key    string `json:"key"`
		}
		if err := json.Unmarshal(body, &msg); err != nil {
			return err
		}
		if msg.Action == "char" {
			return nil
		}
		keyCode, ok := linuxKeyCode(msg.Code, msg.Key)
		if !ok {
			return fmt.Errorf("unsupported key code %q key %q", msg.Code, msg.Key)
		}
		pressed := 0
		if msg.Action == "down" {
			pressed = 1
		} else if msg.Action != "up" {
			return fmt.Errorf("unsupported key action %q", msg.Action)
		}
		_, err := sendCompositorControlCommand(
			ctx,
			c.controlSocket,
			fmt.Sprintf("key %d %d\n", keyCode, pressed),
		)
		return err
	default:
		return fmt.Errorf("unsupported input message %q", envelope.Type)
	}
}

func (compositorInputClient) Close() error {
	return nil
}

func (c compositorInputClient) handleMouse(ctx context.Context, action string, x float64, y float64, button string) error {
	if err := c.motion(ctx, x, y); err != nil {
		return err
	}
	switch action {
	case "move":
		return nil
	case "down":
		return c.button(ctx, button, true)
	case "up":
		return c.button(ctx, button, false)
	case "click":
		if err := c.button(ctx, button, true); err != nil {
			return err
		}
		return c.button(ctx, button, false)
	case "doubleClick":
		for range 2 {
			if err := c.button(ctx, button, true); err != nil {
				return err
			}
			if err := c.button(ctx, button, false); err != nil {
				return err
			}
		}
		return nil
	default:
		return fmt.Errorf("unsupported mouse action %q", action)
	}
}

func (c compositorInputClient) motion(ctx context.Context, x float64, y float64) error {
	_, err := sendCompositorControlCommand(
		ctx,
		c.controlSocket,
		fmt.Sprintf("motion %.3f %.3f\n", x, y),
	)
	return err
}

func (c compositorInputClient) button(ctx context.Context, button string, pressed bool) error {
	code, ok := linuxButtonCode(button)
	if !ok {
		return fmt.Errorf("unsupported mouse button %q", button)
	}
	pressedInt := 0
	if pressed {
		pressedInt = 1
	}
	_, err := sendCompositorControlCommand(
		ctx,
		c.controlSocket,
		fmt.Sprintf("button %d %d\n", code, pressedInt),
	)
	return err
}

func linuxButtonCode(button string) (int, bool) {
	switch button {
	case "", "left":
		return 272, true
	case "right":
		return 273, true
	case "middle":
		return 274, true
	case "none":
		return 0, false
	default:
		return 0, false
	}
}

func linuxKeyCode(code string, key string) (int, bool) {
	if value, ok := linuxKeyCodesByCode[code]; ok {
		return value, true
	}
	if value, ok := linuxKeyCodesByKey[key]; ok {
		return value, true
	}
	return 0, false
}

var linuxKeyCodesByCode = map[string]int{
	"Backquote":    41,
	"Backslash":    43,
	"Backspace":    14,
	"BracketLeft":  26,
	"BracketRight": 27,
	"Comma":        51,
	"Digit0":       11,
	"Digit1":       2,
	"Digit2":       3,
	"Digit3":       4,
	"Digit4":       5,
	"Digit5":       6,
	"Digit6":       7,
	"Digit7":       8,
	"Digit8":       9,
	"Digit9":       10,
	"Enter":        28,
	"Equal":        13,
	"Minus":        12,
	"Period":       52,
	"Quote":        40,
	"Semicolon":    39,
	"Slash":        53,
	"Space":        57,
	"Tab":          15,
	"KeyA":         30,
	"KeyB":         48,
	"KeyC":         46,
	"KeyD":         32,
	"KeyE":         18,
	"KeyF":         33,
	"KeyG":         34,
	"KeyH":         35,
	"KeyI":         23,
	"KeyJ":         36,
	"KeyK":         37,
	"KeyL":         38,
	"KeyM":         50,
	"KeyN":         49,
	"KeyO":         24,
	"KeyP":         25,
	"KeyQ":         16,
	"KeyR":         19,
	"KeyS":         31,
	"KeyT":         20,
	"KeyU":         22,
	"KeyV":         47,
	"KeyW":         17,
	"KeyX":         45,
	"KeyY":         21,
	"KeyZ":         44,
	"AltLeft":      56,
	"AltRight":     100,
	"ControlLeft":  29,
	"ControlRight": 97,
	"MetaLeft":     125,
	"MetaRight":    126,
	"ShiftLeft":    42,
	"ShiftRight":   54,
	"ArrowDown":    108,
	"ArrowLeft":    105,
	"ArrowRight":   106,
	"ArrowUp":      103,
	"Delete":       111,
	"End":          107,
	"Home":         102,
	"Insert":       110,
	"PageDown":     109,
	"PageUp":       104,
	"F1":           59,
	"F2":           60,
	"F3":           61,
	"F4":           62,
	"F5":           63,
	"F6":           64,
	"F7":           65,
	"F8":           66,
	"F9":           67,
	"F10":          68,
	"F11":          87,
	"F12":          88,
}

var linuxKeyCodesByKey = map[string]int{
	"Alt":       56,
	"Backspace": 14,
	"Control":   29,
	"Delete":    111,
	"Enter":     28,
	"Meta":      125,
	"Shift":     42,
	"Tab":       15,
	" ":         57,
}

func inputPingResponse(body []byte) ([]byte, bool) {
	var msg inputPingMessage
	if err := json.Unmarshal(body, &msg); err != nil {
		return nil, false
	}
	if msg.Type != "input.ping" {
		return nil, false
	}
	response, err := json.Marshal(inputPingMessage{Type: "input.pong", Seq: msg.Seq})
	if err != nil {
		return nil, false
	}
	return response, true
}

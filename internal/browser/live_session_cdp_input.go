package browser

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/chromedp/cdproto"
	cdpinput "github.com/chromedp/cdproto/input"
	"github.com/chromedp/cdproto/target"
	remoteinput "github.com/tarik02/webdesktop/input"
)

const liveSessionCDPInputTimeout = 5 * time.Second

type liveSessionCDPInput struct {
	port        int
	connection  *liveSessionCDP
	targetID    string
	sessionID   target.SessionID
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
		if err := input.execute("", func(ctx context.Context) error {
			return target.DetachFromTarget().WithSessionID(input.sessionID).Do(ctx)
		}); err != nil {
			input.closeConnection()
			return err
		}
		input.sessionID = ""
		input.targetID = ""
	}
	var sessionID target.SessionID
	if err := input.execute("", func(ctx context.Context) error {
		var err error
		sessionID, err = target.AttachToTarget(target.ID(targetID)).WithFlatten(true).Do(ctx)
		return err
	}); err != nil {
		input.closeConnection()
		return err
	}
	if sessionID == "" {
		input.closeConnection()
		return errors.New("CDP input target attachment omitted session id")
	}
	input.targetID = targetID
	input.sessionID = sessionID
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
	var targetInfos []*target.Info
	if err := input.execute("", func(ctx context.Context) error {
		var err error
		targetInfos, err = target.GetTargets().Do(ctx)
		return err
	}); err != nil {
		input.closeConnection()
		return false, err
	}
	for _, targetInfo := range targetInfos {
		if string(targetInfo.TargetID) == targetID && isUserCDPTarget(targetInfo) {
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
		button := cdpinput.None
		switch {
		case input.buttons&1 != 0:
			button = cdpinput.Left
		case input.buttons&2 != 0:
			button = cdpinput.Right
		case input.buttons&4 != 0:
			button = cdpinput.Middle
		}
		params := cdpinput.DispatchMouseEvent(cdpinput.MouseMoved, input.pointerX, input.pointerY).
			WithButton(button).
			WithButtons(int64(input.buttons)).
			WithModifiers(cdpinput.Modifier(message.Modifiers))
		return input.send(cdproto.MethodType(cdpinput.CommandDispatchMouseEvent), params, input.sessionID)
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
		eventType := cdpinput.MouseReleased
		if message.Pressed {
			eventType = cdpinput.MousePressed
		}
		params := cdpinput.DispatchMouseEvent(eventType, input.pointerX, input.pointerY).
			WithButton(button).
			WithButtons(int64(input.buttons)).
			WithClickCount(int64(clickCount)).
			WithModifiers(cdpinput.Modifier(message.Modifiers))
		return input.execute(input.sessionID, params.Do)
	case "input.pointer.scroll":
		if message.Width <= 0 || message.Height <= 0 || message.X < 0 || message.X > 1 || message.Y < 0 || message.Y > 1 {
			return errors.New("pointer position is invalid")
		}
		input.pointerX = message.X * message.Width
		input.pointerY = message.Y * message.Height
		if message.Horizontal == 0 && message.Vertical == 0 {
			return nil
		}
		params := cdpinput.DispatchMouseEvent(cdpinput.MouseWheel, input.pointerX, input.pointerY).
			WithButton(cdpinput.None).
			WithButtons(int64(input.buttons)).
			WithDeltaX(message.Horizontal).
			WithDeltaY(message.Vertical).
			WithModifiers(cdpinput.Modifier(message.Modifiers))
		return input.send(cdproto.MethodType(cdpinput.CommandDispatchMouseEvent), params, input.sessionID)
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
		return input.execute(input.sessionID, cdpinput.InsertText(message.Text).Do)
	default:
		return errors.New("unsupported CDP input event")
	}
}

func (input *liveSessionCDPInput) dispatchKey(message liveSessionClientMessage) error {
	eventType := cdpinput.KeyRawDown
	if !message.Pressed {
		eventType = cdpinput.KeyUp
	} else if message.Text != "" {
		eventType = cdpinput.KeyDown
	}
	params := cdpinput.DispatchKeyEvent(eventType).
		WithModifiers(cdpinput.Modifier(message.Modifiers)).
		WithWindowsVirtualKeyCode(int64(message.WindowsVirtualKeyCode)).
		WithNativeVirtualKeyCode(int64(message.NativeVirtualKeyCode)).
		WithAutoRepeat(message.AutoRepeat).
		WithIsKeypad(message.IsKeypad).
		WithKey(message.Key).
		WithCode(message.Code).
		WithText(message.Text).
		WithUnmodifiedText(message.UnmodifiedText).
		WithLocation(int64(message.Location))
	return input.execute(input.sessionID, params.Do)
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
		name cdpinput.MouseButton
		mask int
	}{
		{name: cdpinput.Left, mask: 1},
		{name: cdpinput.Right, mask: 2},
		{name: cdpinput.Middle, mask: 4},
	} {
		if input.buttons&button.mask == 0 {
			continue
		}
		input.buttons &^= button.mask
		params := cdpinput.DispatchMouseEvent(cdpinput.MouseReleased, input.pointerX, input.pointerY).
			WithButton(button.name).
			WithButtons(int64(input.buttons)).
			WithClickCount(1)
		if err := input.execute(input.sessionID, params.Do); err != nil {
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

func (input *liveSessionCDPInput) execute(sessionID target.SessionID, action func(context.Context) error) error {
	if input.connection == nil {
		return errors.New("CDP input connection is unavailable")
	}
	ctx, cancel := context.WithTimeout(context.Background(), liveSessionCDPInputTimeout)
	defer cancel()
	return action(input.connection.executorContext(ctx, sessionID))
}

func (input *liveSessionCDPInput) send(method cdproto.MethodType, params any, sessionID target.SessionID) error {
	if input.connection == nil {
		return errors.New("CDP input connection is unavailable")
	}
	ctx, cancel := context.WithTimeout(context.Background(), liveSessionCDPInputTimeout)
	defer cancel()
	return input.connection.sendAsync(ctx, method, params, sessionID, true)
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

func liveSessionCDPMouseButton(code uint32) (cdpinput.MouseButton, int, bool) {
	switch code {
	case 272:
		return cdpinput.Left, 1, true
	case 273:
		return cdpinput.Right, 2, true
	case 274:
		return cdpinput.Middle, 4, true
	default:
		return cdpinput.None, 0, false
	}
}

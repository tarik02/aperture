package browser

import (
	"errors"
	"strings"

	remoteinput "github.com/tarik02/webdesktop/input"
)

type liveSessionCompositorInput struct {
	runtime    *wrapperRuntime
	controller *remoteinput.Controller
	sender     *compositorInputSender

	surfaceID  uint64
	generation uint64
	width      int
	height     int
	textKeys   map[uint32]struct{}
}

func newLiveSessionCompositorInput(runtime *wrapperRuntime) (*liveSessionCompositorInput, error) {
	controller, err := remoteinput.New(remoteinput.Config{
		Enabled:   true,
		Locking:   true,
		Pointer:   true,
		Keyboard:  true,
		QueueSize: 256,
	})
	if err != nil {
		return nil, err
	}
	sender := newCompositorInputSender(runtime.controlSocket, runtime.values.ViewportWidth, runtime.values.ViewportHeight)
	if err := controller.Attach(remoteinput.Authorization{Pointer: true, Keyboard: true}, sender); err != nil {
		_ = controller.Close()
		return nil, err
	}
	return &liveSessionCompositorInput{
		runtime:    runtime,
		controller: controller,
		sender:     sender,
		textKeys:   make(map[uint32]struct{}),
	}, nil
}

func (input *liveSessionCompositorInput) bind(ownerID uint64, targetID string, onRevoke func()) error {
	target, ok := input.readyTarget(targetID)
	if !ok {
		return remoteinput.ErrNotReady
	}
	targetUnchanged := input.surfaceID == target.SurfaceID &&
		input.generation == target.Generation &&
		input.width == target.Viewport.Width &&
		input.height == target.Viewport.Height
	ownsInput := input.controller.Owns(ownerID)
	if targetUnchanged && ownsInput {
		return nil
	}
	if ownsInput {
		if err := input.release(ownerID); err != nil {
			return err
		}
	}
	input.sender.SetTarget(target.SurfaceID, target.Viewport.Width, target.Viewport.Height)
	if _, err := input.controller.Acquire(ownerID, func(uint64, error) {
		onRevoke()
	}); err != nil {
		return err
	}
	input.surfaceID = target.SurfaceID
	input.generation = target.Generation
	input.width = target.Viewport.Width
	input.height = target.Viewport.Height
	return nil
}

func (input *liveSessionCompositorInput) submit(ownerID uint64, message liveSessionClientMessage) error {
	event := remoteinput.Event{Sequence: message.Sequence * 2}
	switch message.Type {
	case "input.pointer.motion.absolute":
		event.Type = remoteinput.EventPointerAbsolute
		event.X = message.X
		event.Y = message.Y
	case "input.pointer.button":
		if message.X < 0 || message.X > 1 || message.Y < 0 || message.Y > 1 {
			return errors.New("pointer position is invalid")
		}
		if err := input.controller.Submit(ownerID, remoteinput.Event{
			Sequence: message.Sequence*2 - 1,
			Type:     remoteinput.EventPointerAbsolute,
			X:        message.X,
			Y:        message.Y,
		}); err != nil {
			return err
		}
		event.Type = remoteinput.EventPointerButton
		event.ButtonCode = message.ButtonCode
		event.Pressed = message.Pressed
	case "input.pointer.scroll":
		if message.X < 0 || message.X > 1 || message.Y < 0 || message.Y > 1 {
			return errors.New("pointer position is invalid")
		}
		if err := input.controller.Submit(ownerID, remoteinput.Event{
			Sequence: message.Sequence*2 - 1,
			Type:     remoteinput.EventPointerAbsolute,
			X:        message.X,
			Y:        message.Y,
		}); err != nil {
			return err
		}
		event.Type = remoteinput.EventPointerScroll
		event.Horizontal = message.Horizontal
		event.Vertical = message.Vertical
		event.StopHorizontal = message.StopHorizontal
		event.StopVertical = message.StopVertical
	case "input.keyboard.key":
		if message.Pressed && message.Text != "" {
			input.textKeys[message.Keycode] = struct{}{}
			event.Type = remoteinput.EventKeyboardText
			event.Text = message.Text
			break
		}
		if !message.Pressed {
			if _, textKey := input.textKeys[message.Keycode]; textKey {
				delete(input.textKeys, message.Keycode)
				return nil
			}
		}
		event.Type = remoteinput.EventKeyboardKey
		event.Keycode = message.Keycode
		event.Pressed = message.Pressed
	case "input.keyboard.text":
		event.Type = remoteinput.EventKeyboardText
		event.Text = message.Text
	default:
		return errors.New("unsupported compositor input event")
	}
	return input.controller.Submit(ownerID, event)
}

func (input *liveSessionCompositorInput) hasTarget(targetID string) (bool, error) {
	input.runtime.mu.Lock()
	registry := input.runtime.targets
	input.runtime.mu.Unlock()
	if registry == nil || strings.TrimSpace(targetID) == "" {
		return false, nil
	}
	return registry.hasLiveTarget(targetID), nil
}

func (input *liveSessionCompositorInput) release(ownerID uint64) error {
	err := input.controller.Release(ownerID)
	clear(input.textKeys)
	return err
}

func (input *liveSessionCompositorInput) close() error {
	return input.controller.Close()
}

func (input *liveSessionCompositorInput) readyTarget(targetID string) (wrapperTargetSnapshot, bool) {
	input.runtime.mu.Lock()
	registry := input.runtime.targets
	input.runtime.mu.Unlock()
	if registry == nil || strings.TrimSpace(targetID) == "" {
		return wrapperTargetSnapshot{}, false
	}
	return registry.readyTarget(targetID)
}

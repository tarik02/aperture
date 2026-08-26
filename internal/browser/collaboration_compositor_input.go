package browser

import (
	"errors"
	"strings"

	remoteinput "github.com/tarik02/webdesktop/input"
)

type collaborationCompositorInput struct {
	runtime    *wrapperRuntime
	controller *remoteinput.Controller
	sender     *compositorInputSender

	surfaceID  uint64
	generation uint64
	width      int
	height     int
}

func newCollaborationCompositorInput(runtime *wrapperRuntime) (*collaborationCompositorInput, error) {
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
	sender := newCompositorInputSender(runtime.controlSocket, runtime.values.CompositorWidth, runtime.values.CompositorHeight)
	if err := controller.Attach(remoteinput.Authorization{Pointer: true, Keyboard: true}, sender); err != nil {
		_ = controller.Close()
		return nil, err
	}
	return &collaborationCompositorInput{
		runtime:    runtime,
		controller: controller,
		sender:     sender,
	}, nil
}

func (input *collaborationCompositorInput) bind(ownerID uint64, targetID string, onRevoke func()) error {
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
		if err := input.controller.Release(ownerID); err != nil {
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

func (input *collaborationCompositorInput) submit(ownerID uint64, message collaborationClientMessage) error {
	event := remoteinput.Event{Sequence: message.Sequence}
	switch message.Type {
	case "input.pointer.motion.absolute":
		event.Type = remoteinput.EventPointerAbsolute
		event.X = message.X
		event.Y = message.Y
	case "input.pointer.button":
		event.Type = remoteinput.EventPointerButton
		event.ButtonCode = message.ButtonCode
		event.Pressed = message.Pressed
	case "input.pointer.scroll":
		event.Type = remoteinput.EventPointerScroll
		event.Horizontal = message.Horizontal
		event.Vertical = message.Vertical
		event.StopHorizontal = message.StopHorizontal
		event.StopVertical = message.StopVertical
	case "input.keyboard.key":
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

func (input *collaborationCompositorInput) release(ownerID uint64) error {
	return input.controller.Release(ownerID)
}

func (input *collaborationCompositorInput) close() error {
	return input.controller.Close()
}

func (input *collaborationCompositorInput) readyTarget(targetID string) (wrapperTargetSnapshot, bool) {
	input.runtime.mu.Lock()
	registry := input.runtime.targets
	input.runtime.mu.Unlock()
	if registry == nil || strings.TrimSpace(targetID) == "" {
		return wrapperTargetSnapshot{}, false
	}
	return registry.readyTarget(targetID)
}

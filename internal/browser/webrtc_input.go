package browser

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"

	remoteinput "github.com/tarik02/webdesktop/input"
)

type compositorInputSender struct {
	controlSocket string
	done          chan struct{}
	changes       chan struct{}
	closeOnce     sync.Once
	mu            sync.Mutex
	width         int
	height        int
	surfaceID     uint64
	pointerX      float64
	pointerY      float64
	pointerSet    bool
	closed        bool
}

type targetInputController struct {
	controlSocket string
	targets       *targetMediaSource
	mu            sync.Mutex
	inputs        map[string]*targetInput
	owners        map[uint64]string
	closed        bool
}

type targetInput struct {
	controller *remoteinput.Controller
	sender     *compositorInputSender
}

func newCompositorInputSender(controlSocket string, width int, height int) *compositorInputSender {
	return &compositorInputSender{
		controlSocket: controlSocket,
		done:          make(chan struct{}),
		changes:       make(chan struct{}, 1),
		width:         width,
		height:        height,
	}
}

func (s *compositorInputSender) Done() <-chan struct{} {
	return s.done
}

func (s *compositorInputSender) Changes() <-chan struct{} {
	return s.changes
}

func (s *compositorInputSender) Status() remoteinput.SenderStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	return remoteinput.SenderStatus{
		Connected: !s.closed,
		Pointer:   !s.closed,
		Keyboard:  !s.closed,
	}
}

func (s *compositorInputSender) SetTarget(surfaceID uint64, width int, height int) {
	s.mu.Lock()
	s.surfaceID = surfaceID
	s.width = width
	s.height = height
	s.mu.Unlock()
}

func (s *compositorInputSender) PointerAbsolute(x float64, y float64) error {
	s.mu.Lock()
	width := s.width
	height := s.height
	surfaceID := s.surfaceID
	closed := s.closed
	s.pointerX = x
	s.pointerY = y
	s.pointerSet = true
	s.mu.Unlock()
	if closed {
		return errors.New("compositor input sender is closed")
	}
	if surfaceID == 0 {
		return errors.New("compositor input target is unavailable")
	}
	_, err := sendCompositorControlCommand(
		context.Background(),
		s.controlSocket,
		fmt.Sprintf("motion %d %.3f %.3f\n", surfaceID, x*float64(width), y*float64(height)),
	)
	return err
}

func (*compositorInputSender) PointerRelative(float64, float64) error {
	return errors.New("relative pointer input is unsupported")
}

func (s *compositorInputSender) Button(code uint32, pressed bool) error {
	s.mu.Lock()
	width := s.width
	height := s.height
	surfaceID := s.surfaceID
	pointerX := s.pointerX
	pointerY := s.pointerY
	pointerSet := s.pointerSet
	closed := s.closed
	s.mu.Unlock()
	if closed {
		return errors.New("compositor input sender is closed")
	}
	if surfaceID == 0 {
		return errors.New("compositor input target is unavailable")
	}
	pressedValue := 0
	if pressed {
		pressedValue = 1
	}
	command := fmt.Sprintf("button %d %d %d\n", surfaceID, code, pressedValue)
	if pointerSet {
		command = fmt.Sprintf("button-at %d %.3f %.3f %d %d\n", surfaceID, pointerX*float64(width), pointerY*float64(height), code, pressedValue)
	}
	_, err := sendCompositorControlCommand(
		context.Background(),
		s.controlSocket,
		command,
	)
	return err
}

func (s *compositorInputSender) Scroll(horizontal float64, vertical float64, _ bool, _ bool) error {
	if horizontal == 0 && vertical == 0 {
		return nil
	}
	s.mu.Lock()
	width := s.width
	height := s.height
	surfaceID := s.surfaceID
	pointerX := s.pointerX
	pointerY := s.pointerY
	pointerSet := s.pointerSet
	closed := s.closed
	s.mu.Unlock()
	if closed {
		return errors.New("compositor input sender is closed")
	}
	if surfaceID == 0 {
		return errors.New("compositor input target is unavailable")
	}
	command := fmt.Sprintf("axis %d %.3f %.3f\n", surfaceID, horizontal, vertical)
	if pointerSet {
		command = fmt.Sprintf("axis-at %d %.3f %.3f %.3f %.3f\n", surfaceID, pointerX*float64(width), pointerY*float64(height), horizontal, vertical)
	}
	_, err := sendCompositorControlCommand(
		context.Background(),
		s.controlSocket,
		command,
	)
	return err
}

func (s *compositorInputSender) KeyboardKey(keycode uint32, pressed bool) error {
	s.mu.Lock()
	surfaceID := s.surfaceID
	closed := s.closed
	s.mu.Unlock()
	if closed {
		return errors.New("compositor input sender is closed")
	}
	if surfaceID == 0 {
		return errors.New("compositor input target is unavailable")
	}
	pressedValue := 0
	if pressed {
		pressedValue = 1
	}
	_, err := sendCompositorControlCommand(
		context.Background(),
		s.controlSocket,
		fmt.Sprintf("key %d %d %d\n", surfaceID, keycode, pressedValue),
	)
	return err
}

func (s *compositorInputSender) KeyboardText(text string) error {
	s.mu.Lock()
	surfaceID := s.surfaceID
	closed := s.closed
	s.mu.Unlock()
	if closed {
		return errors.New("compositor input sender is closed")
	}
	if surfaceID == 0 {
		return errors.New("compositor input target is unavailable")
	}
	_, err := sendCompositorControlCommand(
		context.Background(),
		s.controlSocket,
		fmt.Sprintf("text %d %s\n", surfaceID, hex.EncodeToString([]byte(text))),
	)
	return err
}

func (controller *targetInputController) Acquire(owner uint64, revoke func(uint64, error)) (remoteinput.Capabilities, error) {
	target, exists := controller.targets.SelectedTarget(owner)
	if !exists {
		return remoteinput.Capabilities{}, remoteinput.ErrNotReady
	}

	controller.mu.Lock()
	if controller.closed {
		controller.mu.Unlock()
		return remoteinput.Capabilities{}, remoteinput.ErrClosed
	}
	if previousTargetID, owned := controller.owners[owner]; owned {
		delete(controller.owners, owner)
		_ = controller.inputs[previousTargetID].controller.Release(owner)
	}

	input := controller.inputs[target.TargetID]
	if input == nil {
		inputController, err := remoteinput.New(remoteinput.Config{
			Enabled:   true,
			Locking:   false,
			Pointer:   true,
			Keyboard:  true,
			QueueSize: 256,
		})
		if err != nil {
			controller.mu.Unlock()
			return remoteinput.Capabilities{}, err
		}
		sender := newCompositorInputSender(
			controller.controlSocket,
			target.Viewport.Width,
			target.Viewport.Height,
		)
		if err := inputController.Attach(remoteinput.Authorization{Pointer: true, Keyboard: true}, sender); err != nil {
			controller.mu.Unlock()
			_ = inputController.Close()
			return remoteinput.Capabilities{}, err
		}
		input = &targetInput{controller: inputController, sender: sender}
		controller.inputs[target.TargetID] = input
	}
	input.sender.SetTarget(target.SurfaceID, target.Viewport.Width, target.Viewport.Height)
	capabilities, err := input.controller.Acquire(owner, func(sequence uint64, cause error) {
		controller.mu.Lock()
		if controller.owners[owner] == target.TargetID {
			delete(controller.owners, owner)
		}
		controller.mu.Unlock()
		revoke(sequence, cause)
	})
	if err != nil {
		controller.mu.Unlock()
		return remoteinput.Capabilities{}, err
	}
	controller.owners[owner] = target.TargetID
	controller.mu.Unlock()
	return capabilities, nil
}

func (controller *targetInputController) Release(owner uint64) error {
	controller.mu.Lock()
	targetID, owned := controller.owners[owner]
	if !owned {
		controller.mu.Unlock()
		return remoteinput.ErrNotOwner
	}
	delete(controller.owners, owner)
	input := controller.inputs[targetID]
	controller.mu.Unlock()
	return input.controller.Release(owner)
}

func (controller *targetInputController) Owns(owner uint64) bool {
	controller.mu.Lock()
	targetID, owned := controller.owners[owner]
	input := controller.inputs[targetID]
	controller.mu.Unlock()
	return owned && input.controller.Owns(owner)
}

func (controller *targetInputController) Submit(owner uint64, event remoteinput.Event) error {
	target, exists := controller.targets.SelectedTarget(owner)
	if !exists {
		return remoteinput.ErrNotReady
	}
	controller.mu.Lock()
	targetID, owned := controller.owners[owner]
	input := controller.inputs[targetID]
	controller.mu.Unlock()
	if !owned || targetID != target.TargetID {
		return remoteinput.ErrNotReady
	}
	input.sender.SetTarget(target.SurfaceID, target.Viewport.Width, target.Viewport.Height)
	return input.controller.Submit(owner, event)
}

func (controller *targetInputController) Close() error {
	controller.mu.Lock()
	if controller.closed {
		controller.mu.Unlock()
		return nil
	}
	controller.closed = true
	inputs := controller.inputs
	controller.inputs = make(map[string]*targetInput)
	controller.owners = make(map[uint64]string)
	controller.mu.Unlock()

	var closeErr error
	for _, input := range inputs {
		closeErr = errors.Join(closeErr, input.controller.Close())
	}
	return closeErr
}

func (s *compositorInputSender) Close() error {
	s.closeOnce.Do(func() {
		s.mu.Lock()
		s.closed = true
		s.mu.Unlock()
		close(s.done)
	})
	return nil
}

var _ remoteinput.Sender = (*compositorInputSender)(nil)
var _ remoteinput.KeyboardTextSender = (*compositorInputSender)(nil)

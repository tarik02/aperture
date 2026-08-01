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
	closed        bool
}

type targetInputController struct {
	controller *remoteinput.Controller
	sender     *compositorInputSender
	targets    *targetMediaSource
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
		fmt.Sprintf("button %d %d %d\n", surfaceID, code, pressedValue),
	)
	return err
}

func (s *compositorInputSender) Scroll(horizontal float64, vertical float64, _ bool, _ bool) error {
	if horizontal == 0 && vertical == 0 {
		return nil
	}
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
		fmt.Sprintf("axis %d %.3f %.3f\n", surfaceID, horizontal, vertical),
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
	controller.sender.SetTarget(target.SurfaceID, target.Viewport.Width, target.Viewport.Height)
	return controller.controller.Acquire(owner, revoke)
}

func (controller *targetInputController) Release(owner uint64) error {
	return controller.controller.Release(owner)
}

func (controller *targetInputController) Owns(owner uint64) bool {
	return controller.controller.Owns(owner)
}

func (controller *targetInputController) Submit(owner uint64, event remoteinput.Event) error {
	target, exists := controller.targets.SelectedTarget(owner)
	if !exists {
		return remoteinput.ErrNotReady
	}
	controller.sender.SetTarget(target.SurfaceID, target.Viewport.Width, target.Viewport.Height)
	return controller.controller.Submit(owner, event)
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

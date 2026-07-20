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
	closed        bool
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

func (s *compositorInputSender) SetViewport(width int, height int) {
	s.mu.Lock()
	s.width = width
	s.height = height
	s.mu.Unlock()
}

func (s *compositorInputSender) PointerAbsolute(x float64, y float64) error {
	s.mu.Lock()
	width := s.width
	height := s.height
	closed := s.closed
	s.mu.Unlock()
	if closed {
		return errors.New("compositor input sender is closed")
	}
	_, err := sendCompositorControlCommand(
		context.Background(),
		s.controlSocket,
		fmt.Sprintf("motion %.3f %.3f\n", x*float64(width), y*float64(height)),
	)
	return err
}

func (*compositorInputSender) PointerRelative(float64, float64) error {
	return errors.New("relative pointer input is unsupported")
}

func (s *compositorInputSender) Button(code uint32, pressed bool) error {
	pressedValue := 0
	if pressed {
		pressedValue = 1
	}
	_, err := sendCompositorControlCommand(
		context.Background(),
		s.controlSocket,
		fmt.Sprintf("button %d %d\n", code, pressedValue),
	)
	return err
}

func (s *compositorInputSender) Scroll(horizontal float64, vertical float64, _ bool, _ bool) error {
	if horizontal == 0 && vertical == 0 {
		return nil
	}
	_, err := sendCompositorControlCommand(
		context.Background(),
		s.controlSocket,
		fmt.Sprintf("axis %.3f %.3f\n", horizontal, vertical),
	)
	return err
}

func (s *compositorInputSender) KeyboardKey(keycode uint32, pressed bool) error {
	pressedValue := 0
	if pressed {
		pressedValue = 1
	}
	_, err := sendCompositorControlCommand(
		context.Background(),
		s.controlSocket,
		fmt.Sprintf("key %d %d\n", keycode, pressedValue),
	)
	return err
}

func (s *compositorInputSender) KeyboardText(text string) error {
	_, err := sendCompositorControlCommand(
		context.Background(),
		s.controlSocket,
		fmt.Sprintf("text %s\n", hex.EncodeToString([]byte(text))),
	)
	return err
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

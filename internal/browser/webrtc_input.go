package browser

import (
	"context"
	"errors"
	"sync"

	remoteinput "github.com/tarik02/webdesktop/input"
)

// compositorInputSender delivers a human's input, in coordinates normalized to the target's
// viewport, to the shared compositor pointer.
type compositorInputSender struct {
	pointer   *compositorPointer
	done      chan struct{}
	changes   chan struct{}
	closeOnce sync.Once
	mu        sync.Mutex
	width     int
	height    int
	surfaceID uint64
	closed    bool
}

func newCompositorInputSender(pointer *compositorPointer, width int, height int) *compositorInputSender {
	return &compositorInputSender{
		pointer: pointer,
		done:    make(chan struct{}),
		changes: make(chan struct{}, 1),
		width:   width,
		height:  height,
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

// target is the surface input goes to and the viewport size that scales normalized coordinates to it.
func (s *compositorInputSender) target() (uint64, float64, float64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return 0, 0, 0, errors.New("compositor input sender is closed")
	}
	if s.surfaceID == 0 {
		return 0, 0, 0, errors.New("compositor input target is unavailable")
	}
	return s.surfaceID, float64(s.width), float64(s.height), nil
}

func (s *compositorInputSender) PointerAbsolute(x float64, y float64) error {
	surfaceID, width, height, err := s.target()
	if err != nil {
		return err
	}
	return s.pointer.motion(context.Background(), surfaceID, cdpPoint{x * width, y * height})
}

func (*compositorInputSender) PointerRelative(float64, float64) error {
	return errors.New("relative pointer input is unsupported")
}

func (s *compositorInputSender) Button(code uint32, pressed bool) error {
	surfaceID, _, _, err := s.target()
	if err != nil {
		return err
	}
	if at, known := s.pointer.position(surfaceID); known {
		return s.pointer.buttonAt(context.Background(), surfaceID, at, code, pressed)
	}
	return s.pointer.button(context.Background(), surfaceID, code, pressed)
}

func (s *compositorInputSender) Scroll(horizontal float64, vertical float64, _ bool, _ bool) error {
	if horizontal == 0 && vertical == 0 {
		return nil
	}
	surfaceID, _, _, err := s.target()
	if err != nil {
		return err
	}
	if at, known := s.pointer.position(surfaceID); known {
		return s.pointer.axisAt(context.Background(), surfaceID, at, horizontal, vertical)
	}
	return s.pointer.axis(context.Background(), surfaceID, horizontal, vertical)
}

func (s *compositorInputSender) KeyboardKey(keycode uint32, pressed bool) error {
	surfaceID, _, _, err := s.target()
	if err != nil {
		return err
	}
	return s.pointer.key(context.Background(), surfaceID, keycode, pressed)
}

func (s *compositorInputSender) KeyboardText(text string) error {
	surfaceID, _, _, err := s.target()
	if err != nil {
		return err
	}
	return s.pointer.text(context.Background(), surfaceID, text)
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

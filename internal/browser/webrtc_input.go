package browser

import (
	"bufio"
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	remoteinput "github.com/tarik02/webdesktop/input"
)

type compositorInputSender struct {
	connection *compositorInputConnection
	done       chan struct{}
	changes    chan struct{}
	closeOnce  sync.Once
	mu         sync.Mutex
	width      int
	height     int
	surfaceID  uint64
	pointerX   float64
	pointerY   float64
	pointerSet bool
	closed     bool
}

type compositorInputConnection struct {
	socketPath string
	mu         sync.Mutex
	conn       net.Conn
	reader     *bufio.Reader
}

type targetInputController struct {
	controlSocket string
	targets       *targetMediaSource
	mu            sync.Mutex
	inputs        map[string]*targetInput
	owners        map[uint64]string
	ownerClaims   map[uint64]uint64
	nextClaim     uint64
	retired       map[string]struct{}
	closed        bool
}

type targetInput struct {
	controller *remoteinput.Controller
	sender     *compositorInputSender
	submitMu   sync.Mutex
	retiring   atomic.Bool
}

func newCompositorInputSender(controlSocket string, width int, height int) *compositorInputSender {
	return &compositorInputSender{
		connection: &compositorInputConnection{socketPath: controlSocket},
		done:       make(chan struct{}),
		changes:    make(chan struct{}, 1),
		width:      width,
		height:     height,
	}
}

func (c *compositorInputConnection) send(ctx context.Context, command string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	c.mu.Lock()
	defer c.mu.Unlock()

	for attempt := 0; attempt < 2; attempt++ {
		if c.conn == nil {
			conn, err := (&net.Dialer{}).DialContext(ctx, "unix", c.socketPath)
			if err != nil {
				return "", fmt.Errorf("dial compositor input socket: %w", err)
			}
			c.conn = conn
			c.reader = bufio.NewReader(conn)
		}
		if deadline, ok := ctx.Deadline(); ok {
			if err := c.conn.SetDeadline(deadline); err != nil {
				c.reset()
				return "", fmt.Errorf("set compositor input deadline: %w", err)
			}
		}

		n, err := io.WriteString(c.conn, command)
		if err == nil && n == len(command) {
			break
		}
		c.reset()
		if n != 0 || attempt == 1 {
			if err != nil {
				return "", fmt.Errorf("send compositor input command: %w", err)
			}
			return "", fmt.Errorf("send compositor input command: %w", io.ErrShortWrite)
		}
	}

	response, err := c.reader.ReadString('\n')
	if err != nil {
		c.reset()
		return "", fmt.Errorf("read compositor input response: %w", err)
	}
	response = strings.TrimSpace(response)
	if !strings.HasPrefix(response, "ok") {
		return "", fmt.Errorf("compositor input rejected: %s", response)
	}
	return response, nil
}

func (c *compositorInputConnection) close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.reset()
}

func (c *compositorInputConnection) reset() {
	if c.conn != nil {
		_ = c.conn.Close()
	}
	c.conn = nil
	c.reader = nil
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
	_, err := s.connection.send(
		context.Background(),
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
	_, err := s.connection.send(
		context.Background(),
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
	_, err := s.connection.send(
		context.Background(),
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
	_, err := s.connection.send(
		context.Background(),
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
	_, err := s.connection.send(
		context.Background(),
		fmt.Sprintf("text %d %s\n", surfaceID, hex.EncodeToString([]byte(text))),
	)
	return err
}

func (controller *targetInputController) removeUnusedInputLocked(targetID string, expected *targetInput) *targetInput {
	for _, ownedTargetID := range controller.owners {
		if ownedTargetID == targetID {
			return nil
		}
	}
	input := controller.inputs[targetID]
	if expected != nil && input != expected {
		return nil
	}
	if input != nil {
		input.retiring.Store(true)
		delete(controller.inputs, targetID)
	}
	return input
}

func closeTargetInput(input *targetInput) error {
	if input == nil {
		return nil
	}
	input.submitMu.Lock()
	defer input.submitMu.Unlock()
	return input.controller.Close()
}

func closeTargetInputAsync(input *targetInput) {
	if input == nil {
		return
	}
	go func() { _ = closeTargetInput(input) }()
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
	// The target may have been removed after the optimistic snapshot above.
	// Recheck while holding the controller lock so RemoveTarget can linearize
	// before this acquisition and prevent recreating a retired input.
	target, exists = controller.targets.SelectedTarget(owner)
	if !exists {
		controller.mu.Unlock()
		return remoteinput.Capabilities{}, remoteinput.ErrNotReady
	}
	if _, retired := controller.retired[target.TargetID]; retired {
		controller.mu.Unlock()
		return remoteinput.Capabilities{}, remoteinput.ErrNotReady
	}
	var previousInput *targetInput
	if previousTargetID, owned := controller.owners[owner]; owned {
		delete(controller.owners, owner)
		delete(controller.ownerClaims, owner)
		input := controller.inputs[previousTargetID]
		if input != nil {
			_ = input.controller.Release(owner)
			if previousTargetID != target.TargetID {
				previousInput = controller.removeUnusedInputLocked(previousTargetID, input)
			}
		}
	}

	input := controller.inputs[target.TargetID]
	if input != nil && input.retiring.Load() {
		delete(controller.inputs, target.TargetID)
		previousInput = input
		input = nil
	}
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
			_ = closeTargetInput(previousInput)
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
			_ = closeTargetInput(previousInput)
			return remoteinput.Capabilities{}, err
		}
		input = &targetInput{controller: inputController, sender: sender}
		controller.inputs[target.TargetID] = input
	}
	input.sender.SetTarget(target.SurfaceID, target.Viewport.Width, target.Viewport.Height)
	controller.nextClaim++
	claim := controller.nextClaim
	capabilities, err := input.controller.Acquire(owner, func(sequence uint64, cause error) {
		controller.mu.Lock()
		if controller.inputs[target.TargetID] != input ||
			controller.ownerClaims[owner] != claim {
			controller.mu.Unlock()
			return
		}
		if controller.owners[owner] == target.TargetID {
			delete(controller.owners, owner)
			delete(controller.ownerClaims, owner)
		}
		retire := controller.removeUnusedInputLocked(target.TargetID, input)
		controller.mu.Unlock()
		closeTargetInputAsync(retire)
		revoke(sequence, cause)
	})
	if err != nil {
		controller.mu.Unlock()
		_ = closeTargetInput(previousInput)
		return remoteinput.Capabilities{}, err
	}
	if input.retiring.Load() {
		_ = input.controller.Release(owner)
		controller.mu.Unlock()
		_ = closeTargetInput(previousInput)
		return remoteinput.Capabilities{}, remoteinput.ErrNotReady
	}
	controller.owners[owner] = target.TargetID
	if controller.ownerClaims == nil {
		controller.ownerClaims = make(map[uint64]uint64)
	}
	controller.ownerClaims[owner] = claim
	controller.mu.Unlock()
	_ = closeTargetInput(previousInput)
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
	delete(controller.ownerClaims, owner)
	input := controller.inputs[targetID]
	retire := controller.removeUnusedInputLocked(targetID, input)
	controller.mu.Unlock()
	if input == nil {
		return remoteinput.ErrNotReady
	}
	err := input.controller.Release(owner)
	if retire != nil {
		err = errors.Join(err, closeTargetInput(retire))
	}
	return err
}

func (controller *targetInputController) RemoveTarget(targetID string) error {
	controller.mu.Lock()
	if controller.retired == nil {
		controller.retired = make(map[string]struct{})
	}
	controller.retired[targetID] = struct{}{}
	input := controller.inputs[targetID]
	if input != nil {
		input.retiring.Store(true)
	}
	delete(controller.inputs, targetID)
	for owner, ownedTargetID := range controller.owners {
		if ownedTargetID == targetID {
			delete(controller.owners, owner)
			delete(controller.ownerClaims, owner)
		}
	}
	controller.mu.Unlock()
	return closeTargetInput(input)
}

func (controller *targetInputController) Owns(owner uint64) bool {
	controller.mu.Lock()
	targetID, owned := controller.owners[owner]
	input := controller.inputs[targetID]
	controller.mu.Unlock()
	return owned && input != nil && input.controller.Owns(owner)
}

func (controller *targetInputController) Submit(owner uint64, event remoteinput.Event) error {
	controller.mu.Lock()
	if controller.closed {
		controller.mu.Unlock()
		return remoteinput.ErrClosed
	}
	target, exists := controller.targets.SelectedTarget(owner)
	if !exists {
		controller.mu.Unlock()
		return remoteinput.ErrNotReady
	}
	targetID, owned := controller.owners[owner]
	input := controller.inputs[targetID]
	if !owned || targetID != target.TargetID || input == nil || input.retiring.Load() {
		controller.mu.Unlock()
		return remoteinput.ErrNotReady
	}
	input.sender.SetTarget(target.SurfaceID, target.Viewport.Width, target.Viewport.Height)
	input.submitMu.Lock()
	controller.mu.Unlock()
	defer input.submitMu.Unlock()
	if input.retiring.Load() {
		return remoteinput.ErrNotReady
	}
	return input.controller.Submit(owner, event)
}

func (controller *targetInputController) RestoreTarget(targetID string) {
	controller.mu.Lock()
	delete(controller.retired, targetID)
	controller.mu.Unlock()
}

func (controller *targetInputController) Close() error {
	controller.mu.Lock()
	if controller.closed {
		controller.mu.Unlock()
		return nil
	}
	controller.closed = true
	inputs := controller.inputs
	if controller.retired == nil {
		controller.retired = make(map[string]struct{})
	}
	for targetID := range inputs {
		controller.retired[targetID] = struct{}{}
	}
	for _, input := range inputs {
		input.retiring.Store(true)
	}
	controller.inputs = make(map[string]*targetInput)
	controller.owners = make(map[uint64]string)
	controller.ownerClaims = make(map[uint64]uint64)
	controller.mu.Unlock()

	var closeErr error
	for _, input := range inputs {
		closeErr = errors.Join(closeErr, closeTargetInput(input))
	}
	return closeErr
}

func (s *compositorInputSender) Close() error {
	s.closeOnce.Do(func() {
		s.mu.Lock()
		s.closed = true
		s.mu.Unlock()
		s.connection.close()
		close(s.done)
	})
	return nil
}

var _ remoteinput.Sender = (*compositorInputSender)(nil)
var _ remoteinput.KeyboardTextSender = (*compositorInputSender)(nil)

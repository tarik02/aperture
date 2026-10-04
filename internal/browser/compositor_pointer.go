package browser

import (
	"context"
	"encoding/hex"
	"fmt"
	"math"
	"sync"
)

// compositorAxisPxPerUnit is how far Weston scrolls per axis unit, measured in Chromium.
const compositorAxisPxPerUnit = 12.0

// Wayland transports axis values as 24.8 fixed point. Rounding down here makes Chromium
// truncate 100 px to 99 px (and 1 px to zero); round the magnitude up to the next wire unit.
func compositorAxisUnits(pixels float64) float64 {
	return math.Copysign(math.Ceil(math.Abs(pixels)/compositorAxisPxPerUnit*256)/256, pixels)
}

type cdpPoint struct{ x, y float64 }

// compositorPointer is the compositor's one real pointer and keyboard, driven over the control
// socket. It keeps where the pointer last was on each surface, so a human moving it and automation
// gliding it continue from the same spot. Coordinates are surface px (CSS px of the viewport).
type compositorPointer struct {
	socket string

	mu        sync.Mutex
	positions map[uint64]cdpPoint
}

func newCompositorPointer(socket string) *compositorPointer {
	return &compositorPointer{socket: socket, positions: make(map[uint64]cdpPoint)}
}

func (p *compositorPointer) position(surface uint64) (cdpPoint, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	at, known := p.positions[surface]
	return at, known
}

// forget drops a surface that is gone.
func (p *compositorPointer) forget(surface uint64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.positions, surface)
}

func (p *compositorPointer) send(ctx context.Context, command string) error {
	_, err := sendCompositorControlCommand(ctx, p.socket, command+"\n")
	return err
}

// sendAt sends a command that places the pointer, and remembers where.
func (p *compositorPointer) sendAt(ctx context.Context, surface uint64, at cdpPoint, command string) error {
	if err := p.send(ctx, command); err != nil {
		return err
	}
	p.mu.Lock()
	p.positions[surface] = at
	p.mu.Unlock()
	return nil
}

func (p *compositorPointer) motion(ctx context.Context, surface uint64, at cdpPoint) error {
	return p.sendAt(ctx, surface, at, fmt.Sprintf("motion %d %.2f %.2f", surface, at.x, at.y))
}

// button presses or releases where the pointer is now; without coordinates it cannot cause a click.
func (p *compositorPointer) button(ctx context.Context, surface uint64, code uint32, pressed bool) error {
	return p.send(ctx, fmt.Sprintf("button %d %d %d", surface, code, pressedValue(pressed)))
}

func (p *compositorPointer) buttonAt(ctx context.Context, surface uint64, at cdpPoint, code uint32, pressed bool) error {
	return p.sendAt(ctx, surface, at, fmt.Sprintf("button-at %d %.2f %.2f %d %d", surface, at.x, at.y, code, pressedValue(pressed)))
}

// axis scrolls by dx, dy px where the pointer is now.
func (p *compositorPointer) axis(ctx context.Context, surface uint64, dx, dy float64) error {
	return p.send(ctx, fmt.Sprintf("axis %d %.8f %.8f", surface, compositorAxisUnits(dx), compositorAxisUnits(dy)))
}

func (p *compositorPointer) axisAt(ctx context.Context, surface uint64, at cdpPoint, dx, dy float64) error {
	return p.sendAt(ctx, surface, at, fmt.Sprintf("axis-at %d %.2f %.2f %.8f %.8f", surface, at.x, at.y, compositorAxisUnits(dx), compositorAxisUnits(dy)))
}

func (p *compositorPointer) key(ctx context.Context, surface uint64, keycode uint32, pressed bool) error {
	return p.send(ctx, fmt.Sprintf("key %d %d %d", surface, keycode, pressedValue(pressed)))
}

func (p *compositorPointer) text(ctx context.Context, surface uint64, text string) error {
	return p.send(ctx, fmt.Sprintf("text %d %s", surface, hex.EncodeToString([]byte(text))))
}

func pressedValue(pressed bool) int {
	if pressed {
		return 1
	}
	return 0
}

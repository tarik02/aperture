package browser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sync"
	"time"
)

type cdpPoint struct{ x, y float64 }

// cdpSurface is the compositor surface of one browser target; its pixels are CSS pixels times devicePixelRatio.
type cdpSurface struct {
	id            uint64
	width, height float64
}

type cdpPress struct {
	at time.Time
	cdpPoint
}

// cdpPointer drives the compositor's one real pointer for automation, shared by every proxy connection.
type cdpPointer struct {
	socket  string
	surface func(targetID string) (cdpSurface, bool)

	mu        sync.Mutex
	position  map[uint64]cdpPoint
	arrivedAt map[uint64]time.Time
	lastPress map[uint64]cdpPress
}

func newCDPPointer(socket string, surface func(targetID string) (cdpSurface, bool)) *cdpPointer {
	return &cdpPointer{
		socket:    socket,
		surface:   surface,
		position:  make(map[uint64]cdpPoint),
		arrivedAt: make(map[uint64]time.Time),
		lastPress: make(map[uint64]cdpPress),
	}
}

func (p *cdpPointer) send(ctx context.Context, format string, args ...any) error {
	_, err := sendCompositorControlCommand(ctx, p.socket, fmt.Sprintf(format, args...)+"\n")
	return err
}

func sleepContext(ctx context.Context, duration time.Duration) error {
	if duration <= 0 {
		return ctx.Err()
	}
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func easeInOut(t float64) float64 { return t * t * (3 - 2*t) }

func clamp(value, low, high float64) float64 { return math.Max(low, math.Min(high, value)) }

// glide moves the pointer to a point along an eased path of 60 Hz motion events, clamped to the surface.
func (p *cdpPointer) glide(ctx context.Context, surface cdpSurface, to cdpPoint, timing cadenceTiming) error {
	if surface.width > 0 && surface.height > 0 {
		to = cdpPoint{clamp(to.x, 0, surface.width-1), clamp(to.y, 0, surface.height-1)}
	}
	p.mu.Lock()
	from, known := p.position[surface.id]
	p.mu.Unlock()
	if !known {
		from = to
	}
	if distance := math.Hypot(to.x-from.x, to.y-from.y); distance >= 2 {
		duration := time.Duration(distance / timing.glideSpeed * float64(time.Second))
		duration = min(max(duration, timing.glideMin), timing.glideMax)
		start := time.Now()
		for {
			progress := float64(time.Since(start)) / float64(duration)
			if progress >= 1 {
				break
			}
			eased := easeInOut(progress)
			if err := p.send(ctx, "motion %d %.2f %.2f", surface.id, from.x+(to.x-from.x)*eased, from.y+(to.y-from.y)*eased); err != nil {
				return err
			}
			if err := sleepContext(ctx, glideFrameInterval); err != nil {
				return err
			}
		}
	}
	if err := p.send(ctx, "motion %d %.2f %.2f", surface.id, to.x, to.y); err != nil {
		return err
	}
	p.mu.Lock()
	p.position[surface.id] = to
	p.arrivedAt[surface.id] = time.Now()
	p.mu.Unlock()
	return nil
}

// press lets the pointer rest, then pushes the button; an unrelated repeat click at the same
// spot first waits out Chromium's double-click window.
func (p *cdpPointer) press(ctx context.Context, surface cdpSurface, code int, clickCount int, timing cadenceTiming) error {
	p.mu.Lock()
	at := p.position[surface.id]
	arrived := p.arrivedAt[surface.id]
	last := p.lastPress[surface.id]
	p.mu.Unlock()
	wait := time.Until(arrived.Add(timing.dwell))
	if clickCount <= 1 && math.Hypot(at.x-last.x, at.y-last.y) < dblclickGuardDistance {
		wait = max(wait, time.Until(last.at.Add(dblclickGuardWindow)))
	}
	if err := sleepContext(ctx, wait); err != nil {
		return err
	}
	if err := p.send(ctx, "button-at %d %.2f %.2f %d 1", surface.id, at.x, at.y, code); err != nil {
		return err
	}
	p.mu.Lock()
	p.lastPress[surface.id] = cdpPress{time.Now(), at}
	p.mu.Unlock()
	return nil
}

func (p *cdpPointer) release(ctx context.Context, surface cdpSurface, code int, timing cadenceTiming) error {
	p.mu.Lock()
	at := p.position[surface.id]
	pressedAt := p.lastPress[surface.id].at
	p.mu.Unlock()
	if err := sleepContext(ctx, time.Until(pressedAt.Add(timing.hold))); err != nil {
		return err
	}
	return p.send(ctx, "button-at %d %.2f %.2f %d 0", surface.id, at.x, at.y, code)
}

// wheel spreads a scroll delta over eased axis events. Weston scrolls wheelPxPerAxisUnit pixels per
// axis unit, so whole-pixel steps carry their rounding error to keep the total exact.
func (p *cdpPointer) wheel(ctx context.Context, surface cdpSurface, dx, dy float64) error {
	p.mu.Lock()
	at := p.position[surface.id]
	p.mu.Unlock()
	duration := min(wheelBaseDuration+time.Duration(wheelMsPerPx*math.Max(math.Abs(dx), math.Abs(dy))*float64(time.Millisecond)), wheelMaxDuration)
	steps := max(int(duration/wheelStepInterval), 1)
	var sentX, sentY float64
	for step := 1; step <= steps; step++ {
		eased := easeInOut(float64(step) / float64(steps))
		totalX, totalY := math.Round(dx*eased), math.Round(dy*eased)
		stepX, stepY := totalX-sentX, totalY-sentY
		sentX, sentY = totalX, totalY
		if stepX != 0 || stepY != 0 {
			if err := p.send(ctx, "axis-at %d %.2f %.2f %.5f %.5f", surface.id, at.x, at.y, stepX/wheelPxPerAxisUnit, stepY/wheelPxPerAxisUnit); err != nil {
				return err
			}
		}
		if err := sleepContext(ctx, wheelStepInterval); err != nil {
			return err
		}
	}
	return nil
}

type cdpHeldButton struct {
	surface uint64
	code    int
}

type cdpDPRSample struct {
	value float64
	at    time.Time
}

type cdpMouseParams struct {
	Type       string  `json:"type"`
	X          float64 `json:"x"`
	Y          float64 `json:"y"`
	Button     string  `json:"button"`
	ClickCount int     `json:"clickCount"`
	Modifiers  int     `json:"modifiers"`
	DeltaX     float64 `json:"deltaX"`
	DeltaY     float64 `json:"deltaY"`
}

// queueMouse takes a mouse command into the connection's FIFO. It reports false when the command
// should just be relayed: pass-through cadence with nothing queued ahead of it, or no compositor.
func (c *cdpProxyConn) queueMouse(raw []byte) bool {
	if c.proxy.pointer == nil || (c.proxy.cadence() == cadenceImmediate && c.mouseBusy.Load() == 0) {
		return false
	}
	c.mouseBusy.Add(1)
	select {
	case c.mouse <- func() {
		defer c.mouseBusy.Add(-1)
		c.runMouse(raw)
	}:
	case <-c.ctx.Done():
		c.mouseBusy.Add(-1)
	}
	return true
}

func (c *cdpProxyConn) runMouseQueue() {
	for {
		select {
		case task := <-c.mouse:
			task()
		case <-c.ctx.Done():
			return
		}
	}
}

// runMouse turns one queued CDP mouse command into real compositor input and answers Playwright.
// Whatever cannot be done for real falls back to the original CDP command.
func (c *cdpProxyConn) runMouse(raw []byte) {
	var message cdpMessage
	if json.Unmarshal(raw, &message) != nil || message.ID == nil {
		c.toUp(raw)
		return
	}
	cadence := c.proxy.cadence()
	if cadence == cadenceImmediate {
		c.toUp(raw)
		return
	}
	timing := cadence.timing()
	if c.proxy.timing != nil {
		timing = *c.proxy.timing
	}
	rootSession, session, ok := c.rootSession(message.SessionID)
	surface, haveSurface := c.proxy.pointer.surface(session.targetID)
	if !ok || !haveSurface {
		c.toUp(raw)
		return
	}
	ratio, err := c.devicePixelRatio(rootSession, session.targetID)
	if err != nil {
		c.toUp(raw)
		return
	}
	var params cdpMouseParams
	_ = json.Unmarshal(message.Params, &params)
	at := cdpPoint{params.X * ratio, params.Y * ratio}

	if message.Method == "Input.dispatchDragEvent" {
		// The drag itself stays CDP; moving the real pointer only shows where it happens.
		_ = c.proxy.pointer.glide(c.ctx, surface, at, timing)
		c.toUp(raw)
		return
	}
	// Playwright holds modifiers through CDP key events, which real button events would not carry.
	if params.Modifiers != 0 && params.Type != "mouseWheel" {
		if params.Type == "mouseMoved" {
			_ = c.proxy.pointer.glide(c.ctx, surface, at, timing)
		}
		c.toUp(raw)
		return
	}
	switch params.Type {
	case "mousePressed", "mouseReleased", "mouseMoved", "mouseWheel":
	default:
		c.toUp(raw)
		return
	}
	if err := c.deliverMouse(message, params, rootSession, surface, at, timing); err != nil {
		c.releaseHeld()
		c.reply(message, nil, err.Error())
		return
	}
	probe, cancel := context.WithTimeout(c.ctx, deliveryBarrier)
	// The page sees a real event shortly after the compositor accepted it; one round trip covers that.
	_ = c.evaluate(probe, rootSession, "1", nil)
	cancel()
	c.reply(message, json.RawMessage(`{}`), "")
}

func (c *cdpProxyConn) deliverMouse(message cdpMessage, params cdpMouseParams, rootSession string, surface cdpSurface, at cdpPoint, timing cadenceTiming) error {
	pointer := c.proxy.pointer
	code := 272
	switch params.Button {
	case "right":
		code = 273
	case "middle":
		code = 274
	}
	switch params.Type {
	case "mouseMoved":
		if c.interceptDrag.Load() && params.Button == "left" {
			// HTML5 drag detection needs one synthetic move so dragstart precedes the first move Playwright sees.
			select {
			case <-c.dragged:
			default:
			}
			probe, cancel := context.WithTimeout(c.ctx, pageProbeTimeout)
			_, err := c.call(probe, message.SessionID, "Input.dispatchMouseEvent", json.RawMessage(message.Params))
			cancel()
			if err != nil {
				return err
			}
			select {
			case <-c.dragged:
				// Chromium took over the drag: let go of the real button so Weston does not start a native drag.
				c.mu.Lock()
				held := c.held
				c.held = nil
				c.mu.Unlock()
				if held != nil {
					return pointer.release(c.ctx, surface, held.code, timing)
				}
				return nil
			case <-time.After(dragInterceptWindow):
			case <-c.ctx.Done():
				return c.ctx.Err()
			}
		}
		return pointer.glide(c.ctx, surface, at, timing)
	case "mousePressed":
		if err := pointer.glide(c.ctx, surface, at, timing); err != nil {
			return err
		}
		if err := pointer.press(c.ctx, surface, code, params.ClickCount, timing); err != nil {
			return err
		}
		c.mu.Lock()
		c.held = &cdpHeldButton{surface: surface.id, code: code}
		c.mu.Unlock()
		return nil
	case "mouseReleased":
		c.mu.Lock()
		held := c.held
		c.held = nil
		c.mu.Unlock()
		if held == nil {
			return nil // the drag handling already released it
		}
		return pointer.release(c.ctx, surface, code, timing)
	default: // mouseWheel
		if err := pointer.glide(c.ctx, surface, at, timing); err != nil {
			return err
		}
		return pointer.wheel(c.ctx, surface, params.DeltaX, params.DeltaY)
	}
}

// releaseHeld is the safety net for a button left down by an error or a vanished client; without
// coordinates it cannot trigger a click.
func (c *cdpProxyConn) releaseHeld() {
	c.mu.Lock()
	held := c.held
	c.held = nil
	c.mu.Unlock()
	if held == nil || c.proxy.pointer == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), pageProbeTimeout)
	defer cancel()
	_ = c.proxy.pointer.send(ctx, "button %d %d 0", held.surface, held.code)
}

// devicePixelRatio converts CSS pixels to surface pixels. It is read from the page and refreshed
// periodically because viewport emulation and zoom change it.
func (c *cdpProxyConn) devicePixelRatio(rootSession, targetID string) (float64, error) {
	c.mu.Lock()
	sample, ok := c.dpr[targetID]
	c.mu.Unlock()
	if ok && time.Since(sample.at) < dprCacheTTL {
		return sample.value, nil
	}
	ctx, cancel := context.WithTimeout(c.ctx, pageProbeTimeout)
	defer cancel()
	var value float64
	if err := c.evaluate(ctx, rootSession, "devicePixelRatio", &value); err != nil {
		return 0, err
	}
	if value <= 0 {
		return 0, errors.New("page reported no device pixel ratio")
	}
	c.mu.Lock()
	c.dpr[targetID] = cdpDPRSample{value, time.Now()}
	c.mu.Unlock()
	return value, nil
}

package browser

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"sync"
	"time"
)

type cdpPoint struct{ x, y float64 }

// cdpSurface is the compositor surface of one browser target. Surface coordinates are CSS pixels
// whatever the device scale factor (that is what the human pointer path maps to as well).
type cdpSurface struct {
	id            uint64
	targetID      string
	width, height float64
}

type cdpPress struct {
	at time.Time
	cdpPoint
}

// cdpPointerState is what the pointer last did on one surface.
type cdpPointerState struct {
	position  cdpPoint
	known     bool
	arrivedAt time.Time
	lastPress cdpPress
}

// cdpPointer drives the compositor's one real pointer for automation, shared by every proxy connection.
type cdpPointer struct {
	socket  string
	surface func(targetID string) (cdpSurface, bool)
	journal journalFunc

	mu     sync.Mutex
	states map[uint64]*cdpPointerState
}

func newCDPPointer(socket string, surface func(targetID string) (cdpSurface, bool), journal journalFunc) *cdpPointer {
	return &cdpPointer{socket: socket, surface: surface, journal: journal, states: make(map[uint64]*cdpPointerState)}
}

// state returns a copy of the surface's pointer state; the caller must not hold p.mu.
func (p *cdpPointer) state(surfaceID uint64) cdpPointerState {
	p.mu.Lock()
	defer p.mu.Unlock()
	if state := p.states[surfaceID]; state != nil {
		return *state
	}
	return cdpPointerState{}
}

func (p *cdpPointer) update(surfaceID uint64, change func(*cdpPointerState)) {
	p.mu.Lock()
	defer p.mu.Unlock()
	state := p.states[surfaceID]
	if state == nil {
		state = &cdpPointerState{}
		p.states[surfaceID] = state
	}
	change(state)
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
	state := p.state(surface.id)
	from := state.position
	if !state.known {
		from = cdpPoint{surface.width / 2, surface.height / 2}
	}
	began := time.Now()
	if distance := math.Hypot(to.x-from.x, to.y-from.y); distance >= 2 {
		defer p.journal.add("glide", began, map[string]any{"targetId": surface.targetID, "from": []float64{from.x, from.y}, "to": []float64{to.x, to.y}})
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
	p.update(surface.id, func(state *cdpPointerState) {
		state.position, state.known, state.arrivedAt = to, true, time.Now()
	})
	return nil
}

// press lets the pointer rest, then pushes the button; an unrelated repeat click at the same
// spot first waits out Chromium's double-click window.
func (p *cdpPointer) press(ctx context.Context, surface cdpSurface, code int, clickCount int, timing cadenceTiming) error {
	state := p.state(surface.id)
	at, last := state.position, state.lastPress
	wait := time.Until(state.arrivedAt.Add(timing.dwell))
	if clickCount <= 1 && math.Hypot(at.x-last.x, at.y-last.y) < dblclickGuardDistance {
		wait = max(wait, time.Until(last.at.Add(dblclickGuardWindow)))
	}
	if err := sleepContext(ctx, wait); err != nil {
		return err
	}
	if err := p.send(ctx, "button-at %d %.2f %.2f %d 1", surface.id, at.x, at.y, code); err != nil {
		return err
	}
	p.update(surface.id, func(state *cdpPointerState) { state.lastPress = cdpPress{time.Now(), at} })
	return nil
}

func (p *cdpPointer) release(ctx context.Context, surface cdpSurface, code int, timing cadenceTiming) error {
	state := p.state(surface.id)
	at := state.position
	if err := sleepContext(ctx, time.Until(state.lastPress.at.Add(timing.hold))); err != nil {
		return err
	}
	return p.send(ctx, "button-at %d %.2f %.2f %d 0", surface.id, at.x, at.y, code)
}

// wheel spreads a scroll delta over eased axis events. Weston scrolls wheelPxPerAxisUnit pixels per
// axis unit, so whole-pixel steps carry their rounding error to keep the total exact.
func (p *cdpPointer) wheel(ctx context.Context, surface cdpSurface, dx, dy float64) error {
	at := p.state(surface.id).position
	defer p.journal.add("wheel", time.Now(), map[string]any{"targetId": surface.targetID, "x": at.x, "y": at.y, "dx": dx, "dy": dy})
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
		if step < steps {
			if err := sleepContext(ctx, wheelStepInterval); err != nil {
				return err
			}
		}
	}
	return nil
}

// circle moves the pointer around a point: it glides to the circle's start, then goes round at an even pace.
func (p *cdpPointer) circle(ctx context.Context, surface cdpSurface, center cdpPoint, radius float64, loops int, duration time.Duration, timing cadenceTiming) error {
	at := func(angle float64) cdpPoint {
		return cdpPoint{clamp(center.x+radius*math.Cos(angle), 0, surface.width-1), clamp(center.y+radius*math.Sin(angle), 0, surface.height-1)}
	}
	if err := p.glide(ctx, surface, at(0), timing); err != nil {
		return err
	}
	for start := time.Now(); time.Since(start) < duration; {
		point := at(2 * math.Pi * float64(loops) * float64(time.Since(start)) / float64(duration))
		if err := p.send(ctx, "motion %d %.2f %.2f", surface.id, point.x, point.y); err != nil {
			return err
		}
		if err := sleepContext(ctx, glideFrameInterval); err != nil {
			return err
		}
	}
	return p.glide(ctx, surface, at(0), timing)
}

type cdpHeldButton struct {
	surface uint64
	code    int
}

// mouseButtonCodes are the Linux button codes of the buttons that can be pressed for real; others stay on CDP.
var mouseButtonCodes = map[string]int{"left": 272, "right": 273, "middle": 274}

type cdpInputParams struct {
	Type       string  `json:"type"`
	X          float64 `json:"x"`
	Y          float64 `json:"y"`
	Button     string  `json:"button"`
	ClickCount int     `json:"clickCount"`
	Modifiers  int     `json:"modifiers"`
	DeltaX     float64 `json:"deltaX"`
	DeltaY     float64 `json:"deltaY"`
	Enabled    bool    `json:"enabled"` // Input.setInterceptDrags
}

// queueMouse takes an input command into the connection's FIFO. It reports false when the command
// should just be relayed: pass-through cadence with nothing queued ahead of it, or no compositor.
// Input.setInterceptDrags always queues so the flag changes in order with the mouse commands.
func (c *cdpProxyConn) queueMouse(raw []byte, method string) bool {
	if c.proxy.pointer == nil || (method != "Input.setInterceptDrags" && c.proxy.cadence() == cadenceImmediate && c.mouseBusy.Load() == 0) {
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

// relayMouse sends an input command over CDP after letting go of a real button, which the
// command's CDP twin would otherwise leave stuck down.
func (c *cdpProxyConn) relayMouse(raw []byte) {
	c.releaseHeld()
	c.toUp(raw)
}

// runMouse turns one queued CDP input command into real compositor input and answers Playwright.
// Whatever cannot be done for real falls back to the original CDP command.
func (c *cdpProxyConn) runMouse(raw []byte) {
	var params cdpInputParams
	message, ok := decodeCDP(raw, &params)
	if !ok || message.ID == nil {
		c.relayMouse(raw)
		return
	}
	if message.Method == "Input.setInterceptDrags" {
		c.interceptDrag.Store(params.Enabled)
		c.toUp(raw)
		return
	}
	cadence := c.proxy.cadence()
	rootSession, session, known := c.rootSession(message.SessionID)
	surface, haveSurface := c.proxy.pointer.surface(session.targetID)
	if cadence == cadenceImmediate || !known || !haveSurface {
		c.relayMouse(raw)
		return
	}
	timing := cadence.timing()
	at := cdpPoint{params.X, params.Y}
	if message.Method == "Input.dispatchDragEvent" {
		// The drag itself stays CDP; moving the real pointer only shows where it happens.
		_ = c.proxy.pointer.glide(c.ctx, surface, at, timing)
		c.relayMouse(raw)
		return
	}
	code, knownButton := mouseButtonCodes[params.Button]
	switch params.Type {
	case "mousePressed", "mouseReleased":
		if !knownButton {
			c.relayMouse(raw)
			return
		}
	case "mouseMoved", "mouseWheel":
	default:
		c.relayMouse(raw)
		return
	}
	// Playwright holds modifiers through CDP key events, which real button events would not carry.
	if params.Modifiers != 0 {
		c.releaseHeld()
		if params.Type == "mouseMoved" {
			_ = c.proxy.pointer.glide(c.ctx, surface, at, timing)
		}
		c.toUp(raw)
		return
	}
	if err := c.deliverMouse(message, params, surface, at, code, timing); err != nil {
		c.releaseHeld()
		c.reply(message, nil, err.Error())
		return
	}
	probe, cancel := context.WithTimeout(c.ctx, deliveryBarrier)
	// The page sees a real event shortly after the compositor accepted it; one round trip covers that.
	_ = c.evaluate(probe, rootSession, "1", nil)
	cancel()
	pressed := time.Now()
	c.reply(message, json.RawMessage(`{}`), "")
	if params.Type == "mousePressed" {
		go c.journalPress(rootSession, surface, params, pressed)
	}
}

// journalPress records a press with a short description of what is under the pointer. It runs after
// the reply, so the click path pays nothing for it.
func (c *cdpProxyConn) journalPress(sessionID string, surface cdpSurface, params cdpInputParams, pressed time.Time) {
	var element string
	ctx, cancel := context.WithTimeout(c.ctx, pageProbeTimeout)
	defer cancel()
	_ = c.evaluate(ctx, sessionID, fmt.Sprintf(describeElementExpression, params.X, params.Y), &element)
	c.proxy.journal.add("press", pressed, map[string]any{"targetId": surface.targetID, "x": params.X, "y": params.Y, "button": params.Button, "count": params.ClickCount, "element": element})
}

// describeElementExpression names the element at a point as tag#id "text", at most 60 characters of text.
const describeElementExpression = `(()=>{const e=document.elementFromPoint(%v,%v);if(!e)return "";
const t=(e.getAttribute("aria-label")||e.innerText||e.value||"").trim().replace(/\s+/g," ").slice(0,60);
return e.tagName.toLowerCase()+(e.id?"#"+e.id:"")+(t?' "'+t+'"':"")})()`

func (c *cdpProxyConn) deliverMouse(message cdpMessage, params cdpInputParams, surface cdpSurface, at cdpPoint, code int, timing cadenceTiming) error {
	pointer := c.proxy.pointer
	switch params.Type {
	case "mouseMoved":
		if c.interceptDrag.Load() && params.Button == "left" {
			// HTML5 drag detection needs one synthetic move so dragstart precedes the first move Playwright sees.
			select {
			case <-c.dragged:
			default:
			}
			if _, err := c.call(c.ctx, message.SessionID, "Input.dispatchMouseEvent", json.RawMessage(message.Params)); err != nil {
				return err
			}
			select {
			case <-c.dragged:
				// Chromium took over the drag: let go of the real button so Weston does not start a native drag.
				return c.releaseReal(surface, timing)
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
		return c.releaseReal(surface, timing)
	default: // mouseWheel
		if err := pointer.glide(c.ctx, surface, at, timing); err != nil {
			return err
		}
		return pointer.wheel(c.ctx, surface, params.DeltaX, params.DeltaY)
	}
}

// releaseReal lets go of the held real button; it stays held when that fails so releaseHeld can retry.
func (c *cdpProxyConn) releaseReal(surface cdpSurface, timing cadenceTiming) error {
	c.mu.Lock()
	held := c.held
	c.mu.Unlock()
	if held == nil {
		return nil // the drag handling already released it
	}
	if err := c.proxy.pointer.release(c.ctx, surface, held.code, timing); err != nil {
		return err
	}
	c.mu.Lock()
	c.held = nil
	c.mu.Unlock()
	return nil
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

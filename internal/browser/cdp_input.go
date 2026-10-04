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

// cdpSurface is the compositor surface of one browser target. Surface coordinates are CSS pixels
// whatever the device scale factor (that is what the human pointer path maps to as well).
type cdpSurface struct {
	id            uint64
	targetID      string
	width, height float64
}

type cdpPress struct {
	at   time.Time
	code uint32
	cdpPoint
}

// cdpPointerState is what automation last did on one surface; where the pointer is lives in the
// compositor pointer, which the human path moves too.
type cdpPointerState struct {
	arrivedAt time.Time
	lastPress cdpPress
	held      map[uint32]struct{} // buttons held down for real
}

// cdpPointer drives the compositor's one real pointer for automation, shared by every proxy connection.
type cdpPointer struct {
	compositor *compositorPointer
	lookup     func(targetID string) (cdpSurface, bool)
	journal    journalFunc

	mu       sync.Mutex
	states   map[uint64]*cdpPointerState
	surfaces map[string]uint64 // the surface each target was last seen on, to drop its state with it
}

func newCDPPointer(compositor *compositorPointer, lookup func(targetID string) (cdpSurface, bool), journal journalFunc) *cdpPointer {
	return &cdpPointer{compositor: compositor, lookup: lookup, journal: journal, states: make(map[uint64]*cdpPointerState), surfaces: make(map[string]uint64)}
}

// surface finds the compositor surface of a target; a target that has none any more takes its
// pointer state with it.
func (p *cdpPointer) surface(targetID string) (cdpSurface, bool) {
	surface, ok := p.lookup(targetID)
	if !ok {
		p.forget(targetID)
		return cdpSurface{}, false
	}
	p.mu.Lock()
	p.surfaces[targetID] = surface.id
	p.mu.Unlock()
	return surface, true
}

func (p *cdpPointer) forget(targetID string) {
	p.mu.Lock()
	surfaceID, known := p.surfaces[targetID]
	delete(p.surfaces, targetID)
	delete(p.states, surfaceID)
	p.mu.Unlock()
	if known {
		p.compositor.forget(surfaceID)
	}
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
		state = &cdpPointerState{held: make(map[uint32]struct{})}
		p.states[surfaceID] = state
	}
	change(state)
}

// position is where the pointer is on a surface, the center until it has been anywhere.
func (p *cdpPointer) position(surface cdpSurface) cdpPoint {
	if at, known := p.compositor.position(surface.id); known {
		return at
	}
	return cdpPoint{surface.width / 2, surface.height / 2}
}

func sleepContext(ctx context.Context, duration time.Duration) error {
	_, err := sleepUnless(ctx, duration, nil)
	return err
}

// sleepUnless sleeps for the duration unless stop signals first, which it reports.
func sleepUnless(ctx context.Context, duration time.Duration, stop <-chan struct{}) (bool, error) {
	if duration <= 0 {
		return false, ctx.Err()
	}
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-timer.C:
		return false, nil
	case <-stop:
		return true, nil
	case <-ctx.Done():
		return false, ctx.Err()
	}
}

func easeInOut(t float64) float64 { return t * t * (3 - 2*t) }

func clamp(value, low, high float64) float64 { return math.Max(low, math.Min(high, value)) }

// glide moves the pointer to a point along an eased path of 60 Hz motion events, clamped to the surface.
func (p *cdpPointer) glide(ctx context.Context, surface cdpSurface, to cdpPoint, timing cadenceTiming) error {
	_, err := p.glideUnless(ctx, surface, to, timing, nil)
	return err
}

// glideUnless is a glide that stops where it is, and reports so, when stop signals between frames.
func (p *cdpPointer) glideUnless(ctx context.Context, surface cdpSurface, to cdpPoint, timing cadenceTiming, stop <-chan struct{}) (bool, error) {
	if surface.width > 0 && surface.height > 0 {
		to = cdpPoint{clamp(to.x, 0, surface.width-1), clamp(to.y, 0, surface.height-1)}
	}
	from := p.position(surface)
	began := time.Now()
	p.journal.add("target", began, map[string]any{"targetId": surface.targetID})
	distance := math.Hypot(to.x-from.x, to.y-from.y)
	if distance >= 2 {
		duration := time.Duration(distance / timing.glideSpeed * float64(time.Second))
		duration = min(max(duration, timing.glideMin), timing.glideMax)
		start := time.Now()
		for {
			progress := float64(time.Since(start)) / float64(duration)
			if progress >= 1 {
				break
			}
			eased := easeInOut(progress)
			if err := p.compositor.motion(ctx, surface.id, cdpPoint{from.x + (to.x-from.x)*eased, from.y + (to.y-from.y)*eased}); err != nil {
				return false, err
			}
			if stopped, err := sleepUnless(ctx, glideFrameInterval, stop); stopped || err != nil {
				return stopped, err
			}
		}
	}
	if err := p.compositor.motion(ctx, surface.id, to); err != nil {
		return false, err
	}
	p.update(surface.id, func(state *cdpPointerState) { state.arrivedAt = time.Now() })
	if distance >= 2 {
		p.journal.add("glide", began, map[string]any{"targetId": surface.targetID, "from": []float64{from.x, from.y}, "to": []float64{to.x, to.y}})
	}
	return false, nil
}

// press lets the pointer rest, then pushes the button; an unrelated repeat click of the same button
// at the same spot first waits out Chromium's double-click window.
func (p *cdpPointer) press(ctx context.Context, surface cdpSurface, code uint32, clickCount int, timing cadenceTiming) error {
	state := p.state(surface.id)
	at, last := p.position(surface), state.lastPress
	wait := time.Until(state.arrivedAt.Add(timing.dwell))
	if clickCount <= 1 && last.code == code && math.Hypot(at.x-last.x, at.y-last.y) < dblclickGuardDistance {
		wait = max(wait, time.Until(last.at.Add(dblclickGuardWindow)))
	}
	if err := sleepContext(ctx, wait); err != nil {
		return err
	}
	if err := p.compositor.buttonAt(ctx, surface.id, at, code, true); err != nil {
		return err
	}
	p.update(surface.id, func(state *cdpPointerState) {
		state.lastPress = cdpPress{time.Now(), code, at}
		state.held[code] = struct{}{}
	})
	return nil
}

// release lets go of a button where the pointer is after it was held for the cadence's hold time.
func (p *cdpPointer) release(ctx context.Context, surfaceID uint64, code uint32, timing cadenceTiming) error {
	state := p.state(surfaceID)
	if err := sleepContext(ctx, time.Until(state.lastPress.at.Add(timing.hold))); err != nil {
		return err
	}
	var err error
	if at, known := p.compositor.position(surfaceID); known {
		err = p.compositor.buttonAt(ctx, surfaceID, at, code, false)
	} else {
		err = p.compositor.button(ctx, surfaceID, code, false)
	}
	if err != nil {
		return err
	}
	p.update(surfaceID, func(state *cdpPointerState) { delete(state.held, code) })
	return nil
}

// drop lets go of a button without coordinates, so it cannot cause a click: the safety net for a
// button left down by an error or a vanished client.
func (p *cdpPointer) drop(ctx context.Context, surfaceID uint64, code uint32) error {
	if err := p.compositor.button(ctx, surfaceID, code, false); err != nil {
		return err
	}
	p.update(surfaceID, func(state *cdpPointerState) { delete(state.held, code) })
	return nil
}

// wheel spreads a scroll delta over eased axis events in whole pixels, each step carrying the
// rounding error of the one before so the total is exact.
func (p *cdpPointer) wheel(ctx context.Context, surface cdpSurface, dx, dy float64) error {
	at := p.position(surface)
	began := time.Now()
	p.journal.add("target", began, map[string]any{"targetId": surface.targetID})
	duration := min(wheelBaseDuration+time.Duration(wheelMsPerPx*math.Max(math.Abs(dx), math.Abs(dy))*float64(time.Millisecond)), wheelMaxDuration)
	steps := max(int(duration/wheelStepInterval), 1)
	var sentX, sentY float64
	for step := 1; step <= steps; step++ {
		eased := easeInOut(float64(step) / float64(steps))
		totalX, totalY := math.Round(dx*eased), math.Round(dy*eased)
		stepX, stepY := totalX-sentX, totalY-sentY
		sentX, sentY = totalX, totalY
		if stepX != 0 || stepY != 0 {
			if err := p.compositor.axisAt(ctx, surface.id, at, stepX, stepY); err != nil {
				return err
			}
		}
		if step < steps {
			if err := sleepContext(ctx, wheelStepInterval); err != nil {
				return err
			}
		}
	}
	p.journal.add("wheel", began, map[string]any{"targetId": surface.targetID, "x": at.x, "y": at.y, "dx": dx, "dy": dy})
	return nil
}

// circle moves the pointer around a point: it glides to the circle's start, then goes round at an
// even pace and glides back to the start. It refuses while a button is held, which it would drag.
func (p *cdpPointer) circle(ctx context.Context, surface cdpSurface, center cdpPoint, radius float64, loops int, duration time.Duration, timing cadenceTiming) error {
	at := func(angle float64) cdpPoint {
		return cdpPoint{clamp(center.x+radius*math.Cos(angle), 0, surface.width-1), clamp(center.y+radius*math.Sin(angle), 0, surface.height-1)}
	}
	if len(p.state(surface.id).held) > 0 {
		return errors.New("a mouse button is held down")
	}
	if err := p.glide(ctx, surface, at(0), timing); err != nil {
		return err
	}
	for start := time.Now(); time.Since(start) < duration; {
		point := at(2 * math.Pi * float64(loops) * float64(time.Since(start)) / float64(duration))
		if err := p.compositor.motion(ctx, surface.id, point); err != nil {
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
	code    uint32
}

// mouseButtonCodes are the Linux button codes of the buttons that can be pressed for real; others stay on CDP.
var mouseButtonCodes = map[string]uint32{"left": 272, "right": 273, "middle": 274}

type cdpInputParams struct {
	Type       string  `json:"type"`
	X          float64 `json:"x"`
	Y          float64 `json:"y"`
	Button     string  `json:"button"`
	Buttons    int     `json:"buttons"` // the buttons down during a move, as a bitmask
	ClickCount int     `json:"clickCount"`
	Modifiers  int     `json:"modifiers"`
	DeltaX     float64 `json:"deltaX"`
	DeltaY     float64 `json:"deltaY"`
	Enabled    bool    `json:"enabled"` // Input.setInterceptDrags
}

// queueMouse takes an input command into the connection's FIFO. It reports false when the command
// should just be relayed: pass-through cadence with nothing queued ahead of it and no real button
// down, or no compositor. Input.setInterceptDrags always queues so the flag changes in order with
// the mouse commands.
func (c *cdpProxyConn) queueMouse(raw []byte, method string) bool {
	if c.proxy.pointer == nil {
		return false
	}
	if method != "Input.setInterceptDrags" && c.proxy.cadence() == cadenceImmediate && c.mouseBusy.Load() == 0 && !c.holding() {
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

// relayMouse sends an input command over CDP after letting go of every real button, which the
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
		c.mu.Lock()
		c.interceptDrags[message.SessionID] = params.Enabled
		c.mu.Unlock()
		c.toUp(raw)
		return
	}
	cadence := c.proxy.cadence()
	timing := c.proxy.timing(cadence)
	rootSession, session, known := c.rootSession(message.SessionID)
	code, knownButton := mouseButtonCodes[params.Button]
	if held, ok := c.heldButton(code); ok && knownButton && message.Method == "Input.dispatchMouseEvent" && params.Type == "mouseReleased" {
		// A real press ends with a real release, whatever the cadence has become since.
		if err := c.releaseReal(held, timing); err != nil {
			c.releaseHeld()
			c.reply(message, nil, err.Error())
			return
		}
		c.settle(message, params, rootSession, "")
		return
	}
	surface, haveSurface := c.proxy.pointer.surface(session.targetID)
	if cadence == cadenceImmediate || !known || !haveSurface {
		c.relayMouse(raw)
		return
	}
	at := cdpPoint{params.X, params.Y}
	if message.Method == "Input.dispatchDragEvent" {
		// The drag itself stays CDP; moving the real pointer only shows where it happens.
		_ = c.proxy.pointer.glide(c.ctx, surface, at, timing)
		c.relayMouse(raw)
		return
	}
	switch params.Type {
	case "mousePressed":
		if !knownButton {
			c.relayMouse(raw)
			return
		}
	case "mouseReleased":
		// Nothing real is held for this button: its press went over CDP, so its release follows it.
		c.relayMouse(raw)
		return
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
		if errors.Is(err, errRelayMouse) {
			c.relayMouse(raw)
			return
		}
		c.releaseHeld()
		c.reply(message, nil, err.Error())
		return
	}
	c.settle(message, params, rootSession, surface.targetID)
}

// errRelayMouse is deliverMouse's answer for a command that belongs on CDP after all.
var errRelayMouse = errors.New("relay the mouse command")

// settle answers Playwright once the page has had the chance to see the real event: one round trip
// covers that, and a recording's journal gets the pressed element's description from the same one.
func (c *cdpProxyConn) settle(message cdpMessage, params cdpInputParams, rootSession, targetID string) {
	expression, journaled := `""`, params.Type == "mousePressed" && c.proxy.recording()
	if journaled {
		expression = fmt.Sprintf(describeElementExpression, params.X, params.Y)
	}
	var element string
	probe, cancel := context.WithTimeout(c.ctx, deliveryBarrier)
	_ = c.evaluate(probe, rootSession, expression, &element)
	cancel()
	pressed := time.Now()
	c.reply(message, json.RawMessage(`{}`), "")
	if journaled {
		c.proxy.journal.add("press", pressed, map[string]any{"targetId": targetID, "x": params.X, "y": params.Y, "button": params.Button, "count": params.ClickCount, "element": element})
	}
}

// describeElementExpression names the element at a point as tag#id "text", at most 60 characters of text.
const describeElementExpression = `(()=>{const e=document.elementFromPoint(%v,%v);if(!e)return "";
const t=(e.getAttribute("aria-label")||e.innerText||e.value||"").trim().replace(/\s+/g," ").slice(0,60);
return e.tagName.toLowerCase()+(e.id?"#"+e.id:"")+(t?' "'+t+'"':"")})()`

func (c *cdpProxyConn) deliverMouse(message cdpMessage, params cdpInputParams, surface cdpSurface, at cdpPoint, code uint32, timing cadenceTiming) error {
	pointer := c.proxy.pointer
	switch params.Type {
	case "mouseMoved":
		held, holding := c.anyHeld()
		if params.Buttons != 0 && !holding {
			// The press went over CDP, so the drag this move continues stays there.
			return errRelayMouse
		}
		if !holding || held.code != mouseButtonCodes["left"] || !c.interceptingDrags(message.SessionID) {
			return pointer.glide(c.ctx, surface, at, timing)
		}
		// Playwright watches for an HTML5 drag: once Chromium reports it took one over, the real
		// button goes up without coordinates (so no click lands) and Playwright drives the drag over CDP.
		select {
		case <-c.dragged:
		default:
		}
		intercepted, err := pointer.glideUnless(c.ctx, surface, at, timing, c.dragged)
		if err != nil {
			return err
		}
		if !intercepted {
			// A drag that the last frame started is reported a moment later.
			select {
			case <-c.dragged:
				intercepted = true
			case <-time.After(dragInterceptWindow):
			case <-c.ctx.Done():
				return c.ctx.Err()
			}
		}
		if intercepted {
			return c.dropHeld(held)
		}
		return nil
	case "mousePressed":
		if err := pointer.glide(c.ctx, surface, at, timing); err != nil {
			return err
		}
		if err := pointer.press(c.ctx, surface, code, params.ClickCount, timing); err != nil {
			return err
		}
		c.mu.Lock()
		c.held[cdpHeldButton{surface: surface.id, code: code}] = struct{}{}
		c.mu.Unlock()
		return nil
	default: // mouseWheel
		if err := pointer.glide(c.ctx, surface, at, timing); err != nil {
			return err
		}
		return pointer.wheel(c.ctx, surface, params.DeltaX, params.DeltaY)
	}
}

func (c *cdpProxyConn) interceptingDrags(sessionID string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.interceptDrags[sessionID]
}

func (c *cdpProxyConn) holding() bool {
	_, holding := c.anyHeld()
	return holding
}

// anyHeld is one of the real buttons this connection has not released yet.
func (c *cdpProxyConn) anyHeld() (cdpHeldButton, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for held := range c.held {
		return held, true
	}
	return cdpHeldButton{}, false
}

// heldButton finds the real press of a button that this connection has not released yet.
func (c *cdpProxyConn) heldButton(code uint32) (cdpHeldButton, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for held := range c.held {
		if held.code == code {
			return held, true
		}
	}
	return cdpHeldButton{}, false
}

// releaseReal lets go of a held real button; it stays held when that fails so releaseHeld can retry.
func (c *cdpProxyConn) releaseReal(held cdpHeldButton, timing cadenceTiming) error {
	if err := c.proxy.pointer.release(c.ctx, held.surface, held.code, timing); err != nil {
		return err
	}
	c.mu.Lock()
	delete(c.held, held)
	c.mu.Unlock()
	return nil
}

// dropHeld lets go of a held real button without coordinates, which cannot cause a click.
func (c *cdpProxyConn) dropHeld(held cdpHeldButton) error {
	if err := c.proxy.pointer.drop(c.ctx, held.surface, held.code); err != nil {
		return err
	}
	c.mu.Lock()
	delete(c.held, held)
	c.mu.Unlock()
	return nil
}

// releaseHeld is the safety net for buttons left down by an error or a vanished client.
func (c *cdpProxyConn) releaseHeld() {
	c.mu.Lock()
	held := c.held
	c.held = make(map[cdpHeldButton]struct{})
	c.mu.Unlock()
	if len(held) == 0 || c.proxy.pointer == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), pageProbeTimeout)
	defer cancel()
	for button := range held {
		_ = c.proxy.pointer.drop(ctx, button.surface, button.code)
	}
}

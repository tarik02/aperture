package browser

import (
	"context"
	"fmt"
	"math"
	"time"

	"github.com/aperture/aperture/internal/pointer"
)

// Linux evdev codes, as the compositor's button and key commands take them.
const (
	evdevButtonLeft   = 0x110
	evdevButtonRight  = 0x111
	evdevButtonMiddle = 0x112
	evdevKeyLeftCtrl  = 29
	evdevKeyLeftShift = 42
	evdevKeyLeftAlt   = 56
	evdevKeyLeftMeta  = 125
)

const (
	pointerDefaultFrameRate = 60
	pointerMinFrameRate     = 15
	pointerMaxFrameRate     = 120
	// Time the button stays down in a click, and the pause between the clicks of
	// a multi-click. Together they keep up to three clicks well inside
	// Chromium's double-click interval.
	pointerClickDownTime = 45 * time.Millisecond
	pointerClickGapTime  = 60 * time.Millisecond
	// The pointer rests this long on a destination before pressing, so pages see
	// the hover first, and after a drag's last move so drop targets react.
	pointerDwellTime        = 60 * time.Millisecond
	pointerInstantDwellTime = 20 * time.Millisecond
	// A drag needs motion after the press for HTML5 drag and drop to start.
	pointerDragNudge       = 6.0
	pointerMaxPathPoints   = 4096
	pointerReleaseTimeout  = 2 * time.Second
	pointerMotionThreshold = 0.05
)

// compositorPointer produces one gesture as real pointer and key events on a
// compositor surface. It sends motion at the frame rate from the pointer's last
// position, so the rendered cursor glides the way a person's would.
type compositorPointer struct {
	socket    string
	surfaceID uint64
	width     float64
	height    float64
	frame     time.Duration
	motion    pointer.Motion
	state     *pointerRuntime

	started time.Time
	last    pointer.Point
	path    []pointerPathPoint
	clicks  []pointerClickPoint
}

func newCompositorPointer(runtime *wrapperRuntime, target wrapperTargetSnapshot, motion pointer.Motion) *compositorPointer {
	return &compositorPointer{
		socket:    runtime.controlSocket,
		surfaceID: target.SurfaceID,
		width:     float64(target.Viewport.Width),
		height:    float64(target.Viewport.Height),
		frame:     time.Second / time.Duration(runtime.pointerFrameRate()),
		motion:    motion,
		state:     &runtime.pointer,
	}
}

// pointerFrameRate is the frame rate of the live media, so cursor motion lands
// on every rendered frame.
func (r *wrapperRuntime) pointerFrameRate() int {
	rate := r.values.MediaProducerFPS
	if mediaProducer := r.currentMediaProducer(); mediaProducer != nil {
		if fps := mediaProducer.media.Quality().Framerate; fps > 0 {
			rate = fps
		}
	}
	if rate <= 0 {
		rate = pointerDefaultFrameRate
	}
	return min(max(rate, pointerMinFrameRate), pointerMaxFrameRate)
}

func (c *compositorPointer) begin() {
	c.started = time.Now()
}

func (c *compositorPointer) command(ctx context.Context, format string, args ...any) error {
	_, err := sendCompositorControlCommand(ctx, c.socket, fmt.Sprintf(format, args...))
	return err
}

// place puts the pointer at a point, without any glide.
func (c *compositorPointer) place(ctx context.Context, point pointer.Point) error {
	if err := c.command(ctx, "motion %d %.3f %.3f\n", c.surfaceID, point.X, point.Y); err != nil {
		return err
	}
	c.moved(point)
	return nil
}

func (c *compositorPointer) moved(point pointer.Point) {
	c.last = point
	c.state.setPosition(c.surfaceID, point)
	if len(c.path) < pointerMaxPathPoints {
		c.path = append(c.path, pointerPathPoint{Offset: time.Since(c.started), X: point.X, Y: point.Y})
	}
}

// bounds is the rectangle of surface coordinates the pointer travels in.
//
// The compositor's motion command accepts 0 <= x <= width and 0 <= y <= height
// (it rejects only values beyond the surface). Coordinates are logical pixels
// and the last pixel column is width-1, so the far edge is width-1: a pointer
// parked at width would be on the neighboring surface's first pixel, not on
// this one's. Glides therefore stay within [0, width-1] x [0, height-1].
func (c *compositorPointer) bounds() pointer.Bounds {
	return pointerSurfaceBounds(c.width, c.height)
}

func pointerSurfaceBounds(width, height float64) pointer.Bounds {
	return pointer.Bounds{MaxX: max(width-1, 0), MaxY: max(height-1, 0)}
}

// start returns where a glide begins: the pointer's last position on this
// surface, or the surface center when it has none (first gesture, or the
// pointer was last on another target), in which case the pointer first jumps
// there. A remembered position outside the current surface (the window was
// resized since) is moved to the nearest point inside it, and the pointer
// jumps there first.
func (c *compositorPointer) start(ctx context.Context) (pointer.Point, error) {
	if point, ok := c.state.position(c.surfaceID); ok {
		clamped := c.bounds().Clamp(point)
		if clamped != point {
			if err := c.place(ctx, clamped); err != nil {
				return clamped, err
			}
		}
		return clamped, nil
	}
	center := pointer.Point{X: c.width / 2, Y: c.height / 2}
	if err := c.place(ctx, center); err != nil {
		return center, err
	}
	return center, nil
}

// glide moves the pointer to a destination along the motion's path.
func (c *compositorPointer) glide(ctx context.Context, destination pointer.Point) error {
	from, err := c.start(ctx)
	if err != nil {
		return err
	}
	duration := c.motion.TravelDuration(from.Distance(destination))
	if duration <= 0 {
		return c.place(ctx, destination)
	}
	path := pointer.NewBoundedPath(from, destination, c.motion, c.bounds())
	last := from
	ticker := time.NewTicker(c.frame)
	defer ticker.Stop()
	began := time.Now()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case now := <-ticker.C:
			elapsed := now.Sub(began)
			if elapsed >= duration {
				return c.place(ctx, destination)
			}
			point := path.At(float64(elapsed) / float64(duration))
			if point.Distance(last) < pointerMotionThreshold {
				continue
			}
			if err := c.place(ctx, point); err != nil {
				return err
			}
			last = point
		}
	}
}

func (c *compositorPointer) dwell(ctx context.Context) error {
	if c.motion.Kind == pointer.KindInstant {
		return sleepContext(ctx, pointerInstantDwellTime)
	}
	return sleepContext(ctx, pointerDwellTime)
}

func (c *compositorPointer) button(ctx context.Context, at pointer.Point, code uint32, pressed bool) error {
	value := 0
	if pressed {
		value = 1
	}
	if err := c.command(ctx, "button-at %d %.3f %.3f %d %d\n", c.surfaceID, at.X, at.Y, code, value); err != nil {
		return err
	}
	c.state.setPosition(c.surfaceID, at)
	return nil
}

// release lets go of a button without moving the pointer, so it cannot be
// rejected for its coordinates the way "button-at" can. It retries once, since a
// button left down would stay stuck for the page.
func (c *compositorPointer) release(ctx context.Context, code uint32) error {
	err := c.command(ctx, "button %d %d 0\n", c.surfaceID, code)
	if err != nil && ctx.Err() == nil {
		err = c.command(ctx, "button %d %d 0\n", c.surfaceID, code)
	}
	return err
}

// releaseQuietly lets go of a button even when the gesture's context is done,
// so a cancelled gesture never leaves one held.
func (c *compositorPointer) releaseQuietly(ctx context.Context, code uint32) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), pointerReleaseTimeout)
	defer cancel()
	_ = c.release(ctx, code)
}

func (c *compositorPointer) key(ctx context.Context, code uint32, pressed bool) error {
	value := 0
	if pressed {
		value = 1
	}
	err := c.command(ctx, "key %d %d %d\n", c.surfaceID, code, value)
	if err != nil && !pressed && ctx.Err() == nil {
		// A modifier left down would stay held for the page; try once more.
		err = c.command(ctx, "key %d %d %d\n", c.surfaceID, code, value)
	}
	return err
}

// withModifiers holds the modifier keys around an action and always releases
// them, in reverse order.
func (c *compositorPointer) withModifiers(ctx context.Context, modifiers []string, action func() error) error {
	held := make([]uint32, 0, len(modifiers))
	defer func() {
		releaseCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), pointerReleaseTimeout)
		defer cancel()
		for index := len(held) - 1; index >= 0; index-- {
			_ = c.key(releaseCtx, held[index], false)
		}
	}()
	for _, code := range pointerModifierKeyCodes(modifiers) {
		if err := c.key(ctx, code, true); err != nil {
			return err
		}
		held = append(held, code)
	}
	return action()
}

func pointerModifierKeyCodes(modifiers []string) []uint32 {
	codes := make([]uint32, 0, len(modifiers))
	seen := make(map[uint32]struct{}, len(modifiers))
	for _, modifier := range modifiers {
		var code uint32
		switch modifier {
		case "Alt":
			code = evdevKeyLeftAlt
		case "Control", "ControlOrMeta":
			// Aperture's browsers run on Linux, where ControlOrMeta is Control.
			code = evdevKeyLeftCtrl
		case "Meta":
			code = evdevKeyLeftMeta
		case "Shift":
			code = evdevKeyLeftShift
		default:
			continue
		}
		if _, duplicate := seen[code]; duplicate {
			continue
		}
		seen[code] = struct{}{}
		codes = append(codes, code)
	}
	return codes
}

func pointerButtonCode(button string) uint32 {
	switch button {
	case "right":
		return evdevButtonRight
	case "middle":
		return evdevButtonMiddle
	default:
		return evdevButtonLeft
	}
}

// click glides to the point and presses the button count times.
func (c *compositorPointer) click(ctx context.Context, at pointer.Point, button string, count int, modifiers []string) error {
	if err := c.glide(ctx, at); err != nil {
		return err
	}
	if err := c.dwell(ctx); err != nil {
		return err
	}
	code := pointerButtonCode(button)
	return c.withModifiers(ctx, modifiers, func() error {
		for index := 1; index <= count; index++ {
			if err := c.tap(ctx, at, code, button, index); err != nil {
				return err
			}
			if index < count {
				if err := sleepContext(ctx, pointerClickGapTime); err != nil {
					return err
				}
			}
		}
		return nil
	})
}

func (c *compositorPointer) tap(ctx context.Context, at pointer.Point, code uint32, button string, index int) error {
	pressed := false
	defer func() {
		if pressed {
			c.releaseQuietly(ctx, code)
		}
	}()
	if err := c.button(ctx, at, code, true); err != nil {
		return err
	}
	pressed = true
	c.clicks = append(c.clicks, pointerClickPoint{At: time.Now(), X: at.X, Y: at.Y, Button: button, Count: index})
	if err := sleepContext(ctx, pointerClickDownTime); err != nil {
		return err
	}
	if err := c.release(ctx, code); err != nil {
		return err
	}
	pressed = false
	return nil
}

// drag presses the left button at one point, moves to another with the button
// held, and releases there. The release is a coordinate-less button command, so
// it is not refused for a position and the pointer is already at the end point.
func (c *compositorPointer) drag(ctx context.Context, from, to pointer.Point) error {
	if err := c.glide(ctx, from); err != nil {
		return err
	}
	if err := c.dwell(ctx); err != nil {
		return err
	}
	pressed := false
	defer func() {
		if pressed {
			c.releaseQuietly(ctx, evdevButtonLeft)
		}
	}()
	if err := c.button(ctx, from, evdevButtonLeft, true); err != nil {
		return err
	}
	pressed = true
	c.clicks = append(c.clicks, pointerClickPoint{At: time.Now(), X: from.X, Y: from.Y, Button: "left", Count: 1})
	if err := c.dragTravel(ctx, from, to); err != nil {
		return err
	}
	if err := c.dwell(ctx); err != nil {
		return err
	}
	if err := c.release(ctx, evdevButtonLeft); err != nil {
		return err
	}
	pressed = false
	return nil
}

// dragTravel moves with the button held. A motion that jumps still nudges the
// pointer first and lets a frame pass, because HTML5 drag and drop only starts
// once the page has seen the pointer move after the press.
func (c *compositorPointer) dragTravel(ctx context.Context, from, to pointer.Point) error {
	if c.motion.TravelDuration(from.Distance(to)) > 0 {
		return c.glide(ctx, to)
	}
	if distance := from.Distance(to); distance > pointerDragNudge {
		nudge := pointer.Point{
			X: from.X + (to.X-from.X)/distance*pointerDragNudge,
			Y: from.Y + (to.Y-from.Y)/distance*pointerDragNudge,
		}
		if err := c.place(ctx, nudge); err != nil {
			return err
		}
		if err := sleepContext(ctx, c.frame); err != nil {
			return err
		}
	}
	return c.place(ctx, to)
}

// scroll glides to the point and turns the wheel there. The delta is spread over
// the motion's duration as wheel steps that follow its easing.
func (c *compositorPointer) scroll(ctx context.Context, at pointer.Point, deltaX, deltaY float64) error {
	if err := c.glide(ctx, at); err != nil {
		return err
	}
	if err := c.dwell(ctx); err != nil {
		return err
	}
	duration := c.motion.TravelDuration(math.Hypot(deltaX, deltaY))
	if duration <= 0 {
		return c.axis(ctx, at, deltaX, deltaY)
	}
	ticker := time.NewTicker(c.frame)
	defer ticker.Stop()
	began := time.Now()
	var sentX, sentY float64
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case now := <-ticker.C:
			elapsed := now.Sub(began)
			if elapsed >= duration {
				return c.axis(ctx, at, deltaX-sentX, deltaY-sentY)
			}
			progress := c.motion.Ease(float64(elapsed) / float64(duration))
			stepX, stepY := deltaX*progress-sentX, deltaY*progress-sentY
			if err := c.axis(ctx, at, stepX, stepY); err != nil {
				return err
			}
			sentX += stepX
			sentY += stepY
		}
	}
}

// axis sends wheel movement in CSS pixels with the same unit conversion the
// interactive scroll path uses.
func (c *compositorPointer) axis(ctx context.Context, at pointer.Point, deltaX, deltaY float64) error {
	if math.Abs(deltaX) < 1e-3 && math.Abs(deltaY) < 1e-3 {
		return nil
	}
	return c.command(ctx, "axis-at %d %.3f %.3f %.3f %.3f\n", c.surfaceID, at.X, at.Y, deltaX/westonAxisStepDistance, deltaY/westonAxisStepDistance)
}

func sleepContext(ctx context.Context, duration time.Duration) error {
	if duration <= 0 {
		return ctx.Err()
	}
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

package browser

import (
	"context"
	"fmt"
	"math"
	"math/rand/v2"
	"sync"
	"time"

	"github.com/aperture/aperture/internal/recording"
)

// cdpRect is a box in surface px.
type cdpRect struct{ x, y, width, height float64 }

// glideStyle is how one glide goes: its timing, its path (nil motion is a straight one) and the box
// it heads for, zero when the page could not tell.
type glideStyle struct {
	timing cadenceTiming
	motion *naturalMotion
	target cdpRect
}

const (
	// fittsDefaultWidth stands in for the target's width when the page cannot tell: a typical button.
	fittsDefaultWidth = 32.0
	// targetInset keeps the landing point this far inside a target's edges, a quarter of a smaller target.
	targetInset = 4.0
	// naturalMotionStream is the PCG stream of every natural motion; the seed alone picks the paths.
	naturalMotionStream = 0x61706572747572
)

// fittsDuration is the time Fitts's law gives a pointer movement over distance to a target that is
// width wide along the movement, clamped to the timing's bounds.
func fittsDuration(timing cadenceTiming, distance, width float64) time.Duration {
	if width <= 0 || math.IsInf(width, 0) {
		width = fittsDefaultWidth
	}
	difficulty := math.Log2(distance/width + 1)
	duration := timing.fittsA + time.Duration(difficulty*float64(timing.fittsB))
	return min(max(duration, timing.glideMin), timing.glideMax)
}

// widthAlong is the extent of the box through its center along a unit direction: the W of Fitts's
// law for a target approached from that direction.
func (r cdpRect) widthAlong(ux, uy float64) float64 {
	width := math.Inf(1)
	if ux != 0 {
		width = min(width, r.width/math.Abs(ux))
	}
	if uy != 0 {
		width = min(width, r.height/math.Abs(uy))
	}
	return width
}

// inside moves a point off the box's edges into its inner area.
func (r cdpRect) inside(at cdpPoint) cdpPoint {
	if r.width <= 0 || r.height <= 0 {
		return at
	}
	insetX, insetY := min(targetInset, r.width/4), min(targetInset, r.height/4)
	return cdpPoint{clamp(at.x, r.x+insetX, r.x+r.width-insetX), clamp(at.y, r.y+insetY, r.y+r.height-insetY)}
}

// naturalMotion draws the random parts of natural paths from one seeded generator, so a recording
// that names its seed replays the same paths for the same actions.
type naturalMotion struct {
	mu  sync.Mutex
	rng *rand.Rand
}

func newNaturalMotion(seed int64) *naturalMotion {
	return &naturalMotion{rng: rand.New(rand.NewPCG(uint64(seed), naturalMotionStream))}
}

// newRecordingMotion is the motion a validated recording config asks for, nil for linear paths.
func newRecordingMotion(motion *recording.Motion) *naturalMotion {
	if motion == nil || motion.Type != recording.MotionNatural || motion.Seed == nil {
		return nil
	}
	return newNaturalMotion(*motion.Seed)
}

// glideLeg is one stretch of a glide: at maps eased progress 0..1 to a point.
type glideLeg struct {
	duration time.Duration
	at       func(progress float64) cdpPoint
}

// planGlide lays out the legs of a glide. A straight glide is one leg. A natural one bows to a side
// along a cubic Bézier curve and, now and then on longer moves, overshoots the target by a few px
// and comes back in a short correction leg.
func planGlide(from, to cdpPoint, style glideStyle) []glideLeg {
	dx, dy := to.x-from.x, to.y-from.y
	distance := math.Hypot(dx, dy)
	ux, uy := dx/distance, dy/distance
	width := fittsDefaultWidth
	if style.target.width > 0 && style.target.height > 0 {
		width = style.target.widthAlong(ux, uy)
	}
	duration := fittsDuration(style.timing, distance, width)
	if style.motion == nil {
		return []glideLeg{{duration, func(t float64) cdpPoint { return cdpPoint{from.x + dx*t, from.y + dy*t} }}}
	}

	style.motion.mu.Lock()
	rng := style.motion.rng
	side := 1.0
	if rng.IntN(2) == 0 {
		side = -1
	}
	// The bow is 4-16% of the distance; the second control point bends less, so the curve eases
	// into the target rather than hooking.
	bow := side * distance * (0.04 + 0.12*rng.Float64())
	firstAlong, secondAlong := 0.2+0.2*rng.Float64(), 0.6+0.2*rng.Float64()
	secondBow := bow * (0.3 + 0.6*rng.Float64())
	overshoot := distance >= 120 && rng.Float64() < 0.3
	past := clamp(0.04*distance, 4, 14) * (0.7 + 0.6*rng.Float64())
	drift := past * (rng.Float64() - 0.5) * 0.6
	style.motion.mu.Unlock()

	end := to
	if overshoot {
		end = cdpPoint{to.x + ux*past - uy*drift, to.y + uy*past + ux*drift}
	}
	nx, ny := -uy, ux
	c1 := cdpPoint{from.x + dx*firstAlong + nx*bow, from.y + dy*firstAlong + ny*bow}
	c2 := cdpPoint{from.x + dx*secondAlong + nx*secondBow, from.y + dy*secondAlong + ny*secondBow}
	legs := []glideLeg{{duration, func(t float64) cdpPoint {
		u := 1 - t
		a, b, c, d := u*u*u, 3*u*u*t, 3*u*t*t, t*t*t
		return cdpPoint{a*from.x + b*c1.x + c*c2.x + d*end.x, a*from.y + b*c1.y + c*c2.y + d*end.y}
	}}}
	if overshoot {
		legs = append(legs, glideLeg{style.timing.glideMin, func(t float64) cdpPoint {
			return cdpPoint{end.x + (to.x-end.x)*t, end.y + (to.y-end.y)*t}
		}})
	}
	return legs
}

// targetBoxExpression measures the element under a point of the page as [left, top, width, height].
const targetBoxExpression = `(()=>{const e=document.elementFromPoint(%v,%v);if(!e)return null;
const r=e.getBoundingClientRect();return [r.left,r.top,r.width,r.height]})()`

// aim prepares a glide to a point of the page in rootSession. It asks the page for the element
// under the point, so the travel time follows Fitts's law and the pointer lands inside the
// element's inner area rather than on its edge. The pointer resting where it last aimed for the same
// point skips the round trip: the move and the press that follow a hit-target glide land alike.
func (c *cdpProxyConn) aim(rootSession string, surface cdpSurface, at cdpPoint, timing cadenceTiming) (cdpPoint, glideStyle) {
	style := c.glideStyle(timing)
	pointer := c.proxy.pointer
	last := pointer.state(surface.id).aim
	if rest := pointer.position(surface); last.requested == at && math.Hypot(rest.x-last.landed.x, rest.y-last.landed.y) < 0.5 {
		style.target = last.box
		return last.landed, style
	}
	if rootSession == "" {
		return at, style
	}
	var box []float64
	probe, cancel := context.WithTimeout(c.ctx, deliveryBarrier)
	err := c.evaluate(probe, rootSession, fmt.Sprintf(targetBoxExpression, at.x, at.y), &box)
	cancel()
	if err != nil || len(box) != 4 {
		return at, style
	}
	style.target = cdpRect{box[0], box[1], box[2], box[3]}
	landed := style.target.inside(at)
	pointer.update(surface.id, func(state *cdpPointerState) {
		state.aim = cdpAim{requested: at, landed: landed, box: style.target}
	})
	return landed, style
}

// glideStyle is a glide of the cadence's timing in the motion of the recording that sets the pace.
func (c *cdpProxyConn) glideStyle(timing cadenceTiming) glideStyle {
	style := glideStyle{timing: timing}
	if c.proxy.motion != nil {
		style.motion = c.proxy.motion()
	}
	return style
}

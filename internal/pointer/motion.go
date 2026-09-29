// Package pointer describes how Aperture-driven pointer gestures travel across
// a page: the public motion setting, and the timing and path it produces.
package pointer

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"time"
)

// Kind names one of the motion presets or parameterized forms.
type Kind string

const (
	// KindNatural is an eased, slightly curved glide at roughly 1200 px/s.
	KindNatural Kind = "natural"
	// KindFast is a quicker glide with less curvature.
	KindFast Kind = "fast"
	// KindInstant jumps to the destination in one step.
	KindInstant Kind = "instant"
	// KindSpeed glides at a given average speed in px/s.
	KindSpeed Kind = "speed"
	// KindDuration glides for a fixed time regardless of distance.
	KindDuration Kind = "duration"
)

const (
	MinSpeed    = 10.0
	MaxSpeed    = 100000.0
	MaxDuration = 30 * time.Second

	naturalSpeed       = 1200.0
	naturalMinDuration = 220 * time.Millisecond
	naturalMaxDuration = 1400 * time.Millisecond
	fastSpeed          = 3200.0
	fastMinDuration    = 60 * time.Millisecond
	fastMaxDuration    = 450 * time.Millisecond
	speedMinDuration   = 16 * time.Millisecond
	// A pointer that is already this close to its destination does not travel.
	negligibleDistance = 0.5
	// Moves shorter than this stay straight; a bend would only look like jitter.
	minCurvedDistance = 8.0
)

// Motion is the public motion setting: "natural", "fast", "instant",
// {"speed": px/s}, or {"durationMs": ms}. The zero value means unset.
type Motion struct {
	Kind     Kind
	Speed    float64
	Duration time.Duration
}

// Natural is the default motion when nothing else is configured.
var Natural = Motion{Kind: KindNatural}

// IsZero reports whether the motion is unset.
func (m Motion) IsZero() bool {
	return m.Kind == ""
}

// Validate rejects unknown kinds and out-of-range parameters.
func (m Motion) Validate() error {
	switch m.Kind {
	case KindNatural, KindFast, KindInstant:
		return nil
	case KindSpeed:
		if math.IsNaN(m.Speed) || m.Speed < MinSpeed || m.Speed > MaxSpeed {
			return fmt.Errorf("motion speed must be between %g and %g px/s", MinSpeed, MaxSpeed)
		}
		return nil
	case KindDuration:
		if m.Duration < 0 || m.Duration > MaxDuration {
			return fmt.Errorf("motion durationMs must be between 0 and %d", MaxDuration.Milliseconds())
		}
		return nil
	default:
		return errors.New(`motion must be "natural", "fast", "instant", {"speed": px/s} or {"durationMs": ms}`)
	}
}

// UnmarshalJSON accepts a preset name or a single-key object.
func (m *Motion) UnmarshalJSON(data []byte) error {
	data = bytes.TrimSpace(data)
	if len(data) == 0 {
		return errors.New("motion is empty")
	}
	var parsed Motion
	switch data[0] {
	case '"':
		var name string
		if err := json.Unmarshal(data, &name); err != nil {
			return err
		}
		parsed.Kind = Kind(name)
		if parsed.Kind == KindSpeed || parsed.Kind == KindDuration {
			return fmt.Errorf("motion %q needs a value; use {\"speed\": px/s} or {\"durationMs\": ms}", name)
		}
	case '{':
		var object map[string]json.RawMessage
		if err := json.Unmarshal(data, &object); err != nil {
			return err
		}
		if len(object) != 1 {
			return errors.New(`motion object must contain exactly one of "speed" or "durationMs"`)
		}
		if raw, ok := object["speed"]; ok {
			parsed.Kind = KindSpeed
			if err := json.Unmarshal(raw, &parsed.Speed); err != nil {
				return errors.New("motion speed must be a number")
			}
		} else if raw, ok := object["durationMs"]; ok {
			var milliseconds float64
			if err := json.Unmarshal(raw, &milliseconds); err != nil {
				return errors.New("motion durationMs must be a number")
			}
			if math.IsNaN(milliseconds) || milliseconds < 0 || milliseconds > float64(MaxDuration.Milliseconds()) {
				return fmt.Errorf("motion durationMs must be between 0 and %d", MaxDuration.Milliseconds())
			}
			parsed.Kind = KindDuration
			parsed.Duration = time.Duration(milliseconds * float64(time.Millisecond))
		} else {
			return errors.New(`motion object must contain exactly one of "speed" or "durationMs"`)
		}
	default:
		return errors.New(`motion must be a preset name or an object with "speed" or "durationMs"`)
	}
	if err := parsed.Validate(); err != nil {
		return err
	}
	*m = parsed
	return nil
}

// MarshalJSON emits the same form UnmarshalJSON accepts.
func (m Motion) MarshalJSON() ([]byte, error) {
	switch m.Kind {
	case KindSpeed:
		return json.Marshal(map[string]float64{"speed": m.Speed})
	case KindDuration:
		return json.Marshal(map[string]float64{"durationMs": float64(m.Duration) / float64(time.Millisecond)})
	case "":
		return json.Marshal(KindNatural)
	default:
		return json.Marshal(string(m.Kind))
	}
}

// Resolve picks the effective motion. Precedence is the tool parameter, then
// the recording setting, then the session setting, then natural. Any candidate
// may be nil or unset.
func Resolve(parameter, recording, session *Motion) Motion {
	for _, candidate := range []*Motion{parameter, recording, session} {
		if candidate != nil && !candidate.IsZero() {
			return *candidate
		}
	}
	return Natural
}

// Point is a position in page CSS pixels.
type Point struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// Distance returns the straight-line distance to another point.
func (p Point) Distance(other Point) float64 {
	return math.Hypot(other.X-p.X, other.Y-p.Y)
}

// TravelDuration returns how long covering distance px takes. Zero means the
// pointer jumps.
func (m Motion) TravelDuration(distance float64) time.Duration {
	if distance < negligibleDistance {
		return 0
	}
	switch m.Kind {
	case KindInstant:
		return 0
	case KindFast:
		return clampDuration(distance/fastSpeed, fastMinDuration, fastMaxDuration)
	case KindSpeed:
		return clampDuration(distance/m.Speed, speedMinDuration, MaxDuration)
	case KindDuration:
		return m.Duration
	default:
		return clampDuration(distance/naturalSpeed, naturalMinDuration, naturalMaxDuration)
	}
}

func clampDuration(seconds float64, minimum, maximum time.Duration) time.Duration {
	return min(max(time.Duration(seconds*float64(time.Second)), minimum), maximum)
}

// Ease maps time progress in [0, 1] to distance progress in [0, 1].
func (m Motion) Ease(progress float64) float64 {
	progress = min(max(progress, 0), 1)
	if m.Kind == KindFast {
		return easeInOutSine(progress)
	}
	return easeInOutCubic(progress)
}

func easeInOutCubic(t float64) float64 {
	if t < 0.5 {
		return 4 * t * t * t
	}
	remaining := -2*t + 2
	return 1 - remaining*remaining*remaining/2
}

func easeInOutSine(t float64) float64 {
	return -(math.Cos(math.Pi*t) - 1) / 2
}

// curveAmplitude is the largest sideways bend, as a fraction of the distance
// and in absolute pixels.
func (m Motion) curveAmplitude(distance float64) float64 {
	if distance < minCurvedDistance || m.Kind == KindInstant {
		return 0
	}
	if m.Kind == KindFast {
		return min(distance*0.03, 12)
	}
	return min(distance*0.07, 28)
}

// Path is a gentle cubic Bezier between two points. It is deterministic: the
// side the path bows to depends only on its endpoints, so a repeated gesture
// retraces the same route.
type Path struct {
	motion Motion
	from   Point
	to     Point
	c1     Point
	c2     Point
}

// NewPath builds the route from one point to another.
func NewPath(from, to Point, m Motion) Path {
	path := Path{motion: m, from: from, to: to, c1: from, c2: to}
	distance := from.Distance(to)
	amplitude := m.curveAmplitude(distance)
	if amplitude == 0 {
		// A straight line: control points on the segment keep the curve linear.
		path.c1 = lerp(from, to, 1.0/3)
		path.c2 = lerp(from, to, 2.0/3)
		return path
	}
	normal := Point{X: -(to.Y - from.Y) / distance, Y: (to.X - from.X) / distance}
	side := 1.0
	if bowsLeft(from, to) {
		side = -1
	}
	path.c1 = Point{
		X: from.X + (to.X-from.X)*0.3 + normal.X*amplitude*side,
		Y: from.Y + (to.Y-from.Y)*0.3 + normal.Y*amplitude*side,
	}
	path.c2 = Point{
		X: from.X + (to.X-from.X)*0.75 + normal.X*amplitude*side*0.5,
		Y: from.Y + (to.Y-from.Y)*0.75 + normal.Y*amplitude*side*0.5,
	}
	return path
}

func bowsLeft(from, to Point) bool {
	hash := int64(math.Abs(from.X)) + 3*int64(math.Abs(from.Y)) + 7*int64(math.Abs(to.X)) + 13*int64(math.Abs(to.Y))
	return hash%2 == 1
}

// At returns the position after the given fraction of the travel time.
func (p Path) At(progress float64) Point {
	if progress <= 0 {
		return p.from
	}
	if progress >= 1 {
		return p.to
	}
	t := p.motion.Ease(progress)
	u := 1 - t
	return Point{
		X: u*u*u*p.from.X + 3*u*u*t*p.c1.X + 3*u*t*t*p.c2.X + t*t*t*p.to.X,
		Y: u*u*u*p.from.Y + 3*u*u*t*p.c1.Y + 3*u*t*t*p.c2.Y + t*t*t*p.to.Y,
	}
}

func lerp(a, b Point, t float64) Point {
	return Point{X: a.X + (b.X-a.X)*t, Y: a.Y + (b.Y-a.Y)*t}
}

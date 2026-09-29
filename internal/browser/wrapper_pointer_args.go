package browser

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/aperture/aperture/internal/pointer"
)

// The Aperture pointer tools replace the Playwright MCP tools of the same name,
// so clients keep one name for each gesture.
const (
	pointerToolClick  = "browser_click"
	pointerToolMove   = "browser_move"
	pointerToolDrag   = "browser_drag"
	pointerToolScroll = "browser_scroll"
)

const (
	pointerDefaultTimeout = 5 * time.Second
	pointerMaxTimeout     = 20 * time.Second
	pointerMaxHold        = 30 * time.Second
	pointerMaxCaption     = 500
	pointerMaxCoordinate  = 100000.0
	pointerMaxClickCount  = 3
)

var pointerModifierNames = map[string]struct{}{
	"Alt": {}, "Control": {}, "ControlOrMeta": {}, "Meta": {}, "Shift": {},
}

// pointerGestureSpec is one validated pointer gesture.
type pointerGestureSpec struct {
	Tool       string
	Kind       pointerGestureKind
	From       pointerEndpoint
	To         pointerEndpoint
	Button     string
	ClickCount int
	Modifiers  []string
	ScrollX    float64
	ScrollY    float64
	Motion     *pointer.Motion
	Hold       time.Duration
	Caption    string
	Timeout    time.Duration
}

// pointerEndpoint locates a gesture position by Playwright snapshot ref (or
// selector) or by viewport CSS pixels. The zero value means unspecified.
type pointerEndpoint struct {
	Target  string
	Element string
	Point   *pointer.Point
}

func (e pointerEndpoint) isZero() bool {
	return e.Target == "" && e.Point == nil
}

func (e pointerEndpoint) describe() string {
	switch {
	case e.Target != "" && e.Element != "":
		return fmt.Sprintf("%q (%s)", e.Element, e.Target)
	case e.Target != "":
		return e.Target
	case e.Point != nil:
		return fmt.Sprintf("(%s, %s)", formatCoordinate(e.Point.X), formatCoordinate(e.Point.Y))
	default:
		return "the pointer position"
	}
}

// pointerCommonArgs are accepted by every pointer tool.
type pointerCommonArgs struct {
	HoldMs    *float64 `json:"holdMs"`
	Caption   string   `json:"caption"`
	TimeoutMs *float64 `json:"timeoutMs"`
}

// pointerMotionArgs are accepted by the tools that travel a pointer path. A
// scroll does not embed them, so its parser rejects motion as an unknown
// argument.
type pointerMotionArgs struct {
	Motion *pointer.Motion `json:"motion"`
}

type pointerClickArgs struct {
	Target     string   `json:"target"`
	Element    string   `json:"element"`
	X          *float64 `json:"x"`
	Y          *float64 `json:"y"`
	Button     string   `json:"button"`
	ClickCount *int     `json:"clickCount"`
	// DoubleClick is Playwright's browser_click parameter, kept as an alias for
	// clickCount 2 so existing clients keep working.
	DoubleClick *bool    `json:"doubleClick"`
	Modifiers   []string `json:"modifiers"`
	pointerCommonArgs
	pointerMotionArgs
}

type pointerMoveArgs struct {
	Target  string   `json:"target"`
	Element string   `json:"element"`
	X       *float64 `json:"x"`
	Y       *float64 `json:"y"`
	pointerCommonArgs
	pointerMotionArgs
}

type pointerDragArgs struct {
	StartTarget  string   `json:"startTarget"`
	StartElement string   `json:"startElement"`
	StartX       *float64 `json:"startX"`
	StartY       *float64 `json:"startY"`
	EndTarget    string   `json:"endTarget"`
	EndElement   string   `json:"endElement"`
	EndX         *float64 `json:"endX"`
	EndY         *float64 `json:"endY"`
	pointerCommonArgs
	pointerMotionArgs
}

type pointerScrollArgs struct {
	Target  string   `json:"target"`
	Element string   `json:"element"`
	X       *float64 `json:"x"`
	Y       *float64 `json:"y"`
	DeltaX  *float64 `json:"deltaX"`
	DeltaY  *float64 `json:"deltaY"`
	pointerCommonArgs
}

// parsePointerGesture decodes and validates the arguments of one pointer tool.
func parsePointerGesture(tool string, arguments json.RawMessage) (pointerGestureSpec, error) {
	if len(bytes.TrimSpace(arguments)) == 0 {
		arguments = json.RawMessage(`{}`)
	}
	spec := pointerGestureSpec{Tool: tool, Button: "left", ClickCount: 1}
	var common pointerCommonArgs
	var motion *pointer.Motion
	switch tool {
	case pointerToolClick:
		var args pointerClickArgs
		if err := decodePointerArguments(arguments, &args); err != nil {
			return spec, err
		}
		spec.Kind = pointerGestureClick
		from, err := newPointerEndpoint("", args.Target, args.Element, args.X, args.Y, true)
		if err != nil {
			return spec, err
		}
		spec.From = from
		if args.Button != "" {
			if args.Button != "left" && args.Button != "right" && args.Button != "middle" {
				return spec, errors.New(`button must be "left", "right" or "middle"`)
			}
			spec.Button = args.Button
		}
		if args.ClickCount != nil {
			if *args.ClickCount < 1 || *args.ClickCount > pointerMaxClickCount {
				return spec, fmt.Errorf("clickCount must be between 1 and %d", pointerMaxClickCount)
			}
			spec.ClickCount = *args.ClickCount
		}
		if args.DoubleClick != nil && *args.DoubleClick {
			if args.ClickCount != nil && *args.ClickCount != 2 {
				return spec, errors.New("doubleClick conflicts with clickCount; use clickCount alone")
			}
			spec.ClickCount = 2
		}
		modifiers, err := validatePointerModifiers(args.Modifiers)
		if err != nil {
			return spec, err
		}
		spec.Modifiers = modifiers
		common, motion = args.pointerCommonArgs, args.Motion
	case pointerToolMove:
		var args pointerMoveArgs
		if err := decodePointerArguments(arguments, &args); err != nil {
			return spec, err
		}
		spec.Kind = pointerGestureMove
		from, err := newPointerEndpoint("", args.Target, args.Element, args.X, args.Y, true)
		if err != nil {
			return spec, err
		}
		spec.From = from
		common, motion = args.pointerCommonArgs, args.Motion
	case pointerToolDrag:
		var args pointerDragArgs
		if err := decodePointerArguments(arguments, &args); err != nil {
			return spec, err
		}
		spec.Kind = pointerGestureDrag
		from, err := newPointerEndpoint("start", args.StartTarget, args.StartElement, args.StartX, args.StartY, true)
		if err != nil {
			return spec, err
		}
		to, err := newPointerEndpoint("end", args.EndTarget, args.EndElement, args.EndX, args.EndY, true)
		if err != nil {
			return spec, err
		}
		spec.From, spec.To = from, to
		common, motion = args.pointerCommonArgs, args.Motion
	case pointerToolScroll:
		var args pointerScrollArgs
		if err := decodePointerArguments(arguments, &args); err != nil {
			return spec, err
		}
		spec.Kind = pointerGestureScroll
		from, err := newPointerEndpoint("", args.Target, args.Element, args.X, args.Y, false)
		if err != nil {
			return spec, err
		}
		spec.From = from
		for _, delta := range []struct {
			name  string
			value *float64
			out   *float64
		}{{"deltaX", args.DeltaX, &spec.ScrollX}, {"deltaY", args.DeltaY, &spec.ScrollY}} {
			if delta.value == nil {
				continue
			}
			if math.IsNaN(*delta.value) || math.IsInf(*delta.value, 0) || math.Abs(*delta.value) > pointerMaxCoordinate {
				return spec, fmt.Errorf("%s must be a number between -%g and %g", delta.name, pointerMaxCoordinate, pointerMaxCoordinate)
			}
			*delta.out = *delta.value
		}
		if spec.ScrollX == 0 && spec.ScrollY == 0 {
			return spec, errors.New("deltaX or deltaY must be non-zero")
		}
		common = args.pointerCommonArgs
	default:
		return spec, fmt.Errorf("unknown pointer tool %q", tool)
	}

	if motion != nil {
		if err := motion.Validate(); err != nil {
			return spec, err
		}
		spec.Motion = motion
	}
	hold, err := pointerDurationArgument("holdMs", common.HoldMs, 0, pointerMaxHold)
	if err != nil {
		return spec, err
	}
	spec.Hold = hold
	spec.Timeout = pointerDefaultTimeout
	if common.TimeoutMs != nil {
		timeout, err := pointerDurationArgument("timeoutMs", common.TimeoutMs, time.Millisecond, pointerMaxTimeout)
		if err != nil {
			return spec, err
		}
		spec.Timeout = timeout
	}
	if utf8.RuneCountInString(common.Caption) > pointerMaxCaption {
		return spec, fmt.Errorf("caption must be at most %d characters", pointerMaxCaption)
	}
	spec.Caption = common.Caption
	return spec, nil
}

func decodePointerArguments(arguments json.RawMessage, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(arguments))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return fmt.Errorf("invalid arguments: %w", err)
	}
	if decoder.More() {
		return errors.New("invalid arguments: trailing data")
	}
	return nil
}

// newPointerEndpoint validates one position. prefix names the parameters of a
// drag endpoint ("start" gives startTarget, startX, ...); required rejects an
// endpoint with neither a ref nor coordinates.
func newPointerEndpoint(prefix, target, element string, x, y *float64, required bool) (pointerEndpoint, error) {
	name := func(base string) string {
		if prefix == "" {
			return base
		}
		return prefix + strings.ToUpper(base[:1]) + base[1:]
	}
	target = strings.TrimSpace(target)
	endpoint := pointerEndpoint{Target: target, Element: strings.TrimSpace(element)}
	hasPoint := x != nil || y != nil
	if target != "" && hasPoint {
		return endpoint, fmt.Errorf("pass either %s or %s and %s, not both", name("target"), name("x"), name("y"))
	}
	if hasPoint {
		if x == nil || y == nil {
			return endpoint, fmt.Errorf("%s and %s must be given together", name("x"), name("y"))
		}
		for _, coordinate := range []struct {
			name  string
			value float64
		}{{name("x"), *x}, {name("y"), *y}} {
			if math.IsNaN(coordinate.value) || math.IsInf(coordinate.value, 0) || coordinate.value < 0 || coordinate.value > pointerMaxCoordinate {
				return endpoint, fmt.Errorf("%s must be a viewport coordinate between 0 and %g", coordinate.name, pointerMaxCoordinate)
			}
		}
		endpoint.Point = &pointer.Point{X: *x, Y: *y}
		endpoint.Element = ""
	}
	if required && endpoint.isZero() {
		return endpoint, fmt.Errorf("%s, or %s and %s, is required", name("target"), name("x"), name("y"))
	}
	return endpoint, nil
}

func validatePointerModifiers(modifiers []string) ([]string, error) {
	seen := make(map[string]struct{}, len(modifiers))
	unique := make([]string, 0, len(modifiers))
	for _, modifier := range modifiers {
		if _, ok := pointerModifierNames[modifier]; !ok {
			return nil, fmt.Errorf(`modifier %q must be one of "Alt", "Control", "ControlOrMeta", "Meta" or "Shift"`, modifier)
		}
		if _, duplicate := seen[modifier]; duplicate {
			continue
		}
		seen[modifier] = struct{}{}
		unique = append(unique, modifier)
	}
	return unique, nil
}

func pointerDurationArgument(name string, milliseconds *float64, minimum, maximum time.Duration) (time.Duration, error) {
	if milliseconds == nil {
		return minimum, nil
	}
	value := *milliseconds
	if math.IsNaN(value) || value*float64(time.Millisecond) < float64(minimum) || value*float64(time.Millisecond) > float64(maximum) {
		return 0, fmt.Errorf("%s must be between %d and %d", name, minimum.Milliseconds(), maximum.Milliseconds())
	}
	return time.Duration(value * float64(time.Millisecond)), nil
}

func formatCoordinate(value float64) string {
	return fmt.Sprintf("%.0f", value)
}

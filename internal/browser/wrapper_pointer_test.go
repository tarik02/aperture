package browser

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aperture/aperture/internal/pointer"
)

func TestParsePointerGesture(t *testing.T) {
	tests := []struct {
		name    string
		tool    string
		args    string
		check   func(t *testing.T, spec pointerGestureSpec)
		wantErr string
	}{
		{
			name: "click by ref with defaults",
			tool: pointerToolClick,
			args: `{"target": "e5", "element": "Save button"}`,
			check: func(t *testing.T, spec pointerGestureSpec) {
				if spec.Kind != pointerGestureClick || spec.From.Target != "e5" || spec.From.Element != "Save button" {
					t.Fatalf("spec = %+v", spec)
				}
				if spec.Button != "left" || spec.ClickCount != 1 || spec.Timeout != pointerDefaultTimeout || spec.Hold != 0 || spec.Motion != nil {
					t.Fatalf("defaults = %+v", spec)
				}
			},
		},
		{
			name: "click by coordinates with everything set",
			tool: pointerToolClick,
			args: `{"x": 10.5, "y": 20, "button": "right", "clickCount": 3, "modifiers": ["Shift", "Shift", "Control"],
				"motion": {"speed": 900}, "holdMs": 1500, "caption": "Open the menu", "timeoutMs": 2000}`,
			check: func(t *testing.T, spec pointerGestureSpec) {
				if spec.From.Point == nil || *spec.From.Point != (pointer.Point{X: 10.5, Y: 20}) || spec.From.Target != "" {
					t.Fatalf("from = %+v", spec.From)
				}
				if spec.Button != "right" || spec.ClickCount != 3 || !reflect.DeepEqual(spec.Modifiers, []string{"Shift", "Control"}) {
					t.Fatalf("spec = %+v", spec)
				}
				if spec.Motion == nil || spec.Motion.Kind != pointer.KindSpeed || spec.Hold != 1500*time.Millisecond || spec.Timeout != 2*time.Second || spec.Caption != "Open the menu" {
					t.Fatalf("spec = %+v", spec)
				}
			},
		},
		{name: "click without a position", tool: pointerToolClick, args: `{}`, wantErr: "target, or x and y, is required"},
		{name: "click with ref and coordinates", tool: pointerToolClick, args: `{"target": "e1", "x": 1, "y": 2}`, wantErr: "not both"},
		{name: "click with one coordinate", tool: pointerToolClick, args: `{"x": 1}`, wantErr: "given together"},
		{name: "negative coordinate", tool: pointerToolClick, args: `{"x": -1, "y": 2}`, wantErr: "viewport coordinate"},
		{name: "unknown button", tool: pointerToolClick, args: `{"target": "e1", "button": "back"}`, wantErr: "button must be"},
		{name: "too many clicks", tool: pointerToolClick, args: `{"target": "e1", "clickCount": 4}`, wantErr: "clickCount must be between"},
		{name: "unknown modifier", tool: pointerToolClick, args: `{"target": "e1", "modifiers": ["Hyper"]}`, wantErr: "modifier"},
		{name: "unknown motion", tool: pointerToolClick, args: `{"target": "e1", "motion": "slow"}`, wantErr: "motion"},
		{name: "scroll takes no motion", tool: pointerToolScroll, args: `{"deltaY": 5, "motion": "fast"}`, wantErr: `unknown field "motion"`},
		{name: "scroll rejects an invalid motion the same way", tool: pointerToolScroll, args: `{"deltaY": 5, "motion": "slow"}`, wantErr: `unknown field "motion"`},
		{
			name: "playwright doubleClick is an alias for clickCount 2",
			tool: pointerToolClick,
			args: `{"target": "e1", "doubleClick": true}`,
			check: func(t *testing.T, spec pointerGestureSpec) {
				if spec.ClickCount != 2 {
					t.Fatalf("clickCount = %d, want 2", spec.ClickCount)
				}
			},
		},
		{
			name: "doubleClick false leaves the click count alone",
			tool: pointerToolClick,
			args: `{"target": "e1", "doubleClick": false, "clickCount": 3}`,
			check: func(t *testing.T, spec pointerGestureSpec) {
				if spec.ClickCount != 3 {
					t.Fatalf("clickCount = %d, want 3", spec.ClickCount)
				}
			},
		},
		{name: "doubleClick with a conflicting clickCount", tool: pointerToolClick, args: `{"target": "e1", "doubleClick": true, "clickCount": 3}`, wantErr: "conflicts"},
		{name: "hold too long", tool: pointerToolMove, args: `{"target": "e1", "holdMs": 60000}`, wantErr: "holdMs"},
		{name: "timeout too long", tool: pointerToolMove, args: `{"target": "e1", "timeoutMs": 60000}`, wantErr: "timeoutMs"},
		{name: "caption too long", tool: pointerToolMove, args: fmt.Sprintf(`{"target": "e1", "caption": %q}`, strings.Repeat("x", pointerMaxCaption+1)), wantErr: "caption"},
		{
			name: "drag between ref and coordinates",
			tool: pointerToolDrag,
			args: `{"startTarget": "e1", "endX": 300, "endY": 400}`,
			check: func(t *testing.T, spec pointerGestureSpec) {
				if spec.Kind != pointerGestureDrag || spec.From.Target != "e1" || spec.To.Point == nil || spec.To.Point.X != 300 {
					t.Fatalf("spec = %+v", spec)
				}
			},
		},
		{name: "drag without an end", tool: pointerToolDrag, args: `{"startTarget": "e1"}`, wantErr: "endTarget, or endX and endY, is required"},
		{name: "drag with half a start", tool: pointerToolDrag, args: `{"startX": 3, "endTarget": "e1"}`, wantErr: "startX and startY must be given together"},
		{
			name: "scroll without a position",
			tool: pointerToolScroll,
			args: `{"deltaY": 600}`,
			check: func(t *testing.T, spec pointerGestureSpec) {
				if !spec.From.isZero() || spec.ScrollX != 0 || spec.ScrollY != 600 {
					t.Fatalf("spec = %+v", spec)
				}
			},
		},
		{name: "scroll without distance", tool: pointerToolScroll, args: `{"target": "e1"}`, wantErr: "non-zero"},
		{name: "unknown tool", tool: "browser_wiggle", args: `{}`, wantErr: "unknown pointer tool"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			spec, err := parsePointerGesture(test.tool, json.RawMessage(test.args))
			if test.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), test.wantErr) {
					t.Fatalf("error = %v, want it to contain %q", err, test.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("parsePointerGesture error = %v", err)
			}
			test.check(t, spec)
		})
	}
}

func TestPlanPointerCDPCalls(t *testing.T) {
	point := func(x, y float64) *pointer.Point { return &pointer.Point{X: x, Y: y} }
	mustParse := func(tool, args string) pointerGestureSpec {
		t.Helper()
		spec, err := parsePointerGesture(tool, json.RawMessage(args))
		if err != nil {
			t.Fatal(err)
		}
		return spec
	}
	tests := []struct {
		name      string
		spec      pointerGestureSpec
		from, to  *pointer.Point
		want      []playwrightCallRequest
		wantError string
	}{
		{
			name: "ref click",
			spec: mustParse(pointerToolClick, `{"target": "e5", "element": "Save"}`),
			want: []playwrightCallRequest{{Name: "browser_click", Arguments: map[string]any{"target": "e5", "element": "Save"}}},
		},
		{
			name: "ref double click with button and modifiers",
			spec: mustParse(pointerToolClick, `{"target": "e5", "clickCount": 2, "button": "right", "modifiers": ["Shift"]}`),
			want: []playwrightCallRequest{{Name: "browser_click", Arguments: map[string]any{"target": "e5", "button": "right", "modifiers": []string{"Shift"}, "doubleClick": true}}},
		},
		{
			name: "xy click",
			spec: mustParse(pointerToolClick, `{"x": 10, "y": 20, "clickCount": 2}`),
			want: []playwrightCallRequest{{Name: "browser_mouse_click_xy", Arguments: map[string]any{"x": 10.0, "y": 20.0, "clickCount": 2}}},
		},
		{
			name:      "xy click with modifiers",
			spec:      mustParse(pointerToolClick, `{"x": 10, "y": 20, "modifiers": ["Alt"]}`),
			wantError: "modifiers",
		},
		{
			name: "triple click on a ref uses its resolved point",
			spec: mustParse(pointerToolClick, `{"target": "e5", "clickCount": 3}`),
			from: point(40, 50),
			want: []playwrightCallRequest{{Name: "browser_mouse_click_xy", Arguments: map[string]any{"x": 40.0, "y": 50.0, "clickCount": 3}}},
		},
		{
			name: "hover ref",
			spec: mustParse(pointerToolMove, `{"target": "e2"}`),
			want: []playwrightCallRequest{{Name: "browser_hover", Arguments: map[string]any{"target": "e2"}}},
		},
		{
			name: "move to xy",
			spec: mustParse(pointerToolMove, `{"x": 1, "y": 2}`),
			want: []playwrightCallRequest{{Name: "browser_mouse_move_xy", Arguments: map[string]any{"x": 1.0, "y": 2.0}}},
		},
		{
			name: "drag between refs",
			spec: mustParse(pointerToolDrag, `{"startTarget": "e1", "startElement": "card", "endTarget": "e2"}`),
			want: []playwrightCallRequest{{Name: "browser_drag", Arguments: map[string]any{"startTarget": "e1", "startElement": "card", "endTarget": "e2"}}},
		},
		{
			name: "drag between points",
			spec: mustParse(pointerToolDrag, `{"startX": 1, "startY": 2, "endX": 3, "endY": 4}`),
			want: []playwrightCallRequest{{Name: "browser_mouse_drag_xy", Arguments: map[string]any{"startX": 1.0, "startY": 2.0, "endX": 3.0, "endY": 4.0}}},
		},
		{
			name: "drag from a ref to a point resolves the ref",
			spec: mustParse(pointerToolDrag, `{"startTarget": "e1", "endX": 3, "endY": 4}`),
			from: point(100, 110),
			want: []playwrightCallRequest{{Name: "browser_mouse_drag_xy", Arguments: map[string]any{"startX": 100.0, "startY": 110.0, "endX": 3.0, "endY": 4.0}}},
		},
		{
			name: "drag from a point to a ref resolves the ref",
			spec: mustParse(pointerToolDrag, `{"startX": 1, "startY": 2, "endTarget": "e9"}`),
			to:   point(7, 8),
			want: []playwrightCallRequest{{Name: "browser_mouse_drag_xy", Arguments: map[string]any{"startX": 1.0, "startY": 2.0, "endX": 7.0, "endY": 8.0}}},
		},
		{
			name: "scroll at the pointer",
			spec: mustParse(pointerToolScroll, `{"deltaY": 300}`),
			want: []playwrightCallRequest{{Name: "browser_mouse_wheel", Arguments: map[string]any{"deltaX": 0.0, "deltaY": 300.0}}},
		},
		{
			name: "scroll over a ref hovers first",
			spec: mustParse(pointerToolScroll, `{"target": "e3", "deltaX": -50}`),
			want: []playwrightCallRequest{
				{Name: "browser_hover", Arguments: map[string]any{"target": "e3"}},
				{Name: "browser_mouse_wheel", Arguments: map[string]any{"deltaX": -50.0, "deltaY": 0.0}},
			},
		},
		{
			name: "scroll over a point moves first",
			spec: mustParse(pointerToolScroll, `{"x": 5, "y": 6, "deltaY": 10}`),
			want: []playwrightCallRequest{
				{Name: "browser_mouse_move_xy", Arguments: map[string]any{"x": 5.0, "y": 6.0}},
				{Name: "browser_mouse_wheel", Arguments: map[string]any{"deltaX": 0.0, "deltaY": 10.0}},
			},
		},
		{
			name: "scroll over a resolved ref moves to where it was found",
			spec: mustParse(pointerToolScroll, `{"target": "e3", "deltaY": 20}`),
			from: point(40, 50),
			want: []playwrightCallRequest{
				{Name: "browser_mouse_move_xy", Arguments: map[string]any{"x": 40.0, "y": 50.0}},
				{Name: "browser_mouse_wheel", Arguments: map[string]any{"deltaX": 0.0, "deltaY": 20.0}},
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := planPointerCDPCalls(test.spec, test.from, test.to)
			if test.wantError != "" {
				if err == nil || !strings.Contains(err.Error(), test.wantError) {
					t.Fatalf("error = %v, want it to contain %q", err, test.wantError)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, test.want) {
				t.Fatalf("calls = %+v, want %+v", got, test.want)
			}
		})
	}
}

func TestPointerCDPNeedsPoints(t *testing.T) {
	tests := []struct {
		description string
		tool        string
		args        string
		wantFrom    bool
		wantTo      bool
	}{
		{"plain ref click", pointerToolClick, `{"target": "e1"}`, false, false},
		{"triple click on a ref", pointerToolClick, `{"target": "e1", "clickCount": 3}`, true, false},
		{"triple click on a point", pointerToolClick, `{"x": 1, "y": 2, "clickCount": 3}`, false, false},
		{"ref to ref", pointerToolDrag, `{"startTarget": "a", "endTarget": "b"}`, false, false},
		{"ref to point", pointerToolDrag, `{"startTarget": "a", "endX": 1, "endY": 2}`, true, false},
		{"point to ref", pointerToolDrag, `{"startX": 1, "startY": 2, "endTarget": "b"}`, false, true},
		{"scroll over a ref", pointerToolScroll, `{"target": "a", "deltaY": 5}`, false, false},
	}
	for _, test := range tests {
		spec, err := parsePointerGesture(test.tool, json.RawMessage(test.args))
		if err != nil {
			t.Fatalf("%s: %v", test.description, err)
		}
		from, to := pointerCDPNeedsPoints(spec)
		if from != test.wantFrom || to != test.wantTo {
			t.Errorf("%s: needs = (%t, %t), want (%t, %t)", test.description, from, to, test.wantFrom, test.wantTo)
		}
	}
}

func TestPointerCDPUnresolvedRef(t *testing.T) {
	cause := pointerFallback("the page's Content Security Policy blocks element resolution")
	tests := []struct {
		description string
		tool        string
		args        string
		isTo        bool
		wantErr     string // empty: Playwright can take the ref itself
	}{
		{"click on a ref", pointerToolClick, `{"target": "e1"}`, false, ""},
		{"double click on a ref", pointerToolClick, `{"target": "e1", "clickCount": 2}`, false, ""},
		{"triple click on a ref", pointerToolClick, `{"target": "e1", "clickCount": 3}`, false, "click count of 3 on e1 needs the element's position"},
		{"move to a ref", pointerToolMove, `{"target": "e1"}`, false, ""},
		{"scroll over a ref", pointerToolScroll, `{"target": "e1", "deltaY": 5}`, false, ""},
		{"ref to ref start", pointerToolDrag, `{"startTarget": "a", "endTarget": "b"}`, false, ""},
		{"ref to ref end", pointerToolDrag, `{"startTarget": "a", "endTarget": "b"}`, true, ""},
		{"ref to point, ref end", pointerToolDrag, `{"startTarget": "a", "endX": 1, "endY": 2}`, false, "needs the position of a"},
		{"point to ref, ref end", pointerToolDrag, `{"startX": 1, "startY": 2, "endTarget": "b"}`, true, "needs the position of b"},
	}
	for _, test := range tests {
		spec, err := parsePointerGesture(test.tool, json.RawMessage(test.args))
		if err != nil {
			t.Fatalf("%s: %v", test.description, err)
		}
		err = pointerCDPUnresolvedRef(spec, test.isTo, cause)
		if test.wantErr == "" {
			if err != nil {
				t.Errorf("%s: err = %v, want nil", test.description, err)
			}
			continue
		}
		var userErr *pointerUserError
		if !errors.As(err, &userErr) || !strings.Contains(err.Error(), test.wantErr) || !strings.Contains(err.Error(), "Content Security Policy") || strings.Contains(err.Error(), "cannot combine") {
			t.Errorf("%s: err = %v, want a user error containing %q and the cause", test.description, err, test.wantErr)
		}
	}
}

func TestPointerSurfacePoint(t *testing.T) {
	target := wrapperTargetSnapshot{Viewport: compositorViewport{Width: 1280, Height: 720, ScaleNumerator: 180, DeviceScaleFactor: 1.5}}

	// The compositor scales surface coordinates itself, so the device pixel ratio
	// does not enter the conversion.
	got, err := pointerSurfacePoint(target, &pointerViewportMetrics{Width: 1280, Height: 720, Scale: 1}, pointer.Point{X: 640.5, Y: 360.25})
	if err != nil || got != (pointer.Point{X: 640.5, Y: 360.25}) {
		t.Fatalf("pointerSurfacePoint = %+v, %v", got, err)
	}

	if _, err := pointerSurfacePoint(target, nil, pointer.Point{X: 1281, Y: 10}); err == nil {
		t.Fatal("a point right of the surface was accepted")
	}
	// The last pixel column is width-1, so width itself is outside the surface.
	if _, err := pointerSurfacePoint(target, nil, pointer.Point{X: 1280, Y: 10}); err == nil {
		t.Fatal("a point on the far edge was accepted")
	}
	// A page emulating a viewport that does not scale uniformly to the surface
	// cannot take compositor coordinates.
	if _, err := pointerSurfacePoint(target, &pointerViewportMetrics{Width: 800, Height: 600, Scale: 1}, pointer.Point{X: 100, Y: 100}); err == nil || !strings.Contains(err.Error(), "does not scale uniformly") || !errors.Is(err, errPointerFallback) {
		t.Fatalf("emulated viewport error = %v, want a fallback", err)
	}
	if _, err := pointerSurfacePoint(target, &pointerViewportMetrics{Width: 1280, Height: 720, Scale: 2}, pointer.Point{X: 10, Y: 10}); err == nil || !strings.Contains(err.Error(), "pinch-zoomed") {
		t.Fatalf("pinch-zoomed page error = %v", err)
	}
	if _, err := pointerSurfacePoint(wrapperTargetSnapshot{}, nil, pointer.Point{}); err == nil {
		t.Fatal("a target without a viewport was accepted")
	}
}

func TestPointerSurfacePointScalesForBrowserZoom(t *testing.T) {
	target := wrapperTargetSnapshot{Viewport: compositorViewport{Width: 1280, Height: 720}}

	// At 200% zoom the page is half as wide as the surface in CSS pixels.
	got, err := pointerSurfacePoint(target, &pointerViewportMetrics{Width: 640, Height: 360, Scale: 1}, pointer.Point{X: 100, Y: 50})
	if err != nil || got != (pointer.Point{X: 200, Y: 100}) {
		t.Fatalf("200%% zoom: %+v, %v", got, err)
	}
	// At 110% zoom the page size is rounded, so the two ratios differ slightly.
	got, err = pointerSurfacePoint(target, &pointerViewportMetrics{Width: 1164, Height: 655, Scale: 1}, pointer.Point{X: 582, Y: 327.5})
	if err != nil || math.Abs(got.X-640) > 1.5 || math.Abs(got.Y-360) > 1.5 {
		t.Fatalf("110%% zoom: %+v, %v", got, err)
	}
	// A CSS point that lies inside the page but scales past the surface is rejected.
	if _, err := pointerSurfacePoint(target, &pointerViewportMetrics{Width: 640, Height: 360, Scale: 1}, pointer.Point{X: 640, Y: 10}); err == nil {
		t.Fatal("a point past the zoomed page's edge was accepted")
	}
	// Rounding noise around 100% is not a zoom.
	got, err = pointerSurfacePoint(target, &pointerViewportMetrics{Width: 1279, Height: 720, Scale: 1}, pointer.Point{X: 500, Y: 500})
	if err != nil || got != (pointer.Point{X: 500, Y: 500}) {
		t.Fatalf("100%%: %+v, %v", got, err)
	}
}

func TestPlaywrightToolErrorRecognizesPageCSP(t *testing.T) {
	cspErr := &playwrightToolError{tool: "browser_evaluate", text: "EvalError: Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source"}
	if !cspErr.blockedByPageCSP() {
		t.Fatal("CSP failure was not recognized")
	}
	if (&playwrightToolError{tool: "browser_evaluate", text: "Ref e9 not found"}).blockedByPageCSP() {
		t.Fatal("a missing ref was taken for a CSP failure")
	}
}

func TestPointerRuntimeSessionMotionAndPosition(t *testing.T) {
	var state pointerRuntime
	if got := state.currentSessionMotion(); got != pointer.Natural {
		t.Fatalf("default session motion = %+v", got)
	}
	state.setSessionMotion(pointer.Motion{Kind: pointer.KindFast})
	if got := state.currentSessionMotion(); got.Kind != pointer.KindFast {
		t.Fatalf("session motion = %+v", got)
	}

	if _, ok := state.position(7); ok {
		t.Fatal("position known before any motion")
	}
	state.setPosition(7, pointer.Point{X: 3, Y: 4})
	if point, ok := state.position(7); !ok || point != (pointer.Point{X: 3, Y: 4}) {
		t.Fatalf("position = %+v, %t", point, ok)
	}
	if _, ok := state.position(8); ok {
		t.Fatal("a position on another surface was reused")
	}
}

func TestPointerMotionResolution(t *testing.T) {
	runtime := &wrapperRuntime{}
	spec := pointerGestureSpec{}
	if got := runtime.resolvePointerMotion(spec, "target"); got != pointer.Natural {
		t.Fatalf("default = %+v", got)
	}
	runtime.pointer.setSessionMotion(pointer.Motion{Kind: pointer.KindSpeed, Speed: 500})
	if got := runtime.resolvePointerMotion(spec, "target"); got.Kind != pointer.KindSpeed {
		t.Fatalf("session setting = %+v", got)
	}
	spec.Motion = &pointer.Motion{Kind: pointer.KindInstant}
	if got := runtime.resolvePointerMotion(spec, "target"); got.Kind != pointer.KindInstant {
		t.Fatalf("tool parameter = %+v", got)
	}
}

func TestPointerGestureRecordsAndObservers(t *testing.T) {
	var state pointerRuntime
	var observed []pointerGestureRecord
	stop := state.observe(func(record pointerGestureRecord) { observed = append(observed, record) })
	state.record(pointerGestureRecord{Kind: pointerGestureClick, Caption: "first"})
	stop()
	state.record(pointerGestureRecord{Kind: pointerGestureMove, Caption: "second"})

	if len(observed) != 1 || observed[0].Caption != "first" || observed[0].ID != 1 {
		t.Fatalf("observed = %+v", observed)
	}
	recent := state.recentGestures()
	if len(recent) != 2 || recent[1].Caption != "second" || recent[1].ID != 2 {
		t.Fatalf("recent = %+v", recent)
	}
	for range pointerGestureHistory + 10 {
		state.record(pointerGestureRecord{})
	}
	if got := len(state.recentGestures()); got != pointerGestureHistory {
		t.Fatalf("history holds %d gestures, want %d", got, pointerGestureHistory)
	}
}

// fakeCompositor answers the compositor control protocol and records commands.
type fakeCompositor struct {
	socket    string
	mu        sync.Mutex
	commands  []string
	onCommand func(command string)
	// respond, when set, chooses the reply line; the default is "ok".
	respond func(command string) string
}

func newFakeCompositor(t *testing.T) *fakeCompositor {
	t.Helper()
	dir, err := os.MkdirTemp("", "ap")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	fake := &fakeCompositor{socket: filepath.Join(dir, "c.sock")}
	listener, err := net.Listen("unix", fake.socket)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer func() { _ = connection.Close() }()
				line, err := bufio.NewReader(connection).ReadString('\n')
				if err != nil {
					return
				}
				command := strings.TrimSpace(line)
				fake.mu.Lock()
				fake.commands = append(fake.commands, command)
				hook := fake.onCommand
				respond := fake.respond
				fake.mu.Unlock()
				if hook != nil {
					hook(command)
				}
				reply := "ok"
				if respond != nil {
					reply = respond(command)
				}
				_, _ = connection.Write([]byte(reply + "\n"))
			}()
		}
	}()
	return fake
}

func (f *fakeCompositor) recorded() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.commands...)
}

func (f *fakeCompositor) pointer(motion pointer.Motion) *compositorPointer {
	c := &compositorPointer{
		socket:    f.socket,
		surfaceID: 7,
		width:     1280,
		height:    720,
		frame:     8 * time.Millisecond,
		motion:    motion,
		state:     &pointerRuntime{},
	}
	c.begin()
	return c
}

func TestCompositorPointerClickHoldsModifiersAroundEveryClick(t *testing.T) {
	fake := newFakeCompositor(t)
	c := fake.pointer(pointer.Motion{Kind: pointer.KindInstant})

	if err := c.click(context.Background(), pointer.Point{X: 100, Y: 200}, "right", 2, []string{"Shift", "Control"}); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"motion 7 640.000 360.000",
		"motion 7 100.000 200.000",
		"key 7 42 1",
		"key 7 29 1",
		"button-at 7 100.000 200.000 273 1",
		"button 7 273 0",
		"button-at 7 100.000 200.000 273 1",
		"button 7 273 0",
		"key 7 29 0",
		"key 7 42 0",
	}
	if got := fake.recorded(); !reflect.DeepEqual(got, want) {
		t.Fatalf("commands:\n got %q\nwant %q", got, want)
	}
	if len(c.clicks) != 2 || c.clicks[1].Count != 2 || c.clicks[0].Button != "right" || c.clicks[0].X != 100 {
		t.Fatalf("clicks = %+v", c.clicks)
	}
	if position, ok := c.state.position(7); !ok || position != (pointer.Point{X: 100, Y: 200}) {
		t.Fatalf("tracked position = %+v, %t", position, ok)
	}
}

func TestCompositorPointerReleasesEverythingWhenCancelled(t *testing.T) {
	fake := newFakeCompositor(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	fake.mu.Lock()
	fake.onCommand = func(command string) {
		if strings.HasPrefix(command, "button-at") && strings.HasSuffix(command, " 1") {
			cancel()
		}
	}
	fake.mu.Unlock()
	c := fake.pointer(pointer.Motion{Kind: pointer.KindInstant})
	c.state.setPosition(7, pointer.Point{X: 5, Y: 5})

	err := c.click(ctx, pointer.Point{X: 50, Y: 60}, "left", 1, []string{"Alt"})
	if err == nil {
		t.Fatal("cancelled click reported success")
	}
	commands := fake.recorded()
	last := commands[len(commands)-2:]
	if last[0] != "button 7 272 0" || last[1] != "key 7 56 0" {
		t.Fatalf("button and modifier were not released, last commands: %q", commands)
	}
}

func TestCompositorPointerReleasesWithoutCoordinatesAndRetries(t *testing.T) {
	fake := newFakeCompositor(t)
	var releases int
	fake.mu.Lock()
	fake.respond = func(command string) string {
		if command == "button 7 272 0" {
			fake.mu.Lock()
			releases++
			first := releases == 1
			fake.mu.Unlock()
			if first {
				return "error pointer is not ready"
			}
		}
		return "ok"
	}
	fake.mu.Unlock()
	c := fake.pointer(pointer.Motion{Kind: pointer.KindInstant})
	c.state.setPosition(7, pointer.Point{X: 5, Y: 5})

	if err := c.click(context.Background(), pointer.Point{X: 50, Y: 60}, "left", 1, nil); err != nil {
		t.Fatalf("click failed although the release retry succeeds: %v", err)
	}
	if releases != 2 {
		t.Fatalf("release was sent %d times, want a retry", releases)
	}
}

func TestCompositorPointerDragReleasesAfterRejectedMotion(t *testing.T) {
	fake := newFakeCompositor(t)
	fake.mu.Lock()
	fake.respond = func(command string) string {
		if strings.HasPrefix(command, "motion 7 610") || strings.HasPrefix(command, "motion 7 16") {
			return "error invalid motion coordinates"
		}
		return "ok"
	}
	fake.mu.Unlock()
	c := fake.pointer(pointer.Motion{Kind: pointer.KindInstant})
	c.state.setPosition(7, pointer.Point{X: 10, Y: 10})

	if err := c.drag(context.Background(), pointer.Point{X: 10, Y: 10}, pointer.Point{X: 610, Y: 10}); err == nil {
		t.Fatal("drag reported success although motion was rejected")
	}
	commands := fake.recorded()
	if last := commands[len(commands)-1]; last != "button 7 272 0" {
		t.Fatalf("button was not released by a coordinate-less command, last = %q (all %q)", last, commands)
	}
}

func TestCompositorPointerRetriesModifierRelease(t *testing.T) {
	fake := newFakeCompositor(t)
	var attempts int
	fake.mu.Lock()
	fake.respond = func(command string) string {
		if command == "key 7 42 0" {
			fake.mu.Lock()
			attempts++
			first := attempts == 1
			fake.mu.Unlock()
			if first {
				return "error surface is unavailable"
			}
		}
		return "ok"
	}
	fake.mu.Unlock()
	c := fake.pointer(pointer.Motion{Kind: pointer.KindInstant})
	if err := c.click(context.Background(), pointer.Point{X: 5, Y: 5}, "left", 1, []string{"Shift"}); err != nil {
		t.Fatal(err)
	}
	if attempts != 2 {
		t.Fatalf("modifier release attempts = %d, want 2", attempts)
	}
}

func TestCompositorPointerClampsStaleStartPosition(t *testing.T) {
	fake := newFakeCompositor(t)
	c := fake.pointer(pointer.Motion{Kind: pointer.KindInstant})
	c.state.setPosition(7, pointer.Point{X: 2000, Y: -30})

	if err := c.glide(context.Background(), pointer.Point{X: 100, Y: 100}); err != nil {
		t.Fatal(err)
	}
	want := []string{"motion 7 1279.000 0.000", "motion 7 100.000 100.000"}
	if got := fake.recorded(); !reflect.DeepEqual(got, want) {
		t.Fatalf("commands:\n got %q\nwant %q", got, want)
	}
}

func TestCompositorPointerGlideNeverLeavesSurface(t *testing.T) {
	fake := newFakeCompositor(t)
	c := fake.pointer(pointer.Motion{Kind: pointer.KindDuration, Duration: 100 * time.Millisecond})
	c.state.setPosition(7, pointer.Point{X: 0, Y: 0})

	if err := c.glide(context.Background(), pointer.Point{X: 1279, Y: 0}); err != nil {
		t.Fatal(err)
	}
	for _, command := range fake.recorded() {
		var surface int
		var x, y float64
		if n, _ := fmt.Sscanf(command, "motion %d %f %f", &surface, &x, &y); n != 3 || x < 0 || y < 0 || x > 1279 || y > 719 {
			t.Fatalf("motion outside the surface or malformed: %q", command)
		}
	}
}

func TestResolvePointerDragEndpoints(t *testing.T) {
	spec := func(from, to pointerEndpoint) pointerGestureSpec {
		return pointerGestureSpec{Kind: pointerGestureDrag, From: from, To: to}
	}
	ref := func(target string) pointerEndpoint { return pointerEndpoint{Target: target} }
	type call struct {
		target string
		verify bool
	}

	t.Run("refs resolve end, start, then re-check the end", func(t *testing.T) {
		var calls []call
		positions := map[string]pointer.Point{"start": {X: 10, Y: 10}, "end": {X: 500, Y: 400}}
		from, to, err := resolvePointerDragEndpoints(spec(ref("start"), ref("end")), func(endpoint pointerEndpoint, _, verify bool) (pointer.Point, error) {
			calls = append(calls, call{endpoint.Target, verify})
			point := positions[endpoint.Target]
			if endpoint.Target == "end" && verify {
				point = pointer.Point{X: 500, Y: 200} // the start's scroll moved it
			}
			return point, nil
		})
		if err != nil {
			t.Fatal(err)
		}
		want := []call{{"end", false}, {"start", false}, {"end", true}}
		if !reflect.DeepEqual(calls, want) {
			t.Fatalf("calls = %+v, want %+v", calls, want)
		}
		if from != (pointer.Point{X: 10, Y: 10}) || to != (pointer.Point{X: 500, Y: 200}) {
			t.Fatalf("from, to = %+v, %+v; want the re-checked end", from, to)
		}
	})

	t.Run("an end that cannot stay visible is a clear error", func(t *testing.T) {
		_, _, err := resolvePointerDragEndpoints(spec(ref("start"), ref("end")), func(endpoint pointerEndpoint, _, verify bool) (pointer.Point, error) {
			if verify {
				return pointer.Point{}, &pointerUserError{message: "element is outside the viewport"}
			}
			return pointer.Point{}, nil
		})
		var userErr *pointerUserError
		if !errors.As(err, &userErr) || !strings.Contains(err.Error(), "not visible at the same time") {
			t.Fatalf("error = %v", err)
		}
	})

	t.Run("a coordinate start needs no re-check", func(t *testing.T) {
		point := pointerEndpoint{Point: &pointer.Point{X: 1, Y: 2}}
		var calls int
		_, _, err := resolvePointerDragEndpoints(spec(point, ref("end")), func(pointerEndpoint, bool, bool) (pointer.Point, error) {
			calls++
			return pointer.Point{}, nil
		})
		if err != nil || calls != 2 {
			t.Fatalf("calls = %d, err = %v", calls, err)
		}
	})
}

func TestCompositorPointerDragNudgesBeforeJumping(t *testing.T) {
	fake := newFakeCompositor(t)
	c := fake.pointer(pointer.Motion{Kind: pointer.KindInstant})
	c.state.setPosition(7, pointer.Point{X: 10, Y: 10})

	if err := c.drag(context.Background(), pointer.Point{X: 10, Y: 10}, pointer.Point{X: 610, Y: 10}); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"motion 7 10.000 10.000",
		"button-at 7 10.000 10.000 272 1",
		"motion 7 16.000 10.000",
		"motion 7 610.000 10.000",
		"button 7 272 0",
	}
	if got := fake.recorded(); !reflect.DeepEqual(got, want) {
		t.Fatalf("commands:\n got %q\nwant %q", got, want)
	}
}

func TestCompositorPointerGlideFollowsPathToDestination(t *testing.T) {
	fake := newFakeCompositor(t)
	c := fake.pointer(pointer.Motion{Kind: pointer.KindDuration, Duration: 120 * time.Millisecond})
	c.state.setPosition(7, pointer.Point{X: 100, Y: 100})

	if err := c.glide(context.Background(), pointer.Point{X: 500, Y: 300}); err != nil {
		t.Fatal(err)
	}
	commands := fake.recorded()
	if len(commands) < 4 {
		t.Fatalf("a 120 ms glide sent only %d motions: %q", len(commands), commands)
	}
	if commands[len(commands)-1] != "motion 7 500.000 300.000" {
		t.Fatalf("glide did not end at the destination: %q", commands)
	}
	for _, command := range commands {
		if !strings.HasPrefix(command, "motion 7 ") {
			t.Fatalf("unexpected command %q", command)
		}
	}
	if len(c.path) != len(commands) || c.path[0].Offset <= 0 {
		t.Fatalf("path points = %d for %d motions", len(c.path), len(commands))
	}
}

func TestPlaywrightCallRejectsToolsReplacedByPointerTools(t *testing.T) {
	runtime := newWrapperRuntime(RuntimeEnvValues{WrapperControlToken: "secret"}, "")
	runtime.playwright = newPlaywrightMCPBackend(runtime.values)
	for _, name := range []string{"browser_click", "browser_hover", "browser_drag", "browser_mouse_click_xy", "browser_mouse_move_xy", "browser_mouse_drag_xy", "browser_mouse_down", "browser_mouse_up", "browser_mouse_wheel"} {
		body := strings.NewReader(fmt.Sprintf(`{"name": %q, "arguments": {}}`, name))
		request := httptest.NewRequest(http.MethodPost, "/automation/playwright", body)
		request.Header.Set("Authorization", "Bearer secret")
		recorder := httptest.NewRecorder()
		runtime.handlePlaywrightCall(recorder, request)
		if recorder.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want %d", name, recorder.Code, http.StatusBadRequest)
		}
	}
}

func TestPointerCallRequiresControlToken(t *testing.T) {
	runtime := newWrapperRuntime(RuntimeEnvValues{WrapperControlToken: "secret"}, "")
	runtime.playwright = newPlaywrightMCPBackend(runtime.values)
	request := httptest.NewRequest(http.MethodPost, "/automation/pointer", strings.NewReader(`{"name": "browser_click", "arguments": {"x": 1, "y": 2}}`))
	recorder := httptest.NewRecorder()
	runtime.handlePointerCall(recorder, request)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusUnauthorized)
	}

	request = httptest.NewRequest(http.MethodPost, "/automation/pointer", strings.NewReader(`{"name": "browser_click", "arguments": {"x": 1}}`))
	request.Header.Set("Authorization", "Bearer secret")
	recorder = httptest.NewRecorder()
	runtime.handlePointerCall(recorder, request)
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "given together") {
		t.Fatalf("invalid arguments: status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
}

func TestPointerCallWaitsForElement(t *testing.T) {
	for _, test := range []struct {
		call playwrightCallRequest
		want bool
	}{
		{playwrightCallRequest{Name: "browser_click", Arguments: map[string]any{"target": "e1"}}, true},
		{playwrightCallRequest{Name: "browser_drag", Arguments: map[string]any{"startTarget": "a", "endTarget": "b"}}, true},
		{playwrightCallRequest{Name: "browser_mouse_click_xy", Arguments: map[string]any{"x": 1.0, "y": 2.0}}, false},
	} {
		if got := pointerCallWaitsForElement(test.call); got != test.want {
			t.Errorf("%s: pointerCallWaitsForElement = %t, want %t", test.call.Name, got, test.want)
		}
	}
}

func TestHandleCursorWithoutCompositor(t *testing.T) {
	runtime := newWrapperRuntime(RuntimeEnvValues{WrapperControlToken: "secret"}, "")
	session, err := newLiveSession(runtime)
	if err != nil {
		t.Fatal(err)
	}
	runtime.liveSession = session
	put := func(body string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPut, "/cursor", strings.NewReader(body))
		recorder := httptest.NewRecorder()
		runtime.handleCursor(recorder, request)
		return recorder
	}

	if recorder := put(`{"motion": "fast"}`); recorder.Code != http.StatusOK {
		t.Fatalf("motion-only update: status = %d, body %s", recorder.Code, recorder.Body)
	}
	if got := runtime.pointer.currentSessionMotion(); got.Kind != pointer.KindFast {
		t.Fatalf("motion = %+v, want fast", got)
	}
	// A combined update the session cannot fully apply changes nothing.
	if recorder := put(`{"visible": false, "motion": "instant"}`); recorder.Code != http.StatusConflict {
		t.Fatalf("visibility without a compositor: status = %d, want %d", recorder.Code, http.StatusConflict)
	}
	if got := runtime.pointer.currentSessionMotion(); got.Kind != pointer.KindFast {
		t.Fatalf("motion after a refused update = %+v, want it unchanged", got)
	}
}

func TestPointerScrollDefaultPoint(t *testing.T) {
	runtime := newWrapperRuntime(RuntimeEnvValues{}, "")
	metrics := &pointerViewportMetrics{Width: 800, Height: 400, Scale: 1}
	target := &wrapperTargetSnapshot{SurfaceID: 7, Viewport: compositorViewport{Width: 1200, Height: 600}}

	if got := runtime.pointerScrollDefault(pointerScrollContext{}); got != nil {
		t.Fatalf("without viewport metrics = %v, want nil", got)
	}
	if got := runtime.pointerScrollDefault(pointerScrollContext{metrics: metrics}); got != nil {
		t.Fatalf("without a compositor surface = %v, want nil", got)
	}
	if got := runtime.pointerScrollDefault(pointerScrollContext{metrics: metrics, target: target}); got == nil || *got != (pointer.Point{X: 400, Y: 200}) {
		t.Fatalf("center = %v, want (400, 200)", got)
	}
	// The pointer's last position on the surface, at 150% zoom, in CSS pixels.
	runtime.pointer.setPosition(7, pointer.Point{X: 300, Y: 150})
	if got := runtime.pointerScrollDefault(pointerScrollContext{metrics: metrics, target: target}); got == nil || *got != (pointer.Point{X: 200, Y: 100}) {
		t.Fatalf("remembered position = %v, want (200, 100)", got)
	}
	// The pointer was last on another surface, so this page's center stands.
	runtime.pointer.setPosition(8, pointer.Point{X: 300, Y: 150})
	if got := runtime.pointerScrollDefault(pointerScrollContext{metrics: metrics, target: target}); got == nil || *got != (pointer.Point{X: 400, Y: 200}) {
		t.Fatalf("position on another surface = %v, want the center (400, 200)", got)
	}
}

func TestPointerScrollContextSurfacePoint(t *testing.T) {
	target := &wrapperTargetSnapshot{SurfaceID: 7, Viewport: compositorViewport{Width: 1200, Height: 600}}
	metrics := &pointerViewportMetrics{Width: 800, Height: 400, Scale: 1}
	scroll := pointerScrollContext{target: target, metrics: metrics}
	if got := scroll.surfacePoint(&pointer.Point{X: 100, Y: 50}, pointerEndpoint{}); got == nil || *got != (pointer.Point{X: 150, Y: 75}) {
		t.Fatalf("resolved ref = %v, want (150, 75)", got)
	}
	if got := scroll.surfacePoint(nil, pointerEndpoint{Point: &pointer.Point{X: 10, Y: 20}}); got == nil || *got != (pointer.Point{X: 15, Y: 30}) {
		t.Fatalf("coordinates = %v, want (15, 30)", got)
	}
	if got := (&pointerScrollContext{}).surfacePoint(&pointer.Point{X: 1, Y: 1}, pointerEndpoint{}); got != nil {
		t.Fatalf("without a compositor surface = %v, want nil", got)
	}
}

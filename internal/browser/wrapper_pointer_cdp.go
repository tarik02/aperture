package browser

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/aperture/aperture/internal/pointer"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// pointerCDPNeedsPoints reports which endpoints of a gesture must be resolved
// to viewport coordinates before Playwright can perform it: a drag between a ref
// and a point, and a click count that Playwright's ref-based click cannot do.
func pointerCDPNeedsPoints(spec pointerGestureSpec) (from, to bool) {
	switch spec.Kind {
	case pointerGestureClick:
		return spec.From.Target != "" && spec.ClickCount > 2, false
	case pointerGestureDrag:
		mixed := (spec.From.Target != "") != (spec.To.Target != "")
		return mixed && spec.From.Target != "", mixed && spec.To.Target != ""
	default:
		return false, false
	}
}

// planPointerCDPCalls maps a gesture onto the Playwright MCP tools Aperture hides
// from clients. from and to carry endpoints already resolved to viewport
// coordinates, as pointerCDPNeedsPoints asks; a scroll takes its wheel position
// from from when it has one. Motion does not apply: Playwright dispatches input
// events over CDP without a rendered cursor path.
func planPointerCDPCalls(spec pointerGestureSpec, from, to *pointer.Point) ([]playwrightCallRequest, error) {
	switch spec.Kind {
	case pointerGestureClick:
		return planPointerCDPClick(spec, from)
	case pointerGestureMove:
		return []playwrightCallRequest{pointerCDPMove(spec.From)}, nil
	case pointerGestureDrag:
		return planPointerCDPDrag(spec, from, to)
	case pointerGestureScroll:
		calls := make([]playwrightCallRequest, 0, 2)
		if from != nil {
			calls = append(calls, pointerCDPMove(pointerEndpoint{Point: from}))
		} else if !spec.From.isZero() {
			calls = append(calls, pointerCDPMove(spec.From))
		}
		return append(calls, playwrightCallRequest{
			Name:      "browser_mouse_wheel",
			Arguments: map[string]any{"deltaX": spec.ScrollX, "deltaY": spec.ScrollY},
		}), nil
	default:
		return nil, errors.New("unknown pointer gesture")
	}
}

func planPointerCDPClick(spec pointerGestureSpec, resolved *pointer.Point) ([]playwrightCallRequest, error) {
	point := spec.From.Point
	if resolved != nil {
		point = resolved
	}
	if point == nil {
		arguments := map[string]any{"target": spec.From.Target}
		if spec.From.Element != "" {
			arguments["element"] = spec.From.Element
		}
		if spec.Button != "left" {
			arguments["button"] = spec.Button
		}
		if len(spec.Modifiers) > 0 {
			arguments["modifiers"] = spec.Modifiers
		}
		if spec.ClickCount == 2 {
			arguments["doubleClick"] = true
		}
		return []playwrightCallRequest{{Name: "browser_click", Arguments: arguments}}, nil
	}
	if len(spec.Modifiers) > 0 {
		return nil, &pointerUserError{message: "modifiers need a ref target with a single or double click in sessions without a compositor"}
	}
	arguments := map[string]any{"x": point.X, "y": point.Y}
	if spec.Button != "left" {
		arguments["button"] = spec.Button
	}
	if spec.ClickCount > 1 {
		arguments["clickCount"] = spec.ClickCount
	}
	return []playwrightCallRequest{{Name: "browser_mouse_click_xy", Arguments: arguments}}, nil
}

func pointerCDPMove(endpoint pointerEndpoint) playwrightCallRequest {
	if endpoint.Point != nil {
		return playwrightCallRequest{Name: "browser_mouse_move_xy", Arguments: map[string]any{"x": endpoint.Point.X, "y": endpoint.Point.Y}}
	}
	arguments := map[string]any{"target": endpoint.Target}
	if endpoint.Element != "" {
		arguments["element"] = endpoint.Element
	}
	return playwrightCallRequest{Name: "browser_hover", Arguments: arguments}
}

func planPointerCDPDrag(spec pointerGestureSpec, from, to *pointer.Point) ([]playwrightCallRequest, error) {
	start, end := spec.From, spec.To
	if from != nil {
		start = pointerEndpoint{Point: from}
	}
	if to != nil {
		end = pointerEndpoint{Point: to}
	}
	switch {
	case start.Target != "" && end.Target != "":
		arguments := map[string]any{"startTarget": start.Target, "endTarget": end.Target}
		if start.Element != "" {
			arguments["startElement"] = start.Element
		}
		if end.Element != "" {
			arguments["endElement"] = end.Element
		}
		return []playwrightCallRequest{{Name: "browser_drag", Arguments: arguments}}, nil
	case start.Point != nil && end.Point != nil:
		return []playwrightCallRequest{{Name: "browser_mouse_drag_xy", Arguments: map[string]any{
			"startX": start.Point.X, "startY": start.Point.Y, "endX": end.Point.X, "endY": end.Point.Y,
		}}}, nil
	default:
		return nil, errors.New("drag endpoints must be resolved to the same kind")
	}
}

// pointerScrollContext is what a scroll learns about its page before sending
// the wheel: the CDP target, its compositor surface when the session has one,
// and its viewport. Each is optional; a scroll works without them.
type pointerScrollContext struct {
	targetID string
	target   *wrapperTargetSnapshot
	metrics  *pointerViewportMetrics
}

// runPointerScroll performs browser_scroll. Scrolling has no cursor to render,
// so it always goes through Playwright's mouse wheel over CDP, in compositor
// sessions too: Chromium scrolls the requested distance exactly and animates it
// itself. The page is still identified, when that is cheap, so the gesture's
// record names the recorded target and where the wheel turned; a page that
// cannot be identified only costs the record those two facts.
func (r *wrapperRuntime) runPointerScroll(ctx context.Context, registry *wrapperTargetRegistry, spec pointerGestureSpec) (*mcp.CallToolResult, error) {
	var scroll pointerScrollContext
	if targetID, err := r.identifyPointerTargetID(ctx); err == nil {
		scroll.targetID = targetID
		if registry != nil {
			if target, ready := registry.readyTarget(targetID); ready {
				scroll.target = &target
			}
		}
		// Not being able to read the viewport leaves coordinates as given.
		scroll.metrics, _ = r.pointerTargetViewportMetrics(ctx, targetID)
	} else if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if spec.From.isZero() && scroll.target != nil {
		// The wheel turns where the pointer last was on this page, as a person
		// scrolling without moving the mouse would; failing that, the center.
		// Without a compositor surface the pointer is Playwright's own mouse,
		// which already stays where the last gesture left it.
		if point := r.pointerScrollDefault(scroll); point != nil {
			spec.From = pointerEndpoint{Point: point}
		}
	}
	return r.runPointerGestureCDP(ctx, spec, &scroll)
}

// pointerScrollDefault is where a scroll without a position turns the wheel, in
// viewport CSS pixels; nil when the page's viewport is unknown, in which case
// Playwright's mouse position stands.
func (r *wrapperRuntime) pointerScrollDefault(scroll pointerScrollContext) *pointer.Point {
	if scroll.metrics == nil || scroll.metrics.Width <= 0 || scroll.metrics.Height <= 0 {
		return nil
	}
	if scroll.target != nil {
		if point, ok := r.pointer.position(scroll.target.SurfaceID); ok && scroll.target.Viewport.Width > 0 && scroll.target.Viewport.Height > 0 {
			zoomX := float64(scroll.target.Viewport.Width) / scroll.metrics.Width
			zoomY := float64(scroll.target.Viewport.Height) / scroll.metrics.Height
			return &pointer.Point{
				X: min(max(point.X/zoomX, 0), scroll.metrics.Width-1),
				Y: min(max(point.Y/zoomY, 0), scroll.metrics.Height-1),
			}
		}
	}
	return &pointer.Point{X: scroll.metrics.Width / 2, Y: scroll.metrics.Height / 2}
}

// runPointerGestureCDP performs a gesture through Playwright's own pointer
// tools, which it keeps for sessions without a compositor, for pages the
// compositor path cannot place a pointer on, and for scrolling. The result is
// the Playwright tool's, so clients see the same response either way. scroll is
// set for a scroll only.
func (r *wrapperRuntime) runPointerGestureCDP(ctx context.Context, spec pointerGestureSpec, scroll *pointerScrollContext) (*mcp.CallToolResult, error) {
	needFrom, needTo := pointerCDPNeedsPoints(spec)
	var from, to *pointer.Point
	var resolvedFrom *pointer.Point
	// Every ref endpoint goes through the same in-page actionability check the
	// compositor path uses, so timeoutMs is honored and a disabled or covered
	// element is reported the same way in both modes, instead of as Playwright's
	// own timeout after its fixed wait. The check also scrolls the element into
	// view. Where it cannot run (the page's CSP blocks evaluation, or the element
	// is somewhere it cannot place) the ref goes straight to Playwright, unless
	// the gesture needs the element's coordinates.
	for _, resolve := range []struct {
		needed   bool
		endpoint pointerEndpoint
		into     **pointer.Point
		resolved **pointer.Point
		enabled  bool
	}{
		{needFrom, spec.From, &from, &resolvedFrom, spec.Kind == pointerGestureClick || spec.Kind == pointerGestureDrag},
		{needTo, spec.To, &to, new(*pointer.Point), false},
	} {
		if !resolve.needed && resolve.endpoint.Target == "" {
			continue
		}
		resolved, err := r.resolvePointerElement(ctx, resolve.endpoint, resolve.enabled, false, spec.Timeout)
		if err != nil {
			if errors.Is(err, errPointerFallback) {
				if !resolve.needed {
					continue
				}
				return nil, &pointerUserError{message: "cannot combine " + resolve.endpoint.describe() + " with coordinates: " + err.Error()}
			}
			return nil, err
		}
		point := &pointer.Point{X: resolved.X, Y: resolved.Y}
		*resolve.resolved = point
		if resolve.needed {
			*resolve.into = point
		}
	}
	if scroll != nil {
		// A scroll turns the wheel where the element was found.
		from = resolvedFrom
	}
	calls, err := planPointerCDPCalls(spec, from, to)
	if err != nil {
		return nil, err
	}

	start := time.Now()
	var result *mcp.CallToolResult
	for _, call := range calls {
		result, err = r.callPlaywrightWithinTimeout(ctx, call, spec.Timeout)
		if err != nil {
			return nil, err
		}
		if result.IsError {
			return result, nil
		}
	}
	record := pointerGestureRecord{
		Kind:    spec.Kind,
		Tool:    spec.Tool,
		Mode:    pointerModeCDP,
		Start:   start,
		End:     time.Now(),
		Hold:    spec.Hold,
		ScrollX: spec.ScrollX,
		ScrollY: spec.ScrollY,
		Caption: spec.Caption,
	}
	if scroll != nil {
		record.TargetID = scroll.targetID
		record.Point = scroll.surfacePoint(resolvedFrom, spec.From)
	}
	r.pointer.record(record)
	if spec.Hold > 0 || scroll != nil {
		// The last call's page state predates the hold, and a scroll is still
		// animating when the wheel call returns; report the settled page.
		wait := spec.Hold
		if scroll != nil {
			wait = max(wait, pointerSettleDelay)
		}
		if err := sleepContext(ctx, wait); err != nil {
			return nil, err
		}
		return r.playwright.Call(ctx, "browser_snapshot", map[string]any{})
	}
	return result, nil
}

// callPlaywrightWithinTimeout makes one Playwright call. Playwright's pointer
// tools take no timeout parameter and wait on their own clock (about five
// seconds) for a ref target to be actionable, so timeoutMs is enforced here by
// bounding the call's context. Calls that only take coordinates have nothing to
// wait for and run unbounded. A call cut off this way makes the Playwright
// backend restart its session, which costs the next call some startup time.
func (r *wrapperRuntime) callPlaywrightWithinTimeout(ctx context.Context, call playwrightCallRequest, timeout time.Duration) (*mcp.CallToolResult, error) {
	if timeout <= 0 || !pointerCallWaitsForElement(call) {
		return r.playwright.Call(ctx, call.Name, call.Arguments)
	}
	callCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	result, err := r.playwright.Call(callCtx, call.Name, call.Arguments)
	if err != nil && ctx.Err() == nil && callCtx.Err() != nil {
		return nil, &pointerUserError{message: fmt.Sprintf("%s did not finish within %s (timeoutMs)", call.Name, timeout)}
	}
	return result, err
}

func pointerCallWaitsForElement(call playwrightCallRequest) bool {
	for _, key := range []string{"target", "startTarget", "endTarget"} {
		if _, ok := call.Arguments[key]; ok {
			return true
		}
	}
	return false
}

// surfacePoint is where a scroll's wheel turned, in surface pixels: the
// element's resolved position or the coordinates given, converted the way
// coordinates are for compositor input. It is nil when the session has no
// compositor surface for the page or the point cannot be placed on it.
func (c *pointerScrollContext) surfacePoint(resolved *pointer.Point, endpoint pointerEndpoint) *pointer.Point {
	if c.target == nil {
		return nil
	}
	css := resolved
	if css == nil {
		css = endpoint.Point
	}
	if css == nil {
		return nil
	}
	point, err := pointerSurfacePoint(*c.target, c.metrics, *css)
	if err != nil {
		return nil
	}
	return &point
}

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
// coordinates, as pointerCDPNeedsPoints asks. Motion does not apply: Playwright
// dispatches input events over CDP without a rendered cursor path.
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
		if !spec.From.isZero() {
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

// runPointerGestureCDP performs a gesture through Playwright's own pointer
// tools, which it keeps for sessions without a compositor and for pages the
// compositor path cannot place a pointer on. The result is the Playwright tool's,
// so clients see the same response either way.
func (r *wrapperRuntime) runPointerGestureCDP(ctx context.Context, spec pointerGestureSpec) (*mcp.CallToolResult, error) {
	needFrom, needTo := pointerCDPNeedsPoints(spec)
	var from, to *pointer.Point
	for _, resolve := range []struct {
		needed   bool
		endpoint pointerEndpoint
		into     **pointer.Point
		enabled  bool
	}{
		{needFrom, spec.From, &from, spec.Kind == pointerGestureClick || spec.Kind == pointerGestureDrag},
		{needTo, spec.To, &to, false},
	} {
		if !resolve.needed {
			continue
		}
		resolved, err := r.resolvePointerElement(ctx, resolve.endpoint, resolve.enabled, false, spec.Timeout)
		if err != nil {
			if errors.Is(err, errPointerFallback) {
				return nil, &pointerUserError{message: "cannot combine " + resolve.endpoint.describe() + " with coordinates: " + err.Error()}
			}
			return nil, err
		}
		*resolve.into = &pointer.Point{X: resolved.X, Y: resolved.Y}
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
	r.pointer.record(pointerGestureRecord{
		Kind:    spec.Kind,
		Tool:    spec.Tool,
		Mode:    pointerModeCDP,
		Start:   start,
		End:     time.Now(),
		Hold:    spec.Hold,
		ScrollX: spec.ScrollX,
		ScrollY: spec.ScrollY,
		Caption: spec.Caption,
	})
	if spec.Hold > 0 {
		// The last call's page state predates the hold; report the settled page.
		if err := sleepContext(ctx, spec.Hold); err != nil {
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

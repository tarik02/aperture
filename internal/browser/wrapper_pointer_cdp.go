package browser

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/aperture/aperture/internal/pointer"
	"github.com/chromedp/cdproto/runtime"
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
		return nil, &pointerUserError{message: "modifiers need a ref target with a single or double click when Playwright input is used"}
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
// and its viewport. Each is optional; a scroll works without them, and the zero
// value stands for a gesture that is not a scroll.
type pointerScrollContext struct {
	targetID string
	target   *wrapperTargetSnapshot
	metrics  *pointerViewportMetrics
}

// runPointerScroll performs browser_scroll. Scrolling has no cursor to render,
// so it always goes through Playwright's mouse wheel over CDP, in compositor
// sessions too: Chromium scrolls the requested distance exactly and animates it
// itself.
//
// Without a compositor registry there is no surface to place the wheel on or to
// record, so the page is only identified when that is free (a single page), to
// wait for the scroll to settle. With one, the page is identified so the
// gesture's record names its target and, when it has a surface, where the wheel
// turned. A page that cannot be identified only costs the record those facts.
func (r *wrapperRuntime) runPointerScroll(ctx context.Context, conn *pointerCDPConn, registry *wrapperTargetRegistry, spec pointerGestureSpec) (*mcp.CallToolResult, error) {
	var scroll pointerScrollContext
	targetID, err := r.identifyPointerTargetID(ctx, conn, registry != nil)
	if err != nil && ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if err == nil {
		scroll.targetID = targetID
	}
	if target, ready := scroll.readyTarget(registry); ready {
		scroll.target = &target
		// Not being able to read the viewport leaves coordinates as given.
		scroll.metrics, _ = r.pointerTargetViewportMetrics(ctx, conn, targetID)
	}
	if spec.From.isZero() {
		// The wheel turns where the pointer last was on this page, as a person
		// scrolling without moving the mouse would; failing that, the center.
		if point := r.pointerScrollDefault(scroll); point != nil {
			spec.From = pointerEndpoint{Point: point}
		}
	}
	return r.runPointerGestureCDP(ctx, conn, spec, scroll)
}

func (c pointerScrollContext) readyTarget(registry *wrapperTargetRegistry) (wrapperTargetSnapshot, bool) {
	if registry == nil || c.targetID == "" {
		return wrapperTargetSnapshot{}, false
	}
	return registry.readyTarget(c.targetID)
}

// pointerScrollDefault is where a scroll without a position turns the wheel, in
// viewport CSS pixels; nil when the page has no compositor surface or its
// viewport is unknown, in which case Playwright's mouse position stands.
func (r *wrapperRuntime) pointerScrollDefault(scroll pointerScrollContext) *pointer.Point {
	if scroll.target == nil || scroll.metrics == nil || scroll.metrics.Width <= 0 || scroll.metrics.Height <= 0 {
		return nil
	}
	if point, ok := r.pointer.position(scroll.target.SurfaceID); ok && scroll.target.Viewport.Width > 0 && scroll.target.Viewport.Height > 0 {
		zoomX := float64(scroll.target.Viewport.Width) / scroll.metrics.Width
		zoomY := float64(scroll.target.Viewport.Height) / scroll.metrics.Height
		return &pointer.Point{
			X: min(max(point.X/zoomX, 0), scroll.metrics.Width-1),
			Y: min(max(point.Y/zoomY, 0), scroll.metrics.Height-1),
		}
	}
	return &pointer.Point{X: scroll.metrics.Width / 2, Y: scroll.metrics.Height / 2}
}

// pointerCDPPoints are the viewport coordinates a gesture's ref endpoints
// resolved to. from and to are what Playwright is given in place of a ref; wheel
// is where a scroll found its element, used for the record.
type pointerCDPPoints struct {
	from, to *pointer.Point
	wheel    *pointer.Point
}

// runPointerGestureCDP performs a gesture through Playwright's own pointer
// tools, which Aperture uses for sessions without a compositor, for pages the
// compositor path cannot place a pointer on, and for scrolling. The result is
// the Playwright tool's, so clients see the same response either way. page is
// what a scroll learned about its page and is zero for other gestures.
func (r *wrapperRuntime) runPointerGestureCDP(ctx context.Context, conn *pointerCDPConn, spec pointerGestureSpec, page pointerScrollContext) (*mcp.CallToolResult, error) {
	points, err := r.resolvePointerCDPPoints(ctx, spec)
	if err != nil {
		return nil, err
	}
	from := points.from
	if spec.Kind == pointerGestureScroll {
		// A scroll turns the wheel where the element was found.
		from = points.wheel
	}
	calls, err := planPointerCDPCalls(spec, from, points.to)
	if err != nil {
		return nil, err
	}
	result, start, err := r.executePointerCDPCalls(ctx, calls, spec.Timeout)
	if err != nil {
		return nil, err
	}
	if result.IsError {
		return result, nil
	}
	r.pointer.record(pointerCDPRecord(spec, page, points.wheel, start, time.Now()))

	if spec.Kind == pointerGestureScroll {
		// The wheel call returns while the scroll is still animating.
		r.waitForPointerScrollSettle(ctx, conn, page.targetID)
	}
	if spec.Hold > 0 || spec.Kind == pointerGestureScroll {
		// The last call's page state predates the hold and the scroll; report the
		// settled page.
		if err := sleepContext(ctx, spec.Hold); err != nil {
			return nil, err
		}
		return r.playwright.Call(ctx, "browser_snapshot", map[string]any{})
	}
	return result, nil
}

// resolvePointerCDPPoints runs every ref endpoint of the gesture through the
// same in-page actionability check the compositor path uses, so timeoutMs is
// honored and a disabled or covered element is reported the same way in both
// modes, instead of as Playwright's own timeout after its fixed wait. The check
// also scrolls the element into view. Where it cannot run (the page's CSP blocks
// evaluation, or the element is somewhere it cannot place) the ref goes straight
// to Playwright, unless the gesture needs the element's coordinates.
func (r *wrapperRuntime) resolvePointerCDPPoints(ctx context.Context, spec pointerGestureSpec) (pointerCDPPoints, error) {
	needFrom, needTo := pointerCDPNeedsPoints(spec)
	var points pointerCDPPoints
	resolved, err := r.resolvePointerCDPEndpoint(ctx, spec, spec.From, false)
	if err != nil {
		return points, err
	}
	points.wheel = resolved
	if needFrom {
		points.from = resolved
	}
	resolved, err = r.resolvePointerCDPEndpoint(ctx, spec, spec.To, true)
	if err != nil {
		return points, err
	}
	if needTo {
		points.to = resolved
	}
	return points, nil
}

// resolvePointerCDPEndpoint resolves one ref endpoint to viewport coordinates.
// It returns nil for an endpoint that is not a ref, or a ref that Playwright can
// take on its own after the resolver could not place it.
func (r *wrapperRuntime) resolvePointerCDPEndpoint(ctx context.Context, spec pointerGestureSpec, endpoint pointerEndpoint, isTo bool) (*pointer.Point, error) {
	if endpoint.Target == "" {
		return nil, nil
	}
	requireEnabled := !isTo && (spec.Kind == pointerGestureClick || spec.Kind == pointerGestureDrag)
	resolved, err := r.resolvePointerElement(ctx, endpoint, requireEnabled, false, spec.Timeout)
	if errors.Is(err, errPointerFallback) {
		return nil, pointerCDPUnresolvedRef(spec, isTo, err)
	}
	if err != nil {
		return nil, err
	}
	return &pointer.Point{X: resolved.X, Y: resolved.Y}, nil
}

// pointerCDPUnresolvedRef decides what a ref endpoint that compositor-free
// resolution could not place means for the gesture. It is nil when Playwright
// can act on the ref itself, and an error the caller can act on when the gesture
// needs the ref's coordinates (see pointerCDPNeedsPoints). cause says why the
// element could not be placed.
func pointerCDPUnresolvedRef(spec pointerGestureSpec, isTo bool, cause error) error {
	needFrom, needTo := pointerCDPNeedsPoints(spec)
	needed, endpoint := needFrom, spec.From
	if isTo {
		needed, endpoint = needTo, spec.To
	}
	if !needed {
		return nil
	}
	reason := strings.TrimPrefix(cause.Error(), errPointerFallback.Error()+": ")
	if spec.Kind == pointerGestureClick {
		return &pointerUserError{message: fmt.Sprintf("a click count of %d on %s needs the element's position, which cannot be determined here (%s); click at coordinates instead", spec.ClickCount, endpoint.describe(), reason)}
	}
	return &pointerUserError{message: fmt.Sprintf("dragging between a ref and coordinates needs the position of %s, which cannot be determined here (%s); use coordinates or refs for both ends", endpoint.describe(), reason)}
}

// executePointerCDPCalls makes the calls in order and returns the last result,
// or the first failing one, with the time the first call started.
func (r *wrapperRuntime) executePointerCDPCalls(ctx context.Context, calls []playwrightCallRequest, timeout time.Duration) (*mcp.CallToolResult, time.Time, error) {
	start := time.Now()
	var result *mcp.CallToolResult
	for _, call := range calls {
		var err error
		result, err = r.callPlaywrightWithinTimeout(ctx, call, timeout)
		if err != nil {
			return nil, start, err
		}
		if result.IsError {
			break
		}
	}
	return result, start, nil
}

// pointerCDPRecord describes a finished Playwright-input gesture. Start and End
// are the times around the gesture's calls, Hold is the caller's extra wait and
// Caption the caller's text; the Phase 2 recording timeline uses them to time
// captions and cursor effects. Playwright input has no cursor path or motion. A
// scroll also names the page and, when the page has a compositor surface, where
// the wheel turned.
func pointerCDPRecord(spec pointerGestureSpec, page pointerScrollContext, wheel *pointer.Point, start, end time.Time) pointerGestureRecord {
	record := pointerGestureRecord{
		Kind:    spec.Kind,
		Tool:    spec.Tool,
		Mode:    pointerModeCDP,
		Start:   start,
		End:     end,
		Hold:    spec.Hold,
		ScrollX: spec.ScrollX,
		ScrollY: spec.ScrollY,
		Caption: spec.Caption,
		Zoom:    spec.Zoom,
		Ripple:  spec.Ripple,
	}
	if spec.Kind == pointerGestureScroll {
		record.TargetID = page.targetID
		record.Point = page.surfacePoint(wheel, spec.From)
	}
	return record
}

// pointerScrollSettleScript resolves when the scroll positions of the window and
// of every scrollable element have stopped changing for a few animation frames,
// or after a second. Chromium animates wheel scrolling on its own clock, so the
// position after the wheel call returns is not the final one. A frame that never
// arrives (a hidden page) is replaced by a timer.
const pointerScrollSettleScript = `(async () => {
  const scrollers = [];
  for (const element of document.querySelectorAll('*')) {
    if (scrollers.length >= 256) break;
    if (element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth) scrollers.push(element);
  }
  const sample = () => [window.scrollX, window.scrollY, ...scrollers.flatMap((element) => [element.scrollLeft, element.scrollTop])].join(',');
  const nextFrame = () => new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(finish);
    setTimeout(finish, 50);
  });
  const started = performance.now();
  let previous = sample(), unchanged = 0;
  while (performance.now() - started < 1000) {
    await nextFrame();
    const current = sample();
    if (current !== previous) { previous = current; unchanged = 0; continue; }
    if (++unchanged >= 4 && performance.now() - started >= 100) return true;
  }
  return false;
})()`

// waitForPointerScrollSettle waits until the page's scroll offsets stop moving
// after a wheel, over the gesture's CDP connection (Runtime.evaluate is not
// blocked by the page's Content Security Policy). When the page is unknown or
// cannot be read it waits pointerSettleDelay instead. It never fails the
// gesture: a cancelled context is left for the caller's next step to report.
func (r *wrapperRuntime) waitForPointerScrollSettle(ctx context.Context, conn *pointerCDPConn, targetID string) {
	if targetID != "" {
		settleCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()
		if client, sessionID, err := conn.attach(settleCtx, targetID); err == nil {
			_, exception, err := runtime.Evaluate(pointerScrollSettleScript).WithAwaitPromise(true).WithReturnByValue(true).Do(client.executorContext(settleCtx, sessionID))
			if err == nil && exception == nil {
				return
			}
		}
	}
	_ = sleepContext(ctx, pointerSettleDelay)
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

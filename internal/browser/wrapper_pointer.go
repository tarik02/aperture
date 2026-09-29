package browser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/aperture/aperture/internal/pointer"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const (
	pointerCallRequestMaxBytes = 1 << 20
	// pointerSettleDelay is how long the page gets to react to a compositor
	// gesture, or a scroll whose offsets cannot be read, before its state is read.
	pointerSettleDelay = 150 * time.Millisecond
)

type pointerCallRequest struct {
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

// handlePointerCall runs one of Aperture's pointer tools. Like
// /automation/playwright it is control-authorized, and the daemon calls it
// while holding the automation lease.
func (r *wrapperRuntime) handlePointerCall(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if !r.wrapperControlAuthorized(req) {
		writeWrapperError(w, http.StatusUnauthorized, "wrapper control token required")
		return
	}
	if r.playwright == nil {
		writeWrapperError(w, http.StatusServiceUnavailable, "Playwright MCP is unavailable")
		return
	}

	req.Body = http.MaxBytesReader(w, req.Body, pointerCallRequestMaxBytes)
	var call pointerCallRequest
	decoder := json.NewDecoder(req.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&call); err != nil {
		writeWrapperError(w, http.StatusBadRequest, "invalid pointer call")
		return
	}
	spec, err := parsePointerGesture(call.Name, call.Arguments)
	if err != nil {
		writeWrapperError(w, http.StatusBadRequest, err.Error())
		return
	}

	result, err := r.runPointerGesture(req.Context(), spec)
	var userErr *pointerUserError
	if errors.As(err, &userErr) {
		failure := &mcp.CallToolResult{}
		failure.SetError(userErr)
		writeWrapperJSON(w, http.StatusOK, failure)
		return
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "browser-session-wrapper: pointer tool %s failed: %v\n", call.Name, err)
		writeWrapperError(w, http.StatusBadGateway, fmt.Sprintf("pointer gesture failed: %v", err))
		return
	}
	writeWrapperJSON(w, http.StatusOK, result)
}

// runPointerGesture performs a gesture as compositor input when the session has
// a compositor surface for the page Playwright controls, and through
// Playwright's own tools otherwise.
func (r *wrapperRuntime) runPointerGesture(ctx context.Context, spec pointerGestureSpec) (*mcp.CallToolResult, error) {
	r.mu.Lock()
	registry := r.targets
	r.mu.Unlock()
	conn := &pointerCDPConn{port: r.values.CDPPort}
	defer conn.close()
	if spec.Kind == pointerGestureScroll {
		return r.runPointerScroll(ctx, conn, registry, spec)
	}
	if registry == nil {
		return r.runPointerGestureCDP(ctx, conn, spec, pointerScrollContext{})
	}
	result, err := r.runPointerGestureCompositor(ctx, conn, registry, spec)
	if errors.Is(err, errPointerFallback) {
		// Fallback errors are only raised while locating the page and the elements,
		// before any input is sent, so the Playwright path never repeats a gesture.
		fmt.Fprintf(os.Stderr, "browser-session-wrapper: pointer tool %s uses Playwright input: %v\n", spec.Tool, err)
		return r.runPointerGestureCDP(ctx, conn, spec, pointerScrollContext{})
	}
	return result, err
}

func (r *wrapperRuntime) runPointerGestureCompositor(ctx context.Context, conn *pointerCDPConn, registry *wrapperTargetRegistry, spec pointerGestureSpec) (*mcp.CallToolResult, error) {
	target, err := r.identifyPointerTarget(ctx, conn, registry)
	if err != nil {
		return nil, err
	}
	var from, to pointer.Point
	switch spec.Kind {
	case pointerGestureDrag:
		from, to, err = resolvePointerDragEndpoints(spec, func(endpoint pointerEndpoint, requireEnabled, verify bool) (pointer.Point, error) {
			return r.resolvePointerEndpoint(ctx, conn, target, endpoint, requireEnabled, verify, spec.Timeout)
		})
	default:
		from, err = r.resolvePointerEndpoint(ctx, conn, target, spec.From, spec.Kind == pointerGestureClick, false, spec.Timeout)
	}
	if err != nil {
		return nil, err
	}

	motion := r.resolvePointerMotion(spec, target.TargetID)
	compositor := newCompositorPointer(r, target, motion)
	record := pointerGestureRecord{
		Kind:     spec.Kind,
		Tool:     spec.Tool,
		Mode:     pointerModeCompositor,
		TargetID: target.TargetID,
		Hold:     spec.Hold,
		Motion:   motion,
		Caption:  spec.Caption,
		Zoom:     spec.Zoom,
		Ripple:   spec.Ripple,
	}
	var summary string
	record.Start = time.Now()
	compositor.begin()
	switch spec.Kind {
	case pointerGestureClick:
		err = compositor.click(ctx, from, spec.Button, spec.ClickCount, spec.Modifiers)
		summary = pointerClickSummary(spec, from)
	case pointerGestureMove:
		if err = compositor.glide(ctx, from); err == nil {
			err = compositor.dwell(ctx)
		}
		summary = fmt.Sprintf("Moved the pointer to %s at %s", spec.From.describe(), formatPoint(from))
	case pointerGestureDrag:
		err = compositor.drag(ctx, from, to)
		summary = fmt.Sprintf("Dragged from %s at %s to %s at %s", spec.From.describe(), formatPoint(from), spec.To.describe(), formatPoint(to))
	}
	if err != nil {
		return nil, err
	}
	record.End = time.Now()
	record.Path = compositor.path
	record.Clicks = compositor.clicks
	r.pointer.record(record)

	if err := sleepContext(ctx, max(spec.Hold, pointerSettleDelay)); err != nil {
		return nil, err
	}
	return r.pointerResult(ctx, summary), nil
}

// pointerEndpointResolver resolves one endpoint to surface coordinates.
// verify asks for a check of where the element is now, without scrolling.
type pointerEndpointResolver func(endpoint pointerEndpoint, requireEnabled, verify bool) (pointer.Point, error)

// pointerDragVerifyTimeout bounds the check that a drag's end is still where it
// was found; that check never scrolls, so it has nothing to wait for.
const pointerDragVerifyTimeout = time.Second

// resolvePointerDragEndpoints resolves both ends of a drag.
//
// Resolving a ref scrolls it into view, which can move the other end. So the end
// is resolved first, then the start (whose scroll may invalidate the end), and
// then, when both are refs, the end is looked up again without scrolling and its
// fresh position is used. The start needs no second look: nothing scrolls after
// it is found. If the start's scroll pushed the end out of view, the two are
// not visible together and the drag fails with an error saying so; the caller
// can scroll so both fit, or drag between coordinates. That is preferred over
// falling back to Playwright's drag, which scrolls each ref into view in turn
// and would hit the same problem.
func resolvePointerDragEndpoints(spec pointerGestureSpec, resolve pointerEndpointResolver) (from, to pointer.Point, err error) {
	to, err = resolve(spec.To, false, false)
	if err != nil {
		return from, to, err
	}
	from, err = resolve(spec.From, true, false)
	if err != nil {
		return from, to, err
	}
	if spec.From.Target != "" && spec.To.Target != "" {
		to, err = resolve(spec.To, false, true)
		if err != nil {
			var userErr *pointerUserError
			if errors.As(err, &userErr) {
				return from, to, &pointerUserError{message: fmt.Sprintf("%s and %s are not visible at the same time (%s); scroll so both are in view, or drag between coordinates", spec.From.describe(), spec.To.describe(), userErr.message)}
			}
			return from, to, err
		}
	}
	return from, to, nil
}

// resolvePointerEndpoint returns the surface coordinates of an endpoint. With
// verify it only looks the element up where it is now, briefly and without
// scrolling.
func (r *wrapperRuntime) resolvePointerEndpoint(ctx context.Context, conn *pointerCDPConn, target wrapperTargetSnapshot, endpoint pointerEndpoint, requireEnabled, verify bool, timeout time.Duration) (pointer.Point, error) {
	if endpoint.Point != nil {
		metrics, err := r.pointerTargetViewportMetrics(ctx, conn, target.TargetID)
		if err != nil {
			return pointer.Point{}, err
		}
		return pointerSurfacePoint(target, metrics, *endpoint.Point)
	}
	if verify {
		timeout = min(timeout, pointerDragVerifyTimeout)
	}
	resolved, err := r.resolvePointerElement(ctx, endpoint, requireEnabled, verify, timeout)
	if err != nil {
		return pointer.Point{}, err
	}
	return pointerSurfacePoint(target, &resolved.Viewport, pointer.Point{X: resolved.X, Y: resolved.Y})
}

func pointerClickSummary(spec pointerGestureSpec, at pointer.Point) string {
	verb := map[int]string{1: "Clicked", 2: "Double-clicked", 3: "Triple-clicked"}[spec.ClickCount]
	text := fmt.Sprintf("%s %s with the %s button at %s", verb, spec.From.describe(), spec.Button, formatPoint(at))
	if len(spec.Modifiers) > 0 {
		text += " holding " + strings.Join(spec.Modifiers, "+")
	}
	return text
}

func formatPoint(point pointer.Point) string {
	return fmt.Sprintf("(%s, %s)", formatCoordinate(point.X), formatCoordinate(point.Y))
}

// pointerResult reports a finished gesture the way Playwright's own pointer
// tools do: what happened, then the page state and accessibility snapshot, so a
// client can carry on from it directly.
func (r *wrapperRuntime) pointerResult(ctx context.Context, summary string) *mcp.CallToolResult {
	text := "### Result\n- " + summary
	snapshot, err := r.playwright.Call(ctx, "browser_snapshot", map[string]any{})
	if err != nil {
		text += fmt.Sprintf("\n### Page\n- The page snapshot is unavailable: %v", err)
	} else if state := playwrightResultText(snapshot); state != "" {
		// A pending dialog or file chooser makes Playwright answer with its modal
		// state instead of a snapshot; that is still the state the client needs.
		text += "\n" + state
	}
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: text}}}
}

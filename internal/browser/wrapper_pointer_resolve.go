package browser

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/aperture/aperture/internal/pointer"
	"github.com/chromedp/cdproto/runtime"
	cdptarget "github.com/chromedp/cdproto/target"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// pointerMarkerKey names the symbol under which a probe leaves its nonce on the
// window of the page Playwright controls. A symbol keeps the marker out of
// ordinary property enumeration.
const pointerMarkerKey = "aperture.pointer.marker"

// errPointerFallback means the gesture cannot be produced by compositor input
// and must go through Playwright instead. Its message says why.
var errPointerFallback = errors.New("compositor pointer input is unavailable")

func pointerFallback(format string, args ...any) error {
	return fmt.Errorf("%w: %s", errPointerFallback, fmt.Sprintf(format, args...))
}

// pointerUserError is a failure the caller can act on: it becomes an error
// result of the tool rather than a wrapper failure.
type pointerUserError struct {
	message string
}

func (e *pointerUserError) Error() string {
	return e.message
}

// playwrightToolError is an error result returned by a Playwright MCP tool.
type playwrightToolError struct {
	tool string
	text string
}

func (e *playwrightToolError) Error() string {
	return fmt.Sprintf("playwright %s failed: %s", e.tool, e.text)
}

// blockedByPageCSP reports whether the page's Content Security Policy refused
// the string evaluation browser_evaluate relies on.
func (e *playwrightToolError) blockedByPageCSP() bool {
	return strings.Contains(e.text, "unsafe-eval") || strings.Contains(e.text, "Content Security Policy")
}

// pointerViewportMetrics are the page's own viewport measurements in CSS pixels.
type pointerViewportMetrics struct {
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
	// Scale is the visual viewport's pinch-zoom scale; 1 unless the page is zoomed.
	Scale float64 `json:"scale"`
}

type pointerBox struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

// pointerElementResult is what the in-page resolver reports for one element.
type pointerElementResult struct {
	Status   string                 `json:"status"`
	Reason   string                 `json:"reason"`
	X        float64                `json:"x"`
	Y        float64                `json:"y"`
	Box      pointerBox             `json:"box"`
	Viewport pointerViewportMetrics `json:"viewport"`
}

type pointerResolveOptions struct {
	TimeoutMs     int64 `json:"timeoutMs"`
	RequireEnable bool  `json:"requireEnabled"`
}

// pointerResolveScript runs on the element with the given snapshot ref. It
// scrolls the element into view, waits until it is actionable, and reports its
// click point in the top-level viewport's CSS pixels. Actionable means visible,
// stable across two animation frames, not disabled (when required), and the
// topmost element at its center, looking through same-origin frames and open
// shadow roots. An element inside a frame whose offset cannot be computed is
// reported as unsupported rather than guessed at.
const pointerResolveScript = `async (element) => {
  const options = __OPTIONS__;
  const nextFrame = () => new Promise((resolve) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    requestAnimationFrame(finish);
    setTimeout(finish, 100);
  });
  const frameOffsets = (el) => {
    const view = el.ownerDocument.defaultView;
    if (!view) return { unsupported: 'element is detached from its document' };
    let win = view, x = 0, y = 0;
    while (win !== win.top) {
      let host = null;
      try { host = win.frameElement; } catch (error) { host = null; }
      if (!host) return { unsupported: 'element is inside a cross-origin frame' };
      const rect = host.getBoundingClientRect();
      if (Math.abs(rect.width - host.offsetWidth) > 1 || Math.abs(rect.height - host.offsetHeight) > 1) {
        return { unsupported: 'element is inside a scaled or rotated frame' };
      }
      const style = win.parent.getComputedStyle(host);
      x += rect.left + host.clientLeft + (parseFloat(style.paddingLeft) || 0);
      y += rect.top + host.clientTop + (parseFloat(style.paddingTop) || 0);
      win = win.parent;
    }
    return { x, y, top: win };
  };
  const describe = (node) => {
    if (!node || !node.tagName) return 'another element';
    let text = node.tagName.toLowerCase();
    if (node.id) text += '#' + node.id;
    else if (typeof node.className === 'string' && node.className.trim()) text += '.' + node.className.trim().split(/\s+/)[0];
    return '<' + text + '>';
  };
  const elementAt = (doc, x, y) => {
    let hit = doc.elementFromPoint(x, y);
    while (hit && hit.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  };
  const hitTest = (topWindow, x, y) => {
    let doc = topWindow.document;
    for (let depth = 0; depth < 16; depth++) {
      const hit = elementAt(doc, x, y);
      if (!hit || hit === element || !/^(IFRAME|FRAME)$/.test(hit.tagName)) return hit;
      let inner = null;
      try { inner = hit.contentDocument; } catch (error) { inner = null; }
      if (!inner) return hit;
      const rect = hit.getBoundingClientRect();
      const style = hit.ownerDocument.defaultView.getComputedStyle(hit);
      x -= rect.left + hit.clientLeft + (parseFloat(style.paddingLeft) || 0);
      y -= rect.top + hit.clientTop + (parseFloat(style.paddingTop) || 0);
      doc = inner;
    }
    return null;
  };
  const isElementOrDescendant = (node) => {
    for (let current = node; current; current = current.parentNode || current.host) {
      if (current === element) return true;
    }
    return false;
  };
  const disabledReason = () => {
    if (element.closest('[inert]')) return 'inside an inert subtree';
    if (element.closest('button:disabled, input:disabled, select:disabled, textarea:disabled, fieldset:disabled, optgroup:disabled, option:disabled')) return 'disabled';
    for (let node = element; node; node = node.parentElement) {
      if (node.getAttribute('aria-disabled') === 'true') return 'marked aria-disabled';
    }
    return null;
  };
  const alignments = ['center', 'end', 'start', 'nearest'];
  // Retrying with another alignment gets past sticky headers; spacing the
  // attempts out keeps a page with a persistent overlay from jittering.
  let lastScroll = -Infinity, scrolls = 0;
  const scrollIntoView = () => {
    if (performance.now() - lastScroll < 250) return;
    lastScroll = performance.now();
    element.scrollIntoView({ block: alignments[scrolls++ % alignments.length], inline: 'center', behavior: 'instant' });
  };
  const deadline = performance.now() + options.timeoutMs;
  let previous = '', stable = 0, failure = 'element is not visible';
  for (;;) {
    const offsets = frameOffsets(element);
    if (offsets.unsupported) return { status: 'unsupported', reason: offsets.unsupported };
    const topWindow = offsets.top;
    let rect = null;
    for (const candidate of element.getClientRects()) {
      if (candidate.width > 0 && candidate.height > 0) { rect = candidate; break; }
    }
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    if (!element.isConnected) {
      failure = 'element is detached from the document';
    } else if (!rect || style.visibility === 'hidden' || style.visibility === 'collapse') {
      failure = 'element is not visible';
    } else {
      const box = { x: rect.left + offsets.x, y: rect.top + offsets.y, width: rect.width, height: rect.height };
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      const root = topWindow.document.documentElement;
      if (point.x < 0 || point.y < 0 || point.x >= root.clientWidth || point.y >= root.clientHeight) {
        failure = 'element is outside the viewport';
        scrollIntoView();
      } else {
        const key = [box.x, box.y, box.width, box.height].map((value) => Math.round(value * 4)).join(',');
        stable = key === previous ? stable + 1 : 0;
        previous = key;
        const disabled = options.requireEnabled ? disabledReason() : null;
        if (stable < 2) {
          failure = 'element is still moving';
        } else if (disabled) {
          failure = 'element is ' + disabled;
        } else {
          const hit = hitTest(topWindow, point.x, point.y);
          if (hit && isElementOrDescendant(hit)) {
            const visual = topWindow.visualViewport;
            return {
              status: 'ok', x: point.x, y: point.y, box,
              viewport: { width: topWindow.innerWidth, height: topWindow.innerHeight, scale: visual ? visual.scale : 1 },
            };
          }
          failure = style.pointerEvents === 'none' ? 'element has pointer-events: none' : 'element is covered by ' + describe(hit);
          scrollIntoView();
        }
      }
    }
    if (performance.now() >= deadline) return { status: 'timeout', reason: failure };
    await nextFrame();
  }
}`

// pointerProbeScript leaves a nonce on the window of the page Playwright
// currently controls.
func pointerProbeScript(nonce string) string {
	encoded, _ := json.Marshal(nonce)
	return fmt.Sprintf(`() => { window[Symbol.for(%q)] = %s; return true; }`, pointerMarkerKey, encoded)
}

func pointerResolveFunction(options pointerResolveOptions) string {
	encoded, _ := json.Marshal(options)
	return strings.Replace(pointerResolveScript, "__OPTIONS__", string(encoded), 1)
}

// evaluatePlaywright runs browser_evaluate on the page, or on the element with
// the given ref, and decodes the JSON value the function returned.
func (r *wrapperRuntime) evaluatePlaywright(ctx context.Context, function, target string, destination any) error {
	arguments := map[string]any{"function": function}
	if target != "" {
		arguments["target"] = target
	}
	result, err := r.playwright.Call(ctx, "browser_evaluate", arguments)
	if err != nil {
		return err
	}
	text := playwrightResultText(result)
	if result.IsError {
		return &playwrightToolError{tool: "browser_evaluate", text: text}
	}
	value, ok := playwrightResultSection(text, "Result")
	if !ok {
		return errors.New("playwright browser_evaluate returned no result")
	}
	if err := json.Unmarshal([]byte(value), destination); err != nil {
		return fmt.Errorf("decode playwright browser_evaluate result: %w", err)
	}
	return nil
}

func playwrightResultText(result *mcp.CallToolResult) string {
	var text strings.Builder
	for _, content := range result.Content {
		if block, ok := content.(*mcp.TextContent); ok {
			if text.Len() > 0 {
				text.WriteByte('\n')
			}
			text.WriteString(block.Text)
		}
	}
	return text.String()
}

// playwrightResultSection returns the body of a "### Title" section of a
// Playwright MCP response.
func playwrightResultSection(text, title string) (string, bool) {
	heading := "### " + title + "\n"
	start := strings.Index(text, heading)
	if start < 0 {
		return "", false
	}
	body := text[start+len(heading):]
	if end := strings.Index(body, "\n### "); end >= 0 {
		body = body[:end]
	}
	return strings.TrimSpace(body), true
}

// resolvePointerElement waits for the element to be actionable and returns its
// click point. A tool failure that is not about the page's CSP is the caller's
// to see; CSP blocks and elements the resolver cannot place fall back.
func (r *wrapperRuntime) resolvePointerElement(ctx context.Context, endpoint pointerEndpoint, requireEnabled bool, timeout time.Duration) (pointerElementResult, error) {
	var result pointerElementResult
	function := pointerResolveFunction(pointerResolveOptions{TimeoutMs: timeout.Milliseconds(), RequireEnable: requireEnabled})
	if err := r.evaluatePlaywright(ctx, function, endpoint.Target, &result); err != nil {
		var toolErr *playwrightToolError
		if errors.As(err, &toolErr) {
			if toolErr.blockedByPageCSP() {
				return result, pointerFallback("the page's Content Security Policy blocks element resolution")
			}
			return result, &pointerUserError{message: toolErr.text}
		}
		return result, err
	}
	switch result.Status {
	case "ok":
		return result, nil
	case "unsupported":
		return result, pointerFallback("%s", result.Reason)
	case "timeout":
		return result, &pointerUserError{message: fmt.Sprintf("%s is not actionable after %s: %s", endpoint.describe(), timeout, result.Reason)}
	default:
		return result, fmt.Errorf("unexpected element resolution status %q", result.Status)
	}
}

// identifyPointerTarget finds the registry target whose page Playwright's
// current tab is.
//
// Playwright keeps its own notion of the current page and exposes nothing that
// ties it to a CDP target ID, which is what the registry is keyed by. Three
// facts make the match robust:
//
//   - With exactly one user page in the browser it is the current page, so no
//     Playwright call is needed. This is the common case.
//   - Otherwise a probe through browser_evaluate leaves a fresh nonce on the
//     current page's window, and reading that nonce back over CDP from each
//     candidate target names the page unambiguously. It cannot confuse two
//     pages that share a URL or title.
//   - If the page cannot be identified (its CSP blocks evaluation, or the marker
//     is found nowhere or on a target that is not ready), the gesture falls back
//     to Playwright input instead of guessing a surface.
func (r *wrapperRuntime) identifyPointerTarget(ctx context.Context, registry *wrapperTargetRegistry) (wrapperTargetSnapshot, error) {
	pages, err := discoverCDPTargetWindows(ctx, r.values.CDPPort)
	if err != nil {
		return wrapperTargetSnapshot{}, err
	}
	targetIDs := make([]string, 0, len(pages))
	for _, page := range pages {
		targetIDs = append(targetIDs, string(page.Target.TargetID))
	}
	var targetID string
	switch len(targetIDs) {
	case 0:
		return wrapperTargetSnapshot{}, pointerFallback("the browser has no page")
	case 1:
		targetID = targetIDs[0]
	default:
		nonce, err := randomPointerNonce()
		if err != nil {
			return wrapperTargetSnapshot{}, err
		}
		var probed bool
		if err := r.evaluatePlaywright(ctx, pointerProbeScript(nonce), "", &probed); err != nil {
			var toolErr *playwrightToolError
			if errors.As(err, &toolErr) && !toolErr.blockedByPageCSP() {
				return wrapperTargetSnapshot{}, &pointerUserError{message: toolErr.text}
			}
			return wrapperTargetSnapshot{}, pointerFallback("the current page cannot be identified among %d pages", len(targetIDs))
		}
		targetID, err = r.findPointerMarker(ctx, targetIDs, nonce)
		if err != nil {
			return wrapperTargetSnapshot{}, err
		}
	}
	target, ready := registry.readyTarget(targetID)
	if !ready {
		return wrapperTargetSnapshot{}, pointerFallback("the current page has no ready compositor surface")
	}
	return target, nil
}

func randomPointerNonce() (string, error) {
	buffer := make([]byte, 12)
	if _, err := rand.Read(buffer); err != nil {
		return "", fmt.Errorf("generate pointer probe nonce: %w", err)
	}
	return hex.EncodeToString(buffer), nil
}

// findPointerMarker returns the one target whose window carries the nonce.
func (r *wrapperRuntime) findPointerMarker(ctx context.Context, targetIDs []string, nonce string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	client, err := connectLiveSessionCDP(ctx, r.values.CDPPort)
	if err != nil {
		return "", err
	}
	defer client.close()
	expression := fmt.Sprintf("window[Symbol.for(%q)]", pointerMarkerKey)
	var matches []string
	for _, targetID := range targetIDs {
		sessionID, err := cdptarget.AttachToTarget(cdptarget.ID(targetID)).WithFlatten(true).Do(client.executorContext(ctx, ""))
		if err != nil {
			// The page may have closed since discovery; it cannot be the current one.
			continue
		}
		value, _, evaluateErr := runtime.Evaluate(expression).WithReturnByValue(true).Do(client.executorContext(ctx, sessionID))
		_ = cdptarget.DetachFromTarget().WithSessionID(sessionID).Do(client.executorContext(ctx, ""))
		if evaluateErr != nil || value == nil {
			continue
		}
		var marker string
		if json.Unmarshal(value.Value, &marker) == nil && marker == nonce {
			matches = append(matches, targetID)
		}
	}
	if len(matches) != 1 {
		return "", pointerFallback("the current page matched %d of %d browser targets", len(matches), len(targetIDs))
	}
	return matches[0], nil
}

// pointerSurfacePoint converts a point in the page's viewport CSS pixels to the
// surface coordinates the compositor's motion command takes.
//
// The compositor surface is the Chromium window's content area, sized in
// logical pixels (target.Viewport.Width x Height); the surface scale
// (DPR = ScaleNumerator/120) is applied by the compositor when it maps surface
// coordinates to output pixels. A page at default zoom lays out one CSS pixel
// per logical pixel, so the conversion is an identity: multiplying by the device
// pixel ratio here would double-apply the scale. What can differ is the extent.
// A Playwright viewport emulation may make the page narrower than the surface,
// and a pinch-zoomed page no longer maps CSS pixels one to one, so the point
// must lie inside both, and pinch-zoomed pages are refused (the caller falls
// back). metrics may be nil when the page reported none.
func pointerSurfacePoint(target wrapperTargetSnapshot, metrics *pointerViewportMetrics, point pointer.Point) (pointer.Point, error) {
	width := float64(target.Viewport.Width)
	height := float64(target.Viewport.Height)
	if width <= 0 || height <= 0 {
		return point, pointerFallback("the target has no viewport")
	}
	if metrics != nil {
		if metrics.Scale != 0 && (metrics.Scale < 0.99 || metrics.Scale > 1.01) {
			return point, pointerFallback("the page is pinch-zoomed")
		}
		if metrics.Width > 0 && metrics.Height > 0 {
			width = min(width, metrics.Width)
			height = min(height, metrics.Height)
		}
	}
	if point.X < 0 || point.Y < 0 || point.X > width || point.Y > height {
		return point, &pointerUserError{message: fmt.Sprintf("point (%s, %s) is outside the %.0fx%.0f viewport", formatCoordinate(point.X), formatCoordinate(point.Y), width, height)}
	}
	return point, nil
}

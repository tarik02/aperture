package browser

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// fakeChromium accepts CDP websocket clients, announces one page and one iframe session, and
// answers every command, recording what it received.
type fakeChromium struct {
	server *httptest.Server
	mu     sync.Mutex
	got    []cdpMessage
	// dragIntercept makes the first synthetic mouse move report Input.dragIntercepted.
	dragIntercept bool
}

func newFakeChromium(t *testing.T) *fakeChromium {
	t.Helper()
	fake := &fakeChromium{}
	fake.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Header.Get("Upgrade") == "" {
			_, _ = fmt.Fprintf(w, `{"webSocketDebuggerUrl":"ws://%s/devtools/browser/x"}`, req.Host)
			return
		}
		conn, err := websocket.Accept(w, req, nil)
		if err != nil {
			return
		}
		defer func() { _ = conn.CloseNow() }()
		ctx := req.Context()
		write := func(value any) {
			raw, _ := json.Marshal(value)
			_ = conn.Write(ctx, websocket.MessageText, raw)
		}
		write(map[string]any{"method": "Target.attachedToTarget", "params": map[string]any{"sessionId": "S1", "targetInfo": map[string]any{"targetId": "T1", "type": "page"}}})
		write(map[string]any{"method": "Target.attachedToTarget", "sessionId": "S1", "params": map[string]any{"sessionId": "S2", "targetInfo": map[string]any{"targetId": "F1", "type": "iframe"}}})
		for {
			_, raw, err := conn.Read(ctx)
			if err != nil {
				return
			}
			var message cdpMessage
			_ = json.Unmarshal(raw, &message)
			fake.mu.Lock()
			fake.got = append(fake.got, message)
			intercept := fake.dragIntercept
			fake.mu.Unlock()
			result := map[string]any{}
			if message.Method == "Target.attachToTarget" {
				result = map[string]any{"sessionId": "S3"}
			}
			if message.Method == "Runtime.evaluate" {
				result = map[string]any{"result": map[string]any{"value": 2}}
			}
			if message.Method == "Runtime.callFunctionOn" {
				var params struct {
					Function string `json:"functionDeclaration"`
				}
				_ = json.Unmarshal(message.Params, &params)
				value := any("0,0,0,0")
				if strings.Contains(params.Function, "IntersectionObserver") || strings.Contains(params.Function, "smooth") {
					value = true
				}
				result = map[string]any{"result": map[string]any{"value": value}}
			}
			write(map[string]any{"id": message.ID, "sessionId": message.SessionID, "result": result})
			if intercept && message.Method == "Input.dispatchMouseEvent" && message.ID != nil && *message.ID >= cdpProxyInternalIDBase {
				write(map[string]any{"method": "Input.dragIntercepted", "sessionId": message.SessionID, "params": map[string]any{}})
			}
		}
	}))
	t.Cleanup(fake.server.Close)
	return fake
}

func (f *fakeChromium) methods() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	methods := make([]string, 0, len(f.got))
	for _, message := range f.got {
		methods = append(methods, message.Method)
	}
	return methods
}

// fakeWeston records compositor control commands and accepts them all.
type fakeWeston struct {
	mu    sync.Mutex
	lines []string
	times []time.Time
}

func newFakeWeston(t *testing.T) (*fakeWeston, string) {
	t.Helper()
	socket := filepath.Join(t.TempDir(), "control")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	weston := &fakeWeston{}
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			line, _ := bufio.NewReader(conn).ReadString('\n')
			weston.mu.Lock()
			weston.lines = append(weston.lines, strings.TrimSpace(line))
			weston.times = append(weston.times, time.Now())
			weston.mu.Unlock()
			_, _ = conn.Write([]byte("ok\n"))
			_ = conn.Close()
		}
	}()
	return weston, socket
}

func (w *fakeWeston) commands(prefix string) []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	var matching []string
	for _, line := range w.lines {
		if strings.HasPrefix(line, prefix+" ") {
			matching = append(matching, line)
		}
	}
	return matching
}

func (w *fakeWeston) all() []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]string(nil), w.lines...)
}

type proxyHarness struct {
	t       *testing.T
	chrome  *fakeChromium
	weston  *fakeWeston
	cadence atomic.Int32
	client  *websocket.Conn
	nextID  int64
}

func newProxyHarness(t *testing.T, cadence automationCadence) *proxyHarness {
	t.Helper()
	h := &proxyHarness{t: t, chrome: newFakeChromium(t)}
	weston, socket := newFakeWeston(t)
	h.weston = weston
	h.cadence.Store(int32(cadence))
	pointer := newCDPPointer(socket, func(targetID string) (cdpSurface, bool) {
		return cdpSurface{id: 7, width: 2000, height: 1000}, targetID == "T1"
	})
	proxy := newCDPProxy(strings.TrimPrefix(h.chrome.server.URL, "http://"), func() automationCadence { return automationCadence(h.cadence.Load()) }, pointer)
	fast := cadenceTiming{glideSpeed: 1e5, glideMin: 30 * time.Millisecond, glideMax: 60 * time.Millisecond, dwell: 5 * time.Millisecond, hold: 5 * time.Millisecond}
	proxy.timing = &fast
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	endpoint, err := proxy.serve(ctx)
	if err != nil {
		t.Fatal(err)
	}
	client, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(endpoint, "http")+"/devtools/browser/x", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.CloseNow() })
	h.client = client
	// Both announcements reach the client; once read, the proxy has recorded the sessions.
	for range 2 {
		h.read()
	}
	return h
}

func (h *proxyHarness) read() cdpMessage {
	h.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, raw, err := h.client.Read(ctx)
	if err != nil {
		h.t.Fatalf("read: %v", err)
	}
	var message cdpMessage
	_ = json.Unmarshal(raw, &message)
	return message
}

func (h *proxyHarness) send(sessionID, method string, params any) int64 {
	h.t.Helper()
	h.nextID++
	raw, _ := json.Marshal(map[string]any{"id": h.nextID, "method": method, "params": params, "sessionId": sessionID})
	if err := h.client.Write(context.Background(), websocket.MessageText, raw); err != nil {
		h.t.Fatal(err)
	}
	return h.nextID
}

func (h *proxyHarness) mouse(sessionID, kind string, x, y float64, extra map[string]any) int64 {
	params := map[string]any{"type": kind, "x": x, "y": y, "button": "left", "clickCount": 1}
	for key, value := range extra {
		params[key] = value
	}
	return h.send(sessionID, "Input.dispatchMouseEvent", params)
}

func TestProxyRelaysCommandsUntouchedAndSwallowsInternalCalls(t *testing.T) {
	h := newProxyHarness(t, cadenceImmediate)
	id := h.mouse("S1", "mouseMoved", 10, 10, nil)
	if reply := h.read(); reply.ID == nil || *reply.ID != id || reply.SessionID != "S1" {
		t.Fatalf("reply = %+v, want response to %d", reply, id)
	}
	if got := h.chrome.methods(); len(got) != 1 || got[0] != "Input.dispatchMouseEvent" {
		t.Fatalf("upstream saw %v", got)
	}
	if len(h.weston.all()) != 0 {
		t.Fatalf("immediate cadence sent compositor input: %v", h.weston.all())
	}
}

// Input addressed to an iframe session or an explicitly attached session reaches the page's surface.
func TestProxyMapsSessionsToTargets(t *testing.T) {
	h := newProxyHarness(t, cadenceRecorded)
	h.send("", "Target.attachToTarget", map[string]any{"targetId": "T1", "flatten": true})
	if reply := h.read(); !strings.Contains(string(reply.Result), "S3") {
		t.Fatalf("attach response = %s", reply.Result)
	}
	for _, session := range []string{"S2", "S3"} {
		h.mouse(session, "mouseMoved", 10, 10, nil)
		h.read()
	}
	if got := len(h.weston.commands("motion")); got != 2 {
		t.Fatalf("motions = %d, want input from both sessions to reach surface 7", got)
	}
	h.send("", "Target.attachToTarget", map[string]any{"targetId": "T-unknown", "flatten": true})
	h.read()
}

func TestRealMouseGlidesClicksInOrderAndMapsDevicePixels(t *testing.T) {
	h := newProxyHarness(t, cadenceRecorded)
	// Playwright does not await these: they must still run in order.
	ids := []int64{
		h.mouse("S1", "mouseMoved", 100, 50, nil),
		h.mouse("S1", "mouseMoved", 300, 50, nil),
		h.mouse("S1", "mousePressed", 300, 50, nil),
		h.mouse("S1", "mouseReleased", 300, 50, nil),
	}
	for _, want := range ids {
		if reply := h.read(); reply.ID == nil || *reply.ID != want {
			t.Fatalf("reply %+v, want id %d in order", reply, want)
		}
	}
	// devicePixelRatio is 2 in the fake page, so CSS 300,50 is surface 600,100.
	motions := h.weston.commands("motion")
	if len(motions) < 3 || motions[len(motions)-1] != "motion 7 600.00 100.00" {
		t.Fatalf("motions = %v, want a glide ending at 600,100", motions)
	}
	var lastX float64
	for _, line := range motions {
		var surface int
		var x, y float64
		_, _ = fmt.Sscanf(line, "motion %d %f %f", &surface, &x, &y)
		if x < lastX {
			t.Fatalf("pointer moved backwards in %v", motions)
		}
		lastX = x
	}
	buttons := h.weston.commands("button-at")
	if len(buttons) != 2 || buttons[0] != "button-at 7 600.00 100.00 272 1" || buttons[1] != "button-at 7 600.00 100.00 272 0" {
		t.Fatalf("buttons = %v", buttons)
	}
	for _, method := range h.chrome.methods() {
		if method == "Input.dispatchMouseEvent" {
			t.Fatal("real input was also sent over CDP")
		}
	}
}

func TestRealMouseWaitsOutDoubleClickWindowForUnrelatedClicks(t *testing.T) {
	h := newProxyHarness(t, cadenceRecorded)
	h.mouse("S1", "mouseMoved", 100, 50, nil)
	h.mouse("S1", "mousePressed", 100, 50, nil)
	h.mouse("S1", "mouseReleased", 100, 50, nil)
	h.mouse("S1", "mousePressed", 100, 50, nil)
	h.mouse("S1", "mouseReleased", 100, 50, nil)
	for range 5 {
		h.read()
	}
	var presses []time.Time
	h.weston.mu.Lock()
	for i, line := range h.weston.lines {
		if strings.HasSuffix(line, " 272 1") {
			presses = append(presses, h.weston.times[i])
		}
	}
	h.weston.mu.Unlock()
	if len(presses) != 2 || presses[1].Sub(presses[0]) < dblclickGuardWindow-50*time.Millisecond {
		t.Fatalf("presses %v must be a double-click window apart", presses)
	}
}

func TestRealMouseKeepsModifiedClicksOnCDP(t *testing.T) {
	h := newProxyHarness(t, cadenceRecorded)
	h.mouse("S1", "mouseMoved", 100, 50, map[string]any{"modifiers": 2})
	h.mouse("S1", "mousePressed", 100, 50, map[string]any{"modifiers": 2})
	h.read()
	h.read()
	if buttons := h.weston.commands("button-at"); len(buttons) != 0 {
		t.Fatalf("modified click used real buttons: %v", buttons)
	}
	if len(h.weston.commands("motion")) == 0 {
		t.Fatal("modified click should still show the pointer arriving")
	}
}

func TestRealWheelQuantizesWithCarry(t *testing.T) {
	h := newProxyHarness(t, cadenceRecorded)
	h.mouse("S1", "mouseWheel", 100, 50, map[string]any{"deltaX": 0, "deltaY": 101})
	h.read()
	var total float64
	for _, line := range h.weston.commands("axis-at") {
		var surface int
		var x, y, dx, dy float64
		_, _ = fmt.Sscanf(line, "axis-at %d %f %f %f %f", &surface, &x, &y, &dx, &dy)
		total += dy
		if math.Abs(dy*wheelPxPerAxisUnit-math.Round(dy*wheelPxPerAxisUnit)) > 1e-3 {
			t.Fatalf("step %q is not a whole number of pixels", line)
		}
	}
	if math.Abs(total*wheelPxPerAxisUnit-101) > 0.01 {
		t.Fatalf("scrolled %.3f px, want 101", total*wheelPxPerAxisUnit)
	}
}

func TestInterceptedDragReleasesRealButton(t *testing.T) {
	h := newProxyHarness(t, cadenceRecorded)
	h.chrome.mu.Lock()
	h.chrome.dragIntercept = true
	h.chrome.mu.Unlock()
	h.send("S1", "Input.setInterceptDrags", map[string]any{"enabled": true})
	h.read()
	h.mouse("S1", "mouseMoved", 100, 50, map[string]any{"button": "none"})
	h.mouse("S1", "mousePressed", 100, 50, nil)
	h.mouse("S1", "mouseMoved", 140, 50, map[string]any{"buttons": 1})
	h.mouse("S1", "mouseReleased", 140, 50, nil)
	for range 4 {
		h.read()
	}
	buttons := h.weston.commands("button-at")
	if len(buttons) != 2 || !strings.HasSuffix(buttons[0], " 1") || !strings.HasSuffix(buttons[1], " 0") {
		t.Fatalf("buttons = %v, want one press and one release; all %v", buttons, h.weston.all())
	}
	if got := h.chrome.methods(); !strings.Contains(strings.Join(got, ","), "Input.dispatchMouseEvent") {
		t.Fatalf("the drag start was not sent over CDP: %v", got)
	}
}

func TestVanishedClientReleasesHeldButton(t *testing.T) {
	h := newProxyHarness(t, cadenceRecorded)
	h.mouse("S1", "mouseMoved", 100, 50, nil)
	h.mouse("S1", "mousePressed", 100, 50, nil)
	h.read()
	h.read()
	_ = h.client.CloseNow()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if lines := h.weston.commands("button"); len(lines) == 1 {
			if lines[0] != "button 7 272 0" {
				t.Fatalf("release = %q", lines[0])
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("held button was never released: %v", h.weston.all())
}

func TestRevealScrollIsSmoothedOnlyOutsideImmediateCadence(t *testing.T) {
	for _, tc := range []struct {
		cadence automationCadence
		smooth  bool
	}{{cadenceImmediate, false}, {cadenceRecorded, true}} {
		h := newProxyHarness(t, tc.cadence)
		id := h.send("S2", "DOM.scrollIntoViewIfNeeded", map[string]any{"objectId": "obj1"})
		if reply := h.read(); reply.ID == nil || *reply.ID != id {
			t.Fatalf("reply %+v", reply)
		}
		methods := h.chrome.methods()
		if smoothed := len(methods) > 1; smoothed != tc.smooth {
			t.Fatalf("cadence %v: upstream saw %v", tc.cadence, methods)
		}
		if last := methods[len(methods)-1]; last != "DOM.scrollIntoViewIfNeeded" {
			t.Fatalf("original command must be forwarded last, got %v", methods)
		}
	}
}

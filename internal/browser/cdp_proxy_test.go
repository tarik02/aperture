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
	// emit writes an event on the latest connection.
	emit func(value any)
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
		fake.mu.Lock()
		fake.emit = write
		fake.mu.Unlock()
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
			fake.mu.Unlock()
			result := map[string]any{}
			if message.Method == "Target.attachToTarget" {
				result = map[string]any{"sessionId": "S3"}
			}
			if message.Method == "Target.createTarget" {
				result = map[string]any{"targetId": "T-new"}
			}
			if message.Method == "Runtime.evaluate" {
				var params struct {
					Expression string `json:"expression"`
				}
				_ = json.Unmarshal(message.Params, &params)
				value := any(1)
				if strings.Contains(params.Expression, "elementFromPoint") {
					value = `button "Save"`
				}
				result = map[string]any{"result": map[string]any{"value": value}}
				if strings.HasSuffix(params.Expression, "-script") {
					result = map[string]any{"result": map[string]any{"objectId": params.Expression}}
				}
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

func (f *fakeChromium) count(method string) int {
	count := 0
	for _, got := range f.methods() {
		if got == method {
			count++
		}
	}
	return count
}

// event sends an upstream event with the fake's own session routing.
func (f *fakeChromium) event(method, sessionID string, params map[string]any) {
	f.mu.Lock()
	emit := f.emit
	f.mu.Unlock()
	message := map[string]any{"method": method, "params": params}
	if sessionID != "" {
		message["sessionId"] = sessionID
	}
	emit(message)
}

// fakeWeston records compositor control commands and accepts them all, apart from those with
// the reject prefix.
type fakeWeston struct {
	mu     sync.Mutex
	lines  []string
	times  []time.Time
	reject string
	onLine func(line string, count int) // called for every command once recorded, with the count so far
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
			line = strings.TrimSpace(line)
			weston.mu.Lock()
			weston.lines = append(weston.lines, line)
			weston.times = append(weston.times, time.Now())
			rejected := weston.reject != "" && strings.HasPrefix(line, weston.reject)
			onLine, count := weston.onLine, len(weston.lines)
			weston.mu.Unlock()
			if onLine != nil {
				onLine(line, count)
			}
			response := "ok\n"
			if rejected {
				response = "error rejected\n"
			}
			_, _ = conn.Write([]byte(response))
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

func (w *fakeWeston) rejectPrefix(prefix string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.reject = prefix
}

// waitFor polls until the compositor saw want commands with the prefix.
func (w *fakeWeston) waitFor(t *testing.T, prefix string, want int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if len(w.commands(prefix)) >= want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("compositor never saw %d %q commands: %v", want, prefix, w.all())
}

type proxyHarness struct {
	t          *testing.T
	chrome     *fakeChromium
	weston     *fakeWeston
	compositor *compositorPointer
	cadence    atomic.Int32
	realTiming atomic.Bool // pace the cadences as shipped instead of the fast test timings
	slowGlide  atomic.Bool // make every glide take seconds, to interrupt it
	client     *websocket.Conn
	nextID     int64

	journalMu sync.Mutex
	journaled []map[string]any
}

func (h *proxyHarness) timing(cadence automationCadence) cadenceTiming {
	if h.realTiming.Load() {
		return cadence.timing()
	}
	timing := cadenceTiming{glideSpeed: 1e5, glideMin: 30 * time.Millisecond, glideMax: 60 * time.Millisecond, dwell: 5 * time.Millisecond, hold: 5 * time.Millisecond}
	if h.slowGlide.Load() {
		timing.glideSpeed, timing.glideMin, timing.glideMax = 100, 3*time.Second, 3*time.Second
	}
	return timing
}

func (h *proxyHarness) record(kind string, _ time.Time, fields map[string]any) {
	h.journalMu.Lock()
	defer h.journalMu.Unlock()
	h.journaled = append(h.journaled, map[string]any{"kind": kind, "fields": fields})
}

// entries waits for the async press entry and returns what was journaled, one summary per entry.
func (h *proxyHarness) entries(want int) []string {
	h.t.Helper()
	for range 100 {
		h.journalMu.Lock()
		count := len(h.journaled)
		h.journalMu.Unlock()
		if count >= want {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	h.journalMu.Lock()
	defer h.journalMu.Unlock()
	summaries := make([]string, 0, len(h.journaled))
	for _, entry := range h.journaled {
		encoded, _ := json.Marshal(entry["fields"])
		summaries = append(summaries, fmt.Sprintf("%s %s", entry["kind"], encoded))
	}
	return summaries
}

func newProxyHarness(t *testing.T, cadence automationCadence, configure ...func(*cdpProxy)) *proxyHarness {
	t.Helper()
	h := &proxyHarness{t: t, chrome: newFakeChromium(t)}
	weston, socket := newFakeWeston(t)
	h.weston = weston
	h.cadence.Store(int32(cadence))
	h.compositor = newCompositorPointer(socket)
	pointer := newCDPPointer(h.compositor, func(targetID string) (cdpSurface, bool) {
		return cdpSurface{id: 7, targetID: "T1", width: 2000, height: 1000}, targetID == "T1"
	}, h.record)
	proxy := newCDPProxy(strings.TrimPrefix(h.chrome.server.URL, "http://"), func() automationCadence { return automationCadence(h.cadence.Load()) }, pointer, h.record, func() bool { return true })
	proxy.timing = h.timing
	for _, setup := range configure {
		setup(proxy)
	}
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
	if motions := h.weston.commands("motion"); len(motions) < 2 || motions[len(motions)-1] != "motion 7 10.00 10.00" || motions[len(motions)-2] != "motion 7 10.00 10.00" {
		t.Fatalf("motions = %v, want input from both sessions to reach surface 7", motions)
	}
	h.send("", "Target.attachToTarget", map[string]any{"targetId": "T-unknown", "flatten": true})
	h.read()
}

func TestRealMouseGlidesClicksInOrderInCSSPixels(t *testing.T) {
	h := newProxyHarness(t, cadenceRecorded)
	// Playwright does not await these: they must still run in order.
	ids := []int64{
		h.mouse("S1", "mouseMoved", 1100, 50, nil),
		h.mouse("S1", "mouseMoved", 1300, 50, nil),
		h.mouse("S1", "mousePressed", 1300, 50, nil),
		h.mouse("S1", "mouseReleased", 1300, 50, nil),
	}
	for _, want := range ids {
		if reply := h.read(); reply.ID == nil || *reply.ID != want {
			t.Fatalf("reply %+v, want id %d in order", reply, want)
		}
	}
	// Surface coordinates are CSS pixels, whatever the device scale factor.
	motions := h.weston.commands("motion")
	if len(motions) < 3 || motions[len(motions)-1] != "motion 7 1300.00 50.00" {
		t.Fatalf("motions = %v, want a glide ending at 1300,50", motions)
	}
	lastX := 1000.0 // a glide from an unknown position starts at the surface center
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
	if len(buttons) != 2 || buttons[0] != "button-at 7 1300.00 50.00 272 1" || buttons[1] != "button-at 7 1300.00 50.00 272 0" {
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
		// Chromium truncates each Wayland wheel delta to CSS pixels.
		total += math.Trunc(dy * 12)
	}
	if total != 101 {
		t.Fatalf("scrolled %.0f px, want 101", total)
	}
}

// Playwright's drag watch: when Chromium reports that a drag started during the real glide, the
// glide stops and the real button goes up without coordinates; Playwright drives the drag on CDP.
func TestInterceptedDragStopsTheGlideAndDropsTheRealButton(t *testing.T) {
	h := newProxyHarness(t, cadenceRecorded)
	h.slowGlide.Store(true)
	h.send("S1", "Input.setInterceptDrags", map[string]any{"enabled": true})
	h.read()
	h.mouse("S1", "mouseMoved", 100, 50, map[string]any{"button": "none"})
	h.mouse("S1", "mousePressed", 100, 50, nil)
	h.read()
	h.read()
	before := len(h.weston.all())
	h.weston.mu.Lock()
	h.weston.onLine = func(line string, count int) {
		// Chromium reports the drag after the fifth frame of the glide.
		if strings.HasPrefix(line, "motion ") && count == before+5 {
			h.chrome.event("Input.dragIntercepted", "S1", map[string]any{})
		}
	}
	h.weston.mu.Unlock()
	id := h.mouse("S1", "mouseMoved", 1900, 50, map[string]any{"buttons": 1})
	started := time.Now()
	for {
		reply := h.read()
		if reply.Method == "Input.dragIntercepted" {
			continue
		}
		if reply.ID == nil || *reply.ID != id || len(reply.Error) > 0 {
			t.Fatalf("reply %+v", reply)
		}
		break
	}
	if time.Since(started) > time.Second {
		t.Fatal("the glide did not stop when the drag was intercepted")
	}
	if releases := h.weston.commands("button"); len(releases) != 1 || releases[0] != "button 7 272 0" {
		t.Fatalf("releases = %v, want one without coordinates; all %v", releases, h.weston.all())
	}
	if buttons := h.weston.commands("button-at"); len(buttons) != 1 {
		t.Fatalf("button-at = %v, want only the press", buttons)
	}
	all := h.weston.all()
	if frames := len(all) - 1 - before - 5; frames > 3 || all[len(all)-1] != "button 7 272 0" {
		t.Fatalf("%d frames after the interception, ending with %q", frames, all[len(all)-1])
	}
	time.Sleep(100 * time.Millisecond)
	if n := len(h.weston.all()); n != len(all) {
		t.Fatalf("the glide went on after the interception: %v", h.weston.all()[len(all):])
	}
	// The drag then ends on CDP: nothing is held for real, so the release is relayed.
	h.mouse("S1", "mouseReleased", 1900, 50, nil)
	h.read()
	if n := h.chrome.count("Input.dispatchMouseEvent"); n != 1 {
		t.Fatalf("upstream saw %d mouse commands, want the relayed release", n)
	}
}

// Without an interception the watched glide is an ordinary one: no synthetic move goes upstream.
func TestDragWatchWithoutInterceptionGlidesForReal(t *testing.T) {
	h := newProxyHarness(t, cadenceRecorded)
	h.send("S1", "Input.setInterceptDrags", map[string]any{"enabled": true})
	h.read()
	h.mouse("S1", "mouseMoved", 100, 50, map[string]any{"button": "none"})
	h.mouse("S1", "mousePressed", 100, 50, nil)
	h.mouse("S1", "mouseMoved", 140, 50, map[string]any{"buttons": 1})
	h.mouse("S1", "mouseReleased", 140, 50, nil)
	for range 4 {
		if reply := h.read(); len(reply.Error) > 0 {
			t.Fatalf("reply %+v", reply)
		}
	}
	buttons := h.weston.commands("button-at")
	if len(buttons) != 2 || buttons[0] != "button-at 7 100.00 50.00 272 1" || buttons[1] != "button-at 7 140.00 50.00 272 0" {
		t.Fatalf("buttons = %v; all %v", buttons, h.weston.all())
	}
	if n := h.chrome.count("Input.dispatchMouseEvent"); n != 0 {
		t.Fatalf("%d synthetic mouse commands went upstream", n)
	}
}

// A move with a button that is not held for real continues a CDP press, and stays on CDP.
func TestDragMoveAfterCDPPressIsRelayed(t *testing.T) {
	h := newProxyHarness(t, cadenceImmediate)
	h.mouse("S1", "mousePressed", 100, 50, nil)
	h.read()
	h.cadence.Store(int32(cadenceRecorded))
	h.mouse("S1", "mouseMoved", 140, 50, map[string]any{"buttons": 1})
	h.mouse("S1", "mouseReleased", 140, 50, nil)
	h.read()
	h.read()
	if n := h.chrome.count("Input.dispatchMouseEvent"); n != 3 {
		t.Fatalf("upstream saw %d mouse commands, want the whole gesture", n)
	}
	if lines := h.weston.all(); len(lines) != 0 {
		t.Fatalf("the compositor got %v", lines)
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

func TestProxyJournalsGesturesWithoutDelayingTheReply(t *testing.T) {
	h := newProxyHarness(t, cadenceRecorded)
	for _, id := range []int64{
		h.mouse("S1", "mouseMoved", 1300, 50, nil),
		h.mouse("S1", "mousePressed", 1300, 50, nil),
		h.mouse("S1", "mouseReleased", 1300, 50, nil),
		h.mouse("S1", "mouseWheel", 1300, 50, map[string]any{"deltaY": 240}),
	} {
		if reply := h.read(); reply.ID == nil || *reply.ID != id {
			t.Fatalf("reply %+v, want id %d", reply, id)
		}
	}
	id := h.send("S2", "DOM.scrollIntoViewIfNeeded", map[string]any{"objectId": "obj1"})
	if reply := h.read(); reply.ID == nil || *reply.ID != id {
		t.Fatalf("reply %+v, want id %d", reply, id)
	}
	got := strings.Join(h.entries(4), "\n")
	for _, want := range []string{
		`glide {"from":[1000,500],"targetId":"T1","to":[1300,50]}`,
		`press {"button":"left","count":1,"element":"button \"Save\"","targetId":"T1","x":1300,"y":50}`,
		`wheel {"dx":0,"dy":240,"targetId":"T1","x":1300,"y":50}`,
		`reveal {"targetId":"T1"}`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("journal lacks %s:\n%s", want, got)
		}
	}
}

// The cadence can drop to immediate between a real press and its release (an editor leaves, a
// recording stops): the release must still happen for real, and only then is input relayed again.
func TestCadenceFlipAfterRealPressStillReleasesForReal(t *testing.T) {
	h := newProxyHarness(t, cadenceRecorded)
	h.mouse("S1", "mouseMoved", 100, 50, nil)
	h.mouse("S1", "mousePressed", 100, 50, nil)
	h.read()
	h.read()
	h.cadence.Store(int32(cadenceImmediate))
	id := h.mouse("S1", "mouseReleased", 100, 50, nil)
	if reply := h.read(); reply.ID == nil || *reply.ID != id || len(reply.Error) > 0 {
		t.Fatalf("reply %+v", reply)
	}
	if buttons := h.weston.commands("button-at"); len(buttons) != 2 || buttons[1] != "button-at 7 100.00 50.00 272 0" {
		t.Fatalf("buttons = %v, want the real release", buttons)
	}
	if n := h.chrome.count("Input.dispatchMouseEvent"); n != 0 {
		t.Fatalf("the real gesture leaked %d commands over CDP", n)
	}
	motions := len(h.weston.commands("motion"))
	h.mouse("S1", "mouseMoved", 300, 50, nil)
	h.read()
	if n := h.chrome.count("Input.dispatchMouseEvent"); n != 1 || len(h.weston.commands("motion")) != motions {
		t.Fatalf("immediate cadence after the gesture: %d CDP moves, motions %v", n, h.weston.commands("motion"))
	}
}

// A release of a button whose press went over CDP (before a recording started, with modifiers,
// on a target without a surface) follows it over CDP, or Chromium's button stays down.
func TestReleaseWithNothingHeldIsRelayed(t *testing.T) {
	h := newProxyHarness(t, cadenceImmediate)
	h.mouse("S1", "mousePressed", 100, 50, nil)
	h.read()
	h.cadence.Store(int32(cadenceRecorded))
	id := h.mouse("S1", "mouseReleased", 100, 50, nil)
	if reply := h.read(); reply.ID == nil || *reply.ID != id {
		t.Fatalf("reply %+v", reply)
	}
	if n := h.chrome.count("Input.dispatchMouseEvent"); n != 2 {
		t.Fatalf("upstream saw %d mouse commands, want press and release", n)
	}
	if lines := h.weston.all(); len(lines) != 0 {
		t.Fatalf("nothing was held, yet the compositor got %v", lines)
	}
}

func TestTwoButtonsAreHeldAndReleasedIndividually(t *testing.T) {
	h := newProxyHarness(t, cadenceRecorded)
	h.mouse("S1", "mouseMoved", 100, 50, nil)
	h.mouse("S1", "mousePressed", 100, 50, nil)
	h.mouse("S1", "mousePressed", 100, 50, map[string]any{"button": "right"})
	h.mouse("S1", "mouseReleased", 100, 50, nil)
	h.mouse("S1", "mouseReleased", 100, 50, map[string]any{"button": "right"})
	for range 5 {
		if reply := h.read(); len(reply.Error) > 0 {
			t.Fatalf("reply %+v", reply)
		}
	}
	var codes []string
	for _, line := range h.weston.commands("button-at") {
		codes = append(codes, line[strings.LastIndex(line, " 27"):])
	}
	if got := strings.Join(codes, ","); got != " 272 1, 273 1, 272 0, 273 0" {
		t.Fatalf("button sequence %q", got)
	}
	if releases := h.weston.commands("button"); len(releases) != 0 {
		t.Fatalf("the safety net released buttons that were released properly: %v", releases)
	}
}

func TestRejectedCompositorCommandFailsTheCallAndReleasesHeld(t *testing.T) {
	h := newProxyHarness(t, cadenceRecorded)
	h.mouse("S1", "mouseMoved", 100, 50, nil)
	h.mouse("S1", "mousePressed", 100, 50, nil)
	h.read()
	h.read()
	h.weston.rejectPrefix("motion")
	id := h.mouse("S1", "mouseMoved", 500, 50, nil)
	reply := h.read()
	if reply.ID == nil || *reply.ID != id || !strings.Contains(string(reply.Error), "rejected") {
		t.Fatalf("reply %+v, want the compositor's rejection", reply)
	}
	if releases := h.weston.commands("button"); len(releases) != 1 || releases[0] != "button 7 272 0" {
		t.Fatalf("releases = %v", releases)
	}
}

func TestCancelledGlideIsNotJournaled(t *testing.T) {
	h := newProxyHarness(t, cadenceRecorded)
	h.slowGlide.Store(true)
	h.mouse("S1", "mouseMoved", 1900, 900, nil)
	h.weston.waitFor(t, "motion", 3)
	_ = h.client.CloseNow()
	time.Sleep(150 * time.Millisecond)
	got := strings.Join(h.entries(1), "\n")
	if !strings.Contains(got, "target ") || strings.Contains(got, "glide ") {
		t.Fatalf("journal after an interrupted glide:\n%s", got)
	}
}

// A worker attached through an out-of-process iframe is gone with the page that owned both; so is
// what the pointer remembered about the page's surface.
func TestNestedSessionsGoWithTheirPage(t *testing.T) {
	h := newProxyHarness(t, cadenceRecorded)
	h.chrome.event("Target.attachedToTarget", "S2", map[string]any{"sessionId": "S4", "targetInfo": map[string]any{"targetId": "W1", "type": "worker"}})
	h.read()
	h.mouse("S4", "mouseMoved", 100, 50, nil)
	h.read()
	if motions := h.weston.commands("motion"); len(motions) == 0 {
		t.Fatal("input on the worker session did not reach the page's surface")
	}
	if _, known := h.compositor.position(7); !known {
		t.Fatal("the pointer forgot where it is")
	}
	h.chrome.event("Target.detachedFromTarget", "", map[string]any{"sessionId": "S1", "targetId": "T1"})
	h.read()
	motions := len(h.weston.commands("motion"))
	h.mouse("S4", "mouseMoved", 200, 50, nil)
	h.read()
	if n := h.chrome.count("Input.dispatchMouseEvent"); n != 1 || len(h.weston.commands("motion")) != motions {
		t.Fatalf("after the page detached: %d CDP moves, motions %v", n, h.weston.commands("motion"))
	}
	if _, known := h.compositor.position(7); known {
		t.Fatal("the detached page's surface kept its pointer position")
	}
}

// A human and automation move the same pointer: a glide starts where the human left it, and both
// scroll with the same axis unit.
func TestHumanAndAutomationShareThePointerPosition(t *testing.T) {
	h := newProxyHarness(t, cadenceRecorded)
	human := newCompositorInputSender(h.compositor, 2000, 1000)
	human.SetTarget(7, 2000, 1000)
	if err := human.PointerAbsolute(0.1, 0.2); err != nil {
		t.Fatal(err)
	}
	if err := human.Scroll(0, 24, false, false); err != nil {
		t.Fatal(err)
	}
	if got := h.weston.all(); len(got) != 2 || got[0] != "motion 7 200.00 200.00" || got[1] != "axis-at 7 200.00 200.00 0.00000000 2.00000000" {
		t.Fatalf("human input = %v", got)
	}
	id := h.mouse("S1", "mouseMoved", 1300, 50, nil)
	if reply := h.read(); reply.ID == nil || *reply.ID != id {
		t.Fatalf("reply %+v", reply)
	}
	motions := h.weston.commands("motion")
	var x float64
	if _, err := fmt.Sscanf(motions[1], "motion 7 %f", &x); err != nil || x > 400 {
		t.Fatalf("the glide started at %q, not near the human's 200,200", motions[1])
	}
	if got := strings.Join(h.entries(2), "\n"); !strings.Contains(got, `glide {"from":[200,200],"targetId":"T1","to":[1300,50]}`) {
		t.Fatalf("journal:\n%s", got)
	}
	if err := human.Button(272, true); err != nil {
		t.Fatal(err)
	}
	if buttons := h.weston.commands("button-at"); len(buttons) != 1 || buttons[0] != "button-at 7 1300.00 50.00 272 1" {
		t.Fatalf("the human's click did not land where automation left the pointer: %v", buttons)
	}
}

// The presentation cadence is paced by its own timing table.
func TestPresentationCadenceRestsLongerBeforePressing(t *testing.T) {
	h := newProxyHarness(t, cadencePresentation)
	h.realTiming.Store(true)
	h.mouse("S1", "mouseMoved", 1100, 500, nil)
	h.mouse("S1", "mousePressed", 1100, 500, nil)
	h.read()
	h.read()
	h.weston.mu.Lock()
	var arrived, pressed time.Time
	for i, line := range h.weston.lines {
		if strings.HasPrefix(line, "motion ") {
			arrived = h.weston.times[i]
		}
		if strings.HasSuffix(line, " 272 1") {
			pressed = h.weston.times[i]
		}
	}
	h.weston.mu.Unlock()
	if dwell := pressed.Sub(arrived); dwell < presentationTiming.dwell-20*time.Millisecond {
		t.Fatalf("pressed %v after arriving, want the presentation dwell of %v", dwell, presentationTiming.dwell)
	}
}

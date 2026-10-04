package browser

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

const (
	cdpProxyReadLimit = 256 << 20
	// Commands the proxy issues itself use ids far above Playwright's counter; their responses never reach it.
	cdpProxyInternalIDBase = 1 << 30
)

// cdpProxy sits between Playwright MCP and Chromium. It relays CDP frames untouched and, when the
// automation cadence asks for it, turns pointer input and reveal scrolling into followable motion.
type cdpProxy struct {
	upstream       string // Chromium's debugging endpoint, host:port
	cadence        func() automationCadence
	timing         func(automationCadence) cadenceTiming // tests pace the cadences faster
	pointer        *cdpPointer                           // nil for sessions without a compositor
	journal        journalFunc                           // what the proxy does for real, for the recordings that run
	recording      func() bool                           // whether any recording runs, so the journal's extra page queries are worth it
	following      func() bool
	prepareTarget  func(context.Context, string) error
	navigateTarget func(string, string) error
	action         atomic.Bool // a mutating MCP tool is running
	actionMu       sync.Mutex
	actionTarget   string
}

func newCDPProxy(upstream string, cadence func() automationCadence, pointer *cdpPointer, journal journalFunc, recording func() bool) *cdpProxy {
	return &cdpProxy{upstream: upstream, cadence: cadence, timing: automationCadence.timing, pointer: pointer, journal: journal, recording: recording}
}

// serve listens on an ephemeral loopback port until ctx ends and returns the endpoint to hand to Playwright.
func (p *cdpProxy) serve(ctx context.Context) (string, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", fmt.Errorf("listen cdp proxy: %w", err)
	}
	// Hijacked websocket connections take their context from the server's base, so they end with ctx.
	server := &http.Server{
		Handler:           p,
		ReadHeaderTimeout: 10 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return ctx },
	}
	go func() { _ = server.Serve(listener) }()
	go func() {
		<-ctx.Done()
		_ = server.Close()
	}()
	return "http://" + listener.Addr().String(), nil
}

// ServeHTTP admits only direct loopback clients: pages in the sandbox can reach this port, and
// they always send an Origin or a foreign Host.
func (p *cdpProxy) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	host, _, err := net.SplitHostPort(req.Host)
	if err != nil || net.ParseIP(host) == nil || req.Header.Get("Origin") != "" {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if strings.EqualFold(req.Header.Get("Upgrade"), "websocket") {
		p.serveWebSocket(w, req)
		return
	}
	(&httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.Out.URL.Scheme = "http"
			r.Out.URL.Host = p.upstream
			r.Out.Host = p.upstream
			r.Out.Header.Del("Accept-Encoding")
		},
		ModifyResponse: func(resp *http.Response) error {
			body, err := io.ReadAll(resp.Body)
			_ = resp.Body.Close()
			if err != nil {
				return err
			}
			body = bytes.ReplaceAll(body, []byte(p.upstream), []byte(req.Host))
			resp.Body = io.NopCloser(bytes.NewReader(body))
			resp.ContentLength = int64(len(body))
			resp.Header.Set("Content-Length", strconv.Itoa(len(body)))
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			http.Error(w, err.Error(), http.StatusBadGateway)
		},
	}).ServeHTTP(w, req)
}

func (p *cdpProxy) serveWebSocket(w http.ResponseWriter, req *http.Request) {
	down, err := websocket.Accept(w, req, nil)
	if err != nil {
		return
	}
	ctx, cancel := context.WithCancel(req.Context())
	defer cancel()
	up, _, err := websocket.Dial(ctx, "ws://"+p.upstream+req.URL.RequestURI(), nil)
	if err != nil {
		_ = down.Close(websocket.StatusInternalError, "browser unavailable")
		return
	}
	down.SetReadLimit(cdpProxyReadLimit)
	up.SetReadLimit(cdpProxyReadLimit)
	conn := &cdpProxyConn{
		proxy:          p,
		up:             up,
		down:           down,
		ctx:            ctx,
		sessions:       make(map[string]cdpSession),
		attaching:      make(map[int64]string),
		internal:       make(map[int64]chan cdpMessage),
		mouse:          make(chan func(), 1024),
		interceptDrags: make(map[string]bool),
		dragged:        make(chan struct{}, 1),
		held:           make(map[cdpHeldButton]struct{}),
	}
	conn.run(cancel)
	_ = up.Close(websocket.StatusNormalClosure, "")
	_ = down.Close(websocket.StatusNormalClosure, "")
}

type cdpSession struct {
	targetID string
	kind     string
	parent   string // session this one was attached through, empty for top-level sessions
}

// cdpMessage is the envelope of a CDP frame; the payload stays raw.
type cdpMessage struct {
	ID        *int64          `json:"id,omitempty"`
	Method    string          `json:"method,omitempty"`
	Params    json.RawMessage `json:"params,omitempty"`
	SessionID string          `json:"sessionId,omitempty"`
	Result    json.RawMessage `json:"result,omitempty"`
	Error     json.RawMessage `json:"error,omitempty"`
}

// cdpProxyConn is one Playwright connection and its Chromium connection.
type cdpProxyConn struct {
	proxy    *cdpProxy
	up, down *websocket.Conn
	ctx      context.Context

	mu        sync.Mutex
	sessions  map[string]cdpSession
	attaching map[int64]string // Target.attachToTarget request id -> target
	internal  map[int64]chan cdpMessage
	nextID    atomic.Int64

	// Pointer state, used from cdp_input.go.
	mouse          chan func() // Playwright pipelines mouse commands without awaiting them, so they run in order
	mouseBusy      atomic.Int32
	interceptDrags map[string]bool // sessions inside Playwright's Input.setInterceptDrags window
	dragged        chan struct{}
	held           map[cdpHeldButton]struct{} // real buttons this connection pressed and has not released
}

func (c *cdpProxyConn) run(cancel context.CancelFunc) {
	c.nextID.Store(cdpProxyInternalIDBase)
	var wg sync.WaitGroup
	wg.Add(3)
	go func() {
		defer wg.Done()
		c.runMouseQueue()
	}()
	go func() {
		defer wg.Done()
		defer cancel()
		for {
			_, raw, err := c.down.Read(c.ctx)
			if err != nil {
				return
			}
			c.fromClient(raw)
		}
	}()
	go func() {
		defer wg.Done()
		defer cancel()
		for {
			_, raw, err := c.up.Read(c.ctx)
			if err != nil {
				return
			}
			c.fromUpstream(raw)
		}
	}()
	wg.Wait()
	c.releaseHeld()
}

func (c *cdpProxyConn) toUp(raw []byte) {
	_ = c.up.Write(c.ctx, websocket.MessageText, raw)
}

func (c *cdpProxyConn) toDown(raw []byte) {
	_ = c.down.Write(c.ctx, websocket.MessageText, raw)
}

func (c *cdpProxyConn) reply(request cdpMessage, result json.RawMessage, failure string) {
	response := cdpMessage{ID: request.ID, SessionID: request.SessionID, Result: result}
	if failure != "" {
		response.Result = nil
		response.Error, _ = json.Marshal(map[string]any{"code": -32000, "message": failure})
	}
	raw, _ := json.Marshal(response)
	c.toDown(raw)
}

func (c *cdpProxyConn) fromClient(raw []byte) {
	_, method := peekCDP(raw)
	if method == "Target.createTarget" && c.proxy.following != nil && c.proxy.following() {
		c.createRecordedTarget(raw)
		return
	}
	switch method {
	case "Target.attachToTarget":
		var params struct {
			TargetID string `json:"targetId"`
		}
		if message, ok := decodeCDP(raw, &params); ok && message.ID != nil {
			c.mu.Lock()
			c.attaching[*message.ID] = params.TargetID
			c.mu.Unlock()
		}
	case "Input.dispatchMouseEvent", "Input.dispatchDragEvent", "Input.setInterceptDrags":
		if c.queueMouse(raw, method) {
			return
		}
	case "DOM.scrollIntoViewIfNeeded":
		if !c.prepareTarget(raw) {
			return
		}
		if c.proxy.cadence() != cadenceImmediate && c.revealScroll(raw) {
			return
		}
	}
	switch method {
	case "Runtime.evaluate", "Runtime.callFunctionOn":
		if !c.prepareEvaluation(raw) {
			return
		}
	case "Page.bringToFront", "Page.navigate", "Page.reload", "Page.navigateToHistoryEntry", "Page.handleJavaScriptDialog", "DOM.setFileInputFiles", "Emulation.setDeviceMetricsOverride", "Emulation.setEmulatedMedia", "Input.dispatchKeyEvent", "Input.insertText", "Input.dispatchMouseEvent", "Input.dispatchDragEvent":
		if !c.prepareTarget(raw) {
			return
		}
	}
	c.toUp(raw)
}

func (c *cdpProxyConn) prepareTarget(raw []byte) bool {
	var message cdpMessage
	if json.Unmarshal(raw, &message) != nil {
		return true
	}
	_, root, known := c.rootSession(message.SessionID)
	if !known || root.kind != "page" {
		return true
	}
	if c.proxy.action.Load() {
		c.proxy.actionMu.Lock()
		c.proxy.actionTarget = root.targetID
		c.proxy.actionMu.Unlock()
	}
	if c.proxy.prepareTarget == nil {
		return true
	}
	if err := c.proxy.prepareTarget(c.ctx, root.targetID); err != nil {
		c.reply(message, nil, err.Error())
		return false
	}
	return true
}

// A URL supplied at creation would load before the extension has given the tab its own
// capture output. Create it blank, capture its first frame, then perform the navigation.
func (c *cdpProxyConn) createRecordedTarget(raw []byte) {
	params := map[string]json.RawMessage{}
	message, ok := decodeCDP(raw, &params)
	if !ok || message.ID == nil {
		c.toUp(raw)
		return
	}
	var url string
	if err := json.Unmarshal(params["url"], &url); err != nil {
		c.toUp(raw)
		return
	}
	params["url"] = json.RawMessage(`"about:blank"`)
	go func() {
		result, err := c.call(c.ctx, message.SessionID, "Target.createTarget", params)
		var created struct {
			TargetID string `json:"targetId"`
		}
		if err == nil {
			err = json.Unmarshal(result, &created)
		}
		if err == nil && created.TargetID == "" {
			err = errors.New("browser omitted the created target ID")
		}
		if err == nil {
			if c.proxy.action.Load() {
				c.proxy.actionMu.Lock()
				c.proxy.actionTarget = created.TargetID
				c.proxy.actionMu.Unlock()
			}
			err = c.proxy.prepareTarget(c.ctx, created.TargetID)
		}
		if err == nil && url != "" && url != "about:blank" {
			err = c.proxy.navigateTarget(created.TargetID, url)
		}
		if err != nil {
			if created.TargetID != "" {
				_, _ = c.call(c.ctx, message.SessionID, "Target.closeTarget", map[string]string{"targetId": created.TargetID})
			}
			c.reply(message, nil, err.Error())
			return
		}
		c.reply(message, result, "")
	}()
}

func (c *cdpProxyConn) fromUpstream(raw []byte) {
	id, method := peekCDP(raw)
	if id != nil {
		if *id >= cdpProxyInternalIDBase {
			// Responses to the proxy's own commands never reach Playwright, awaited or not.
			c.mu.Lock()
			waiter := c.internal[*id]
			c.mu.Unlock()
			if waiter != nil {
				var message cdpMessage
				_ = json.Unmarshal(raw, &message)
				waiter <- message
			}
			return
		}
		c.mu.Lock()
		targetID, attaching := c.attaching[*id]
		delete(c.attaching, *id)
		c.mu.Unlock()
		if attaching {
			var result struct {
				SessionID string `json:"sessionId"`
			}
			if _, ok := decodeCDP(raw, &result); ok && result.SessionID != "" {
				c.mu.Lock()
				if _, known := c.sessions[result.SessionID]; !known {
					c.sessions[result.SessionID] = cdpSession{targetID: targetID}
				}
				c.mu.Unlock()
			}
		}
		c.toDown(raw)
		return
	}
	switch method {
	case "Target.attachedToTarget", "Target.detachedFromTarget":
		var params struct {
			SessionID  string `json:"sessionId"`
			TargetInfo struct {
				TargetID string `json:"targetId"`
				Type     string `json:"type"`
			} `json:"targetInfo"`
		}
		if message, ok := decodeCDP(raw, &params); ok {
			c.mu.Lock()
			if method == "Target.attachedToTarget" {
				c.sessions[params.SessionID] = cdpSession{targetID: params.TargetInfo.TargetID, kind: params.TargetInfo.Type, parent: message.SessionID}
			} else {
				c.dropSession(params.SessionID)
			}
			c.mu.Unlock()
		}
	case "Input.dragIntercepted":
		select {
		case c.dragged <- struct{}{}:
		default:
		}
	}
	c.toDown(raw)
}

// dropSession forgets a detached session and everything attached through it: a worker of an
// out-of-process iframe goes with the page. A page takes the pointer's state for it along. The
// caller holds c.mu.
func (c *cdpProxyConn) dropSession(sessionID string) {
	session, known := c.sessions[sessionID]
	if !known {
		return
	}
	delete(c.sessions, sessionID)
	delete(c.interceptDrags, sessionID)
	for childID, child := range c.sessions {
		if child.parent == sessionID {
			c.dropSession(childID)
		}
	}
	if session.kind == "page" && c.proxy.pointer != nil {
		c.proxy.pointer.forget(session.targetID)
	}
}

// rootSession resolves a session to the page-level session that owns it: out-of-process
// iframes and workers are attached through their page.
func (c *cdpProxyConn) rootSession(sessionID string) (string, cdpSession, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	session, ok := c.sessions[sessionID]
	for depth := 0; ok && session.kind != "page" && session.parent != "" && depth < 8; depth++ {
		sessionID = session.parent
		session, ok = c.sessions[sessionID]
	}
	return sessionID, session, ok
}

// call issues a proxy-internal command; its response never reaches Playwright. The write belongs
// to the connection (a write cut short by a cancelled context closes the websocket), so only the
// wait for the response is bounded: by ctx and by pageProbeTimeout, so a page blocked by a dialog
// fails the call quickly.
func (c *cdpProxyConn) call(ctx context.Context, sessionID, method string, params any) (json.RawMessage, error) {
	ctx, cancel := context.WithTimeout(ctx, pageProbeTimeout)
	defer cancel()
	id := c.nextID.Add(1)
	waiter := make(chan cdpMessage, 1)
	c.mu.Lock()
	c.internal[id] = waiter
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		delete(c.internal, id)
		c.mu.Unlock()
	}()
	encoded, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}
	raw, _ := json.Marshal(cdpMessage{ID: &id, Method: method, Params: encoded, SessionID: sessionID})
	if err := c.up.Write(c.ctx, websocket.MessageText, raw); err != nil {
		return nil, err
	}
	select {
	case message := <-waiter:
		if len(message.Error) > 0 {
			return nil, fmt.Errorf("%s: %s", method, message.Error)
		}
		return message.Result, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// evaluate runs an expression in a session's main world and decodes its value.
func (c *cdpProxyConn) evaluate(ctx context.Context, sessionID, expression string, value any) error {
	result, err := c.call(ctx, sessionID, "Runtime.evaluate", map[string]any{"expression": expression, "awaitPromise": true, "returnByValue": true})
	if err != nil {
		return err
	}
	evaluated, err := decodeRemoteObject(result)
	if err != nil || value == nil {
		return err
	}
	return json.Unmarshal(evaluated, value)
}

// decodeRemoteObject takes the by-value result out of a Runtime.evaluate or Runtime.callFunctionOn
// response; a thrown exception is an error.
func decodeRemoteObject(raw json.RawMessage) (json.RawMessage, error) {
	var response struct {
		Result struct {
			Value json.RawMessage `json:"value"`
		} `json:"result"`
		ExceptionDetails json.RawMessage `json:"exceptionDetails"`
	}
	if err := json.Unmarshal(raw, &response); err != nil {
		return nil, err
	}
	if len(response.ExceptionDetails) > 0 {
		return nil, errors.New("page script failed")
	}
	return response.Result.Value, nil
}

var (
	// A command leads with its id and method, a response with its id and result or error.
	cdpLeadingID     = regexp.MustCompile(`^\{"id":(\d+),"(?:method":"([^"]*)|result|error)"`)
	cdpLeadingMethod = regexp.MustCompile(`^\{"method":"([^"]*)"`)
)

// peekCDP reads the leading keys that Playwright and Chromium write first, so relayed frames are
// not decoded; any other key order falls back to a full decode.
func peekCDP(raw []byte) (*int64, string) {
	if match := cdpLeadingID.FindSubmatch(raw); match != nil {
		if id, err := strconv.ParseInt(string(match[1]), 10, 64); err == nil {
			return &id, string(match[2])
		}
	}
	if match := cdpLeadingMethod.FindSubmatch(raw); match != nil {
		return nil, string(match[1])
	}
	var message cdpMessage
	_ = json.Unmarshal(raw, &message)
	return message.ID, message.Method
}

// decodeCDP decodes a frame's envelope and its payload: the params of a command or event, the
// result of a response. It reports whether both decoded.
func decodeCDP(raw []byte, payload any) (cdpMessage, bool) {
	var message cdpMessage
	if json.Unmarshal(raw, &message) != nil {
		return message, false
	}
	body := message.Params
	if len(body) == 0 {
		body = message.Result
	}
	return message, json.Unmarshal(body, payload) == nil
}

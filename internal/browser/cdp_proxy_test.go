package browser

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
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
			fake.mu.Unlock()
			result := map[string]any{}
			if message.Method == "Target.attachToTarget" {
				result = map[string]any{"sessionId": "S3"}
			}
			if message.Method == "Runtime.evaluate" {
				result = map[string]any{"result": map[string]any{"value": 2}}
			}
			write(map[string]any{"id": message.ID, "sessionId": message.SessionID, "result": result})
		}
	}))
	t.Cleanup(fake.server.Close)
	return fake
}

func TestProxyRelaysCommandsAndSwallowsInternalCalls(t *testing.T) {
	chrome := newFakeChromium(t)
	proxy := newCDPProxy(strings.TrimPrefix(chrome.server.URL, "http://"))
	connections := make(chan *cdpProxyConn, 1)
	proxy.observe = func(conn *cdpProxyConn) { connections <- conn }
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	endpoint, err := proxy.serve(ctx)
	if err != nil {
		t.Fatal(err)
	}

	// Discovery names the proxy, not Chromium.
	response, err := http.Get(endpoint + "/json/version")
	if err != nil {
		t.Fatal(err)
	}
	var version struct {
		WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
	}
	_ = json.NewDecoder(response.Body).Decode(&version)
	_ = response.Body.Close()
	if !strings.HasPrefix(version.WebSocketDebuggerURL, "ws://"+strings.TrimPrefix(endpoint, "http://")+"/") {
		t.Fatalf("webSocketDebuggerUrl = %q", version.WebSocketDebuggerURL)
	}

	client, _, err := websocket.Dial(ctx, version.WebSocketDebuggerURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = client.CloseNow() }()
	read := func() cdpMessage {
		readCtx, stop := context.WithTimeout(ctx, 5*time.Second)
		defer stop()
		_, raw, err := client.Read(readCtx)
		if err != nil {
			t.Fatal(err)
		}
		var message cdpMessage
		_ = json.Unmarshal(raw, &message)
		return message
	}
	if event := read(); event.Method != "Target.attachedToTarget" {
		t.Fatalf("first frame = %+v", event)
	}
	read() // iframe attach
	send := func(session, method string, params any) {
		raw, _ := json.Marshal(map[string]any{"id": 1, "method": method, "params": params, "sessionId": session})
		if err := client.Write(ctx, websocket.MessageText, raw); err != nil {
			t.Fatal(err)
		}
	}

	send("S1", "Page.enable", map[string]any{})
	if reply := read(); reply.ID == nil || *reply.ID != 1 || reply.SessionID != "S1" {
		t.Fatalf("reply = %+v", reply)
	}
	send("", "Target.attachToTarget", map[string]any{"targetId": "T1", "flatten": true})
	if reply := read(); !strings.Contains(string(reply.Result), "S3") {
		t.Fatalf("attach response = %s", reply.Result)
	}

	// The proxy resolves iframe and attached sessions to the page and issues its own calls on them.
	conn := <-connections
	for session, wantTarget := range map[string]string{"S1": "T1", "S2": "T1", "S3": "T1"} {
		if _, resolved, ok := conn.rootSession(session); !ok || resolved.targetID != wantTarget {
			t.Fatalf("session %s resolves to %+v ok=%v", session, resolved, ok)
		}
	}
	callCtx, stop := context.WithTimeout(ctx, 5*time.Second)
	defer stop()
	if _, err := conn.call(callCtx, "S1", "Runtime.evaluate", map[string]any{"expression": "1"}); err != nil {
		t.Fatal(err)
	}
	// The internal response must not reach the client: the next frame is the answer to a later command.
	send("S1", "Page.disable", map[string]any{})
	if reply := read(); reply.ID == nil || *reply.ID != 1 {
		t.Fatalf("internal response leaked: %+v", reply)
	}
}

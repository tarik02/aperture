package control

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"

	"github.com/chromedp/cdproto/cdp"
	"github.com/chromedp/cdproto/target"
	"github.com/coder/websocket"
)

const cdpReadLimit = 16 << 20

type ctxKey int

const attachedSessionKey ctxKey = iota

type cdpWireMessage struct {
	ID        int64           `json:"id,omitempty"`
	Method    string          `json:"method,omitempty"`
	SessionID string          `json:"sessionId,omitempty"`
	Params    json.RawMessage `json:"params,omitempty"`
	Result    json.RawMessage `json:"result,omitempty"`
	Error     *cdpWireError   `json:"error,omitempty"`
}

type cdpWireError struct {
	Code    int64  `json:"code"`
	Message string `json:"message"`
}

type cdpEvent struct {
	Method    string
	SessionID target.SessionID
	Params    json.RawMessage
}

type browserConn struct {
	ws      *websocket.Conn
	nextID  int64
	pending map[int64]chan callResult
	mu      sync.Mutex

	events chan cdpEvent
	closed chan struct{}
}

type callResult struct {
	result json.RawMessage
	err    error
}

var errBrowserDisconnected = errors.New("browser cdp disconnected")

func dialBrowser(ctx context.Context, port int) (*browserConn, error) {
	wsURL, err := browserWebSocketURL(ctx, port)
	if err != nil {
		return nil, err
	}

	ws, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		return nil, fmt.Errorf("dial browser cdp: %w", err)
	}
	ws.SetReadLimit(cdpReadLimit)

	conn := &browserConn{
		ws:      ws,
		pending: make(map[int64]chan callResult),
		events:  make(chan cdpEvent, 32),
		closed:  make(chan struct{}),
	}
	go conn.readLoop(ctx)
	return conn, nil
}

func browserWebSocketURL(ctx context.Context, port int) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/json/version", port), nil)
	if err != nil {
		return "", err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("fetch cdp version: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("fetch cdp version: status %d", resp.StatusCode)
	}

	var version struct {
		WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&version); err != nil {
		return "", fmt.Errorf("decode cdp version: %w", err)
	}
	if version.WebSocketDebuggerURL == "" {
		return "", errors.New("cdp version missing webSocketDebuggerUrl")
	}
	return version.WebSocketDebuggerURL, nil
}

func (b *browserConn) Close() {
	b.terminate(errBrowserDisconnected)
	_ = b.ws.Close(websocket.StatusNormalClosure, "control gateway closed")
}

func (b *browserConn) terminate(err error) {
	if err == nil {
		err = errBrowserDisconnected
	}
	select {
	case <-b.closed:
		return
	default:
		close(b.closed)
	}

	b.mu.Lock()
	pending := b.pending
	b.pending = make(map[int64]chan callResult)
	b.mu.Unlock()

	for _, ch := range pending {
		select {
		case ch <- callResult{err: err}:
		default:
		}
	}
}

func (b *browserConn) Events() <-chan cdpEvent {
	return b.events
}

func (b *browserConn) CDPContext(parent context.Context) context.Context {
	return cdp.WithExecutor(parent, b)
}

func withAttachedSession(ctx context.Context, sessionID target.SessionID) context.Context {
	return context.WithValue(ctx, attachedSessionKey, sessionID)
}

func attachedSessionFromContext(ctx context.Context) (target.SessionID, bool) {
	sessionID, ok := ctx.Value(attachedSessionKey).(target.SessionID)
	return sessionID, ok
}

func (b *browserConn) Execute(ctx context.Context, method string, params, res any) error {
	id := atomic.AddInt64(&b.nextID, 1)
	ch := make(chan callResult, 1)

	b.mu.Lock()
	b.pending[id] = ch
	b.mu.Unlock()

	defer func() {
		b.mu.Lock()
		delete(b.pending, id)
		b.mu.Unlock()
	}()

	var paramsRaw json.RawMessage
	if params != nil {
		encoded, err := json.Marshal(params)
		if err != nil {
			return err
		}
		paramsRaw = encoded
	}

	msg := cdpWireMessage{
		ID:     id,
		Method: method,
		Params: paramsRaw,
	}
	if sessionID, ok := attachedSessionFromContext(ctx); ok && sessionID != "" {
		msg.SessionID = sessionID.String()
	}

	payload, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	if err := b.ws.Write(ctx, websocket.MessageText, payload); err != nil {
		return err
	}

	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-b.closed:
		return context.Canceled
	case result := <-ch:
		if result.err != nil {
			return result.err
		}
		if res == nil || len(result.result) == 0 {
			return nil
		}
		return json.Unmarshal(result.result, res)
	}
}

func (b *browserConn) readLoop(ctx context.Context) {
	defer close(b.events)
	defer b.terminate(errBrowserDisconnected)

	for {
		_, data, err := b.ws.Read(ctx)
		if err != nil {
			return
		}

		var msg cdpWireMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			continue
		}

		if msg.ID != 0 {
			b.mu.Lock()
			ch, ok := b.pending[msg.ID]
			b.mu.Unlock()
			if ok {
				if msg.Error != nil {
					ch <- callResult{err: fmt.Errorf("cdp %s: %s", msg.Method, msg.Error.Message)}
				} else {
					ch <- callResult{result: msg.Result}
				}
			}
			continue
		}

		if msg.Method == "" {
			continue
		}

		select {
		case <-b.closed:
			return
		case b.events <- cdpEvent{
			Method:    msg.Method,
			SessionID: target.SessionID(msg.SessionID),
			Params:    msg.Params,
		}:
		}
	}
}

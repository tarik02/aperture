package browser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"

	"github.com/coder/websocket"
)

type liveSessionCDPResponse struct {
	ID     int64           `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

type liveSessionCDPEvent struct {
	Method    string          `json:"method"`
	Params    json.RawMessage `json:"params"`
	SessionID string          `json:"sessionId"`
}

type liveSessionCDP struct {
	connection *websocket.Conn

	mu      sync.Mutex
	writeMu sync.Mutex
	nextID  int64
	closed  bool
	pending map[int64]chan liveSessionCDPResponse
	events  chan liveSessionCDPEvent
	done    chan struct{}
}

func connectLiveSessionCDP(ctx context.Context, port int) (*liveSessionCDP, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+net.JoinHostPort("127.0.0.1", strconv.Itoa(port))+"/json/version", nil)
	if err != nil {
		return nil, err
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return nil, fmt.Errorf("discover browser CDP endpoint: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("discover browser CDP endpoint: status %d", response.StatusCode)
	}
	var version struct {
		WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
	}
	if err := json.NewDecoder(response.Body).Decode(&version); err != nil {
		return nil, fmt.Errorf("decode browser CDP endpoint: %w", err)
	}
	if strings.TrimSpace(version.WebSocketDebuggerURL) == "" {
		return nil, errors.New("browser CDP endpoint omitted WebSocket URL")
	}
	connection, _, err := websocket.Dial(ctx, version.WebSocketDebuggerURL, nil)
	if err != nil {
		return nil, fmt.Errorf("connect browser CDP endpoint: %w", err)
	}
	connection.SetReadLimit(cdpDiscoveryMessageLimit)
	client := &liveSessionCDP{
		connection: connection,
		pending:    make(map[int64]chan liveSessionCDPResponse),
		events:     make(chan liveSessionCDPEvent, 64),
		done:       make(chan struct{}),
	}
	go client.read()
	return client, nil
}

func (client *liveSessionCDP) read() {
	defer client.finish()
	for {
		_, body, err := client.connection.Read(context.Background())
		if err != nil {
			return
		}
		var envelope struct {
			ID        int64           `json:"id"`
			Method    string          `json:"method"`
			Params    json.RawMessage `json:"params"`
			SessionID string          `json:"sessionId"`
			Result    json.RawMessage `json:"result"`
			Error     *struct {
				Code    int    `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(body, &envelope); err != nil {
			continue
		}
		if envelope.ID != 0 {
			client.mu.Lock()
			waiter := client.pending[envelope.ID]
			delete(client.pending, envelope.ID)
			client.mu.Unlock()
			if waiter != nil {
				waiter <- liveSessionCDPResponse{ID: envelope.ID, Result: envelope.Result, Error: envelope.Error}
			}
			continue
		}
		if envelope.Method == "" {
			continue
		}
		select {
		case client.events <- liveSessionCDPEvent{Method: envelope.Method, Params: envelope.Params, SessionID: envelope.SessionID}:
		default:
		}
	}
}

func (client *liveSessionCDP) call(ctx context.Context, method string, params any, sessionID string, result any) error {
	client.mu.Lock()
	if client.closed {
		client.mu.Unlock()
		return errors.New("browser CDP connection is closed")
	}
	client.nextID++
	id := client.nextID
	waiter := make(chan liveSessionCDPResponse, 1)
	client.pending[id] = waiter
	client.mu.Unlock()

	request := map[string]any{"id": id, "method": method, "params": params}
	if sessionID != "" {
		request["sessionId"] = sessionID
	}
	body, err := json.Marshal(request)
	if err != nil {
		client.removePending(id)
		return err
	}
	client.writeMu.Lock()
	err = client.connection.Write(ctx, websocket.MessageText, body)
	client.writeMu.Unlock()
	if err != nil {
		client.removePending(id)
		return err
	}

	select {
	case <-ctx.Done():
		client.removePending(id)
		return ctx.Err()
	case <-client.done:
		client.removePending(id)
		return errors.New("browser CDP connection closed")
	case response := <-waiter:
		if response.Error != nil {
			return fmt.Errorf("CDP %s failed (%d): %s", method, response.Error.Code, response.Error.Message)
		}
		if result == nil {
			return nil
		}
		return json.Unmarshal(response.Result, result)
	}
}

func (client *liveSessionCDP) send(ctx context.Context, method string, params any, sessionID string) error {
	client.mu.Lock()
	if client.closed {
		client.mu.Unlock()
		return errors.New("browser CDP connection is closed")
	}
	client.nextID++
	id := client.nextID
	client.mu.Unlock()

	request := map[string]any{"id": id, "method": method, "params": params}
	if sessionID != "" {
		request["sessionId"] = sessionID
	}
	body, err := json.Marshal(request)
	if err != nil {
		return err
	}
	client.writeMu.Lock()
	err = client.connection.Write(ctx, websocket.MessageText, body)
	client.writeMu.Unlock()
	return err
}

func (client *liveSessionCDP) removePending(id int64) {
	client.mu.Lock()
	delete(client.pending, id)
	client.mu.Unlock()
}

func (client *liveSessionCDP) finish() {
	client.mu.Lock()
	if client.closed {
		client.mu.Unlock()
		return
	}
	client.closed = true
	clear(client.pending)
	close(client.done)
	client.mu.Unlock()
}

func (client *liveSessionCDP) close() {
	_ = client.connection.CloseNow()
	<-client.done
}

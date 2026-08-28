package browser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const cdpEventMessageLimit = 64 * 1024 * 1024

type browserCDPError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type browserCDPEnvelope struct {
	ID        int64            `json:"id"`
	SessionID string           `json:"sessionId"`
	Method    string           `json:"method"`
	Params    json.RawMessage  `json:"params"`
	Result    json.RawMessage  `json:"result"`
	Error     *browserCDPError `json:"error"`
}

type browserCDPClient struct {
	ctx        context.Context
	cancel     context.CancelFunc
	connection *websocket.Conn
	readEvents bool

	mu       sync.Mutex
	nextID   int64
	asyncErr error
	pending  map[int64]chan browserCDPEnvelope
	writeMu  sync.Mutex
	events   chan browserCDPEnvelope
	done     chan error
}

func newBrowserCDPCommandClient(ctx context.Context, port int) (*browserCDPClient, error) {
	return connectBrowserCDP(ctx, port, false)
}

func newBrowserCDPEventClient(ctx context.Context, port int) (*browserCDPClient, error) {
	return connectBrowserCDP(ctx, port, true)
}

func connectBrowserCDP(ctx context.Context, port int, readEvents bool) (*browserCDPClient, error) {
	webSocketURL, err := browserCDPWebSocketURL(ctx, port)
	if err != nil {
		return nil, err
	}
	clientCtx, cancel := context.WithCancel(context.Background())
	connection, _, err := websocket.Dial(ctx, webSocketURL, nil)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("connect browser CDP endpoint: %w", err)
	}
	readLimit := int64(cdpDiscoveryMessageLimit)
	if readEvents {
		readLimit = cdpEventMessageLimit
	}
	connection.SetReadLimit(readLimit)
	client := &browserCDPClient{
		ctx:        clientCtx,
		cancel:     cancel,
		connection: connection,
		readEvents: readEvents,
		pending:    make(map[int64]chan browserCDPEnvelope),
		events:     make(chan browserCDPEnvelope, 64),
		done:       make(chan error, 1),
	}
	go client.readLoop()
	return client, nil
}

func (client *browserCDPClient) readLoop() {
	var readErr error
	defer func() {
		client.mu.Lock()
		pending := client.pending
		client.pending = make(map[int64]chan browserCDPEnvelope)
		client.mu.Unlock()
		for _, response := range pending {
			close(response)
		}
		close(client.events)
		client.done <- readErr
		close(client.done)
	}()

	for {
		_, body, err := client.connection.Read(client.ctx)
		if err != nil {
			if client.ctx.Err() == nil {
				readErr = err
			}
			return
		}
		var envelope browserCDPEnvelope
		if err := json.Unmarshal(body, &envelope); err != nil {
			continue
		}
		if envelope.ID != 0 {
			client.mu.Lock()
			response := client.pending[envelope.ID]
			delete(client.pending, envelope.ID)
			if response == nil && envelope.Error != nil && client.asyncErr == nil {
				client.asyncErr = fmt.Errorf("asynchronous CDP command failed (%d): %s", envelope.Error.Code, envelope.Error.Message)
			}
			client.mu.Unlock()
			if response != nil {
				response <- envelope
				close(response)
			}
			continue
		}
		if client.readEvents {
			select {
			case client.events <- envelope:
			case <-client.ctx.Done():
				return
			}
		}
	}
}

func (client *browserCDPClient) Call(ctx context.Context, sessionID string, method string, params any, result any) error {
	requestID, response, err := client.send(ctx, sessionID, method, params, true)
	if err != nil {
		return err
	}
	select {
	case <-ctx.Done():
		client.mu.Lock()
		delete(client.pending, requestID)
		client.mu.Unlock()
		return ctx.Err()
	case envelope, ok := <-response:
		if !ok {
			return errors.New("browser CDP connection closed")
		}
		if envelope.Error != nil {
			return fmt.Errorf("CDP %s failed (%d): %s", method, envelope.Error.Code, envelope.Error.Message)
		}
		if result == nil || len(envelope.Result) == 0 {
			return nil
		}
		if err := json.Unmarshal(envelope.Result, result); err != nil {
			return fmt.Errorf("decode CDP %s result: %w", method, err)
		}
		return nil
	}
}

func (client *browserCDPClient) Send(ctx context.Context, sessionID string, method string, params any) error {
	_, _, err := client.send(ctx, sessionID, method, params, false)
	return err
}

func (client *browserCDPClient) send(ctx context.Context, sessionID string, method string, params any, wait bool) (int64, <-chan browserCDPEnvelope, error) {
	client.mu.Lock()
	if client.asyncErr != nil {
		err := client.asyncErr
		client.mu.Unlock()
		return 0, nil, err
	}
	client.nextID++
	requestID := client.nextID
	var response chan browserCDPEnvelope
	if wait {
		response = make(chan browserCDPEnvelope, 1)
		client.pending[requestID] = response
	}
	client.mu.Unlock()

	request := map[string]any{
		"id":     requestID,
		"method": method,
		"params": params,
	}
	if sessionID != "" {
		request["sessionId"] = sessionID
	}
	body, err := json.Marshal(request)
	if err != nil {
		client.removePending(requestID)
		return 0, nil, err
	}
	client.writeMu.Lock()
	err = client.connection.Write(ctx, websocket.MessageText, body)
	client.writeMu.Unlock()
	if err != nil {
		client.removePending(requestID)
		return 0, nil, err
	}
	return requestID, response, nil
}

func (client *browserCDPClient) removePending(requestID int64) {
	client.mu.Lock()
	delete(client.pending, requestID)
	client.mu.Unlock()
}

func (client *browserCDPClient) Close() {
	client.cancel()
	_ = client.connection.Close(websocket.StatusNormalClosure, "done")
}

func browserCDPWebSocketURL(ctx context.Context, port int) (string, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://127.0.0.1:"+strconv.Itoa(port)+"/json/version", nil)
	if err != nil {
		return "", err
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return "", fmt.Errorf("discover browser CDP endpoint: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("discover browser CDP endpoint: status %d", response.StatusCode)
	}
	var version struct {
		WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, cdpDiscoveryMessageLimit)).Decode(&version); err != nil {
		return "", fmt.Errorf("decode browser CDP endpoint: %w", err)
	}
	parsed, err := url.ParseRequestURI(version.WebSocketDebuggerURL)
	if err != nil {
		return "", fmt.Errorf("invalid browser CDP endpoint: %w", err)
	}
	if parsed.Scheme != "ws" || parsed.User != nil || parsed.Port() != strconv.Itoa(port) {
		return "", errors.New("invalid browser CDP endpoint authority")
	}
	host := parsed.Hostname()
	ip := net.ParseIP(host)
	if host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return "", errors.New("browser CDP endpoint must be loopback")
	}
	if !strings.HasPrefix(parsed.Path, "/devtools/browser/") {
		return "", errors.New("invalid browser CDP endpoint path")
	}
	return parsed.String(), nil
}

func setTargetDeviceMetrics(ctx context.Context, port int, targetID string, viewport compositorViewport) error {
	client, err := newBrowserCDPCommandClient(ctx, port)
	if err != nil {
		return err
	}
	defer client.Close()
	var attached struct {
		SessionID string `json:"sessionId"`
	}
	if err := client.Call(ctx, "", "Target.attachToTarget", map[string]any{
		"targetId": targetID,
		"flatten":  true,
	}, &attached); err != nil {
		return err
	}
	defer func() {
		detachCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = client.Call(detachCtx, "", "Target.detachFromTarget", map[string]any{"sessionId": attached.SessionID}, nil)
	}()
	return client.Call(ctx, attached.SessionID, "Emulation.setDeviceMetricsOverride", map[string]any{
		"width":             viewport.Width,
		"height":            viewport.Height,
		"deviceScaleFactor": viewport.DeviceScaleFactor,
		"mobile":            false,
		"screenWidth":       viewport.Width,
		"screenHeight":      viewport.Height,
	}, nil)
}

package browser

import (
	"context"
	"errors"
	"sync"

	"github.com/coder/websocket"
)

type liveSessionDelivery string

const (
	liveSessionDeliveryReliable liveSessionDelivery = "reliable"
	liveSessionDeliveryRealtime liveSessionDelivery = "realtime"
)

type liveSessionTransport interface {
	kind() string
	send(liveSessionDelivery, []byte) error
	selectTarget(string) error
	close(string)
}

type liveSessionWebSocketTransport struct {
	connection *websocket.Conn
	writeMu    sync.Mutex
	rasterMu   sync.Mutex
	raster     *liveSessionRaster
	session    *liveSession
}

func (transport *liveSessionWebSocketTransport) kind() string {
	return "websocket"
}

func (transport *liveSessionWebSocketTransport) send(_ liveSessionDelivery, body []byte) error {
	transport.writeMu.Lock()
	defer transport.writeMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), liveSessionWriteTimeout)
	defer cancel()
	return transport.connection.Write(ctx, websocket.MessageText, body)
}

func (transport *liveSessionWebSocketTransport) selectTarget(targetID string) error {
	transport.rasterMu.Lock()
	defer transport.rasterMu.Unlock()
	if transport.raster == nil {
		if transport.session == nil {
			return errors.New("WebSocket presentation is unavailable")
		}
		transport.raster = newLiveSessionRaster(transport.session, transport)
	}
	return transport.raster.selectTarget(targetID)
}

func (transport *liveSessionWebSocketTransport) sendBinary(body []byte) error {
	transport.writeMu.Lock()
	defer transport.writeMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), liveSessionWriteTimeout)
	defer cancel()
	return transport.connection.Write(ctx, websocket.MessageBinary, body)
}

func (transport *liveSessionWebSocketTransport) close(reason string) {
	transport.rasterMu.Lock()
	if transport.raster != nil {
		transport.raster.close()
		transport.raster = nil
	}
	transport.rasterMu.Unlock()
	if reason == "" {
		reason = "session transport closed"
	}
	_ = transport.connection.Close(websocket.StatusGoingAway, reason)
}

func (transport *liveSessionWebSocketTransport) closeNow() {
	_ = transport.connection.CloseNow()
}

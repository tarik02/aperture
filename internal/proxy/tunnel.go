package proxy

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/hashicorp/yamux"
)

// SessionIDHeader binds a tunnel handshake to its Aperture session.
const SessionIDHeader = "X-Aperture-Session-Id"

// wsWriteChunk caps one WebSocket message. yamux hands the adapter frames up
// to its stream window (256 KiB), which exceeds the 32 KiB read limit peers
// apply by default, so writes are split.
const wsWriteChunk = 16 * 1024

// ErrTunnelUnauthorized is returned when the operator rejects the handshake auth.
var ErrTunnelUnauthorized = errors.New("proxy: tunnel unauthorized")

// ErrTunnelNotFound is returned when the operator has no such tunnel endpoint.
var ErrTunnelNotFound = errors.New("proxy: tunnel endpoint not found")

// Tunnel is one authenticated yamux-over-WebSocket session to the operator.
// A Tunnel may serve many concurrent streams; it is closed when its
// assignment is superseded (after draining) or on hard-rotate.
type Tunnel struct {
	session *yamux.Session
	adapter *wsAdapter
	closed  atomic.Bool
}

// DialTunnel dials the compound tunnel URL with the per-assignment bearer
// secret and binds the handshake to the session.
func DialTunnel(ctx context.Context, sessionID, tunnelURL, auth string) (*Tunnel, error) {
	endpoint, err := ParseTunnelURL(tunnelURL)
	if err != nil {
		return nil, err
	}

	header := http.Header{}
	header.Set("Authorization", "Bearer "+auth)
	header.Set(SessionIDHeader, sessionID)

	conn, resp, err := websocket.Dial(ctx, endpoint, &websocket.DialOptions{HTTPHeader: header})
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		if resp != nil {
			switch resp.StatusCode {
			case http.StatusUnauthorized, http.StatusForbidden:
				return nil, ErrTunnelUnauthorized
			case http.StatusNotFound:
				return nil, ErrTunnelNotFound
			}
		}
		return nil, fmt.Errorf("proxy: dial tunnel: %w", err)
	}

	adapter := newWSAdapter(conn)
	config := yamux.DefaultConfig()
	config.LogOutput = io.Discard
	session, err := yamux.Client(adapter, config)
	if err != nil {
		_ = adapter.Close()
		return nil, fmt.Errorf("proxy: yamux client: %w", err)
	}

	return &Tunnel{session: session, adapter: adapter}, nil
}

// OpenStream opens one stream for a SOCKS session. The caller relays the
// handshake bytes first; the operator terminates SOCKS.
func (t *Tunnel) OpenStream(ctx context.Context) (net.Conn, error) {
	type result struct {
		stream net.Conn
		err    error
	}
	done := make(chan result, 1)
	go func() {
		stream, err := t.session.OpenStream()
		done <- result{stream, err}
	}()
	select {
	case <-ctx.Done():
		go func() {
			if res := <-done; res.err == nil {
				_ = res.stream.Close()
			}
		}()
		return nil, ctx.Err()
	case res := <-done:
		if res.err != nil {
			return nil, res.err
		}
		return res.stream, nil
	}
}

// Healthy reports whether the tunnel can still carry new streams. A tunnel
// whose WebSocket dropped stays registered until someone notices, so callers
// must check this before handing it work.
func (t *Tunnel) Healthy() bool {
	return !t.closed.Load() && !t.session.IsClosed()
}

// Drain waits for active streams to finish, then closes the tunnel. The idle
// timeout bounds the wait so a superseded tunnel cannot linger forever.
func (t *Tunnel) Drain(timeout time.Duration) {
	defer func() { _ = t.Close() }()
	if timeout <= 0 {
		return
	}
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	deadline := time.Now().Add(timeout)
	for t.session.NumStreams() > 0 {
		if time.Now().After(deadline) {
			return
		}
		<-ticker.C
	}
}

// Close terminates the tunnel, failing active streams.
func (t *Tunnel) Close() error {
	if t.closed.Swap(true) {
		return nil
	}
	_ = t.session.Close()
	return t.adapter.Close()
}

// wsAdapter adapts a coder/websocket binary-message connection to the
// io.ReadWriteCloser yamux needs.
type wsAdapter struct {
	conn   *websocket.Conn
	ctx    context.Context
	cancel context.CancelFunc

	readMu  sync.Mutex
	buf     []byte
	readErr error

	writeMu sync.Mutex
}

func newWSAdapter(conn *websocket.Conn) *wsAdapter {
	// yamux frames are a byte stream, not application messages: the default
	// 32 KiB read limit would close the tunnel on any larger frame.
	conn.SetReadLimit(-1)
	ctx, cancel := context.WithCancel(context.Background())
	return &wsAdapter{conn: conn, ctx: ctx, cancel: cancel}
}

// Read implements io.Reader, reassembling binary messages. Non-binary
// messages are skipped.
func (w *wsAdapter) Read(p []byte) (int, error) {
	w.readMu.Lock()
	defer w.readMu.Unlock()
	for len(w.buf) == 0 {
		if w.readErr != nil {
			return 0, w.readErr
		}
		typ, msg, err := w.conn.Read(w.ctx)
		if err != nil {
			w.readErr = err
			return 0, err
		}
		if typ != websocket.MessageBinary {
			continue
		}
		w.buf = msg
	}
	n := copy(p, w.buf)
	w.buf = w.buf[n:]
	return n, nil
}

// Write implements io.Writer, sending binary messages of at most wsWriteChunk
// bytes so a peer with the default read limit accepts them.
func (w *wsAdapter) Write(p []byte) (int, error) {
	w.writeMu.Lock()
	defer w.writeMu.Unlock()
	written := 0
	for written < len(p) {
		end := min(written+wsWriteChunk, len(p))
		if err := w.conn.Write(w.ctx, websocket.MessageBinary, p[written:end]); err != nil {
			return written, err
		}
		written = end
	}
	return written, nil
}

// Close implements io.Closer.
func (w *wsAdapter) Close() error {
	w.cancel()
	return w.conn.Close(websocket.StatusNormalClosure, "")
}

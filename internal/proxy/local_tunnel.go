package proxy

import (
	"github.com/coder/websocket"
)

// LocalTunnelSubprotocol names the local tunnel wire protocol: yamux over
// binary WebSocket messages, one SOCKS5 session per stream, the same stack as
// an outbound tunnel upstream.
const LocalTunnelSubprotocol = "aperture-tunnel.v1"

// LocalTunnel is a client-attached tunnel: the client dialed Aperture, and the
// wrapper opens a stream for each connection a rule routes via local.
type LocalTunnel struct {
	*Tunnel
}

// NewLocalTunnel starts the tunnel protocol over a WebSocket the client opened.
func NewLocalTunnel(conn *websocket.Conn) (*LocalTunnel, error) {
	tunnel, err := newTunnel(conn)
	if err != nil {
		return nil, err
	}
	return &LocalTunnel{Tunnel: tunnel}, nil
}

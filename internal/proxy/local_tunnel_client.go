package proxy

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"

	"github.com/coder/websocket"
	"github.com/hashicorp/yamux"
)

// LocalTunnelClient is the client end of a session's local tunnel: it attaches
// to the session and dials the targets the session's via-local rules route to
// it, on the machine it runs on.
type LocalTunnelClient struct {
	// URL is the session's tunnel endpoint, ws(s)://host/sessions/<id>/tunnel.
	URL string
	// Token is a credential with session owner access.
	Token string
	// Allow approves a target before it is dialed. The session's rules are
	// set remotely, so the client decides what it exposes.
	Allow func(Target) bool
	// Attached is called once the session accepted the tunnel.
	Attached func()
	// Refused is called for each target the client would not or could not reach.
	Refused func(Target, error)
}

// ErrTargetNotAllowed is reported for a target the client does not expose.
var ErrTargetNotAllowed = errors.New("proxy: target not allowed")

// Serve attaches the tunnel and serves it until the session ends it, a newer
// client replaces it, or ctx is canceled.
func (c LocalTunnelClient) Serve(ctx context.Context) error {
	header := http.Header{}
	header.Set("Authorization", "Bearer "+c.Token)
	conn, resp, err := websocket.Dial(ctx, c.URL, &websocket.DialOptions{
		HTTPHeader:   header,
		Subprotocols: []string{LocalTunnelSubprotocol},
	})
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		if resp != nil {
			switch resp.StatusCode {
			case http.StatusUnauthorized, http.StatusForbidden:
				return ErrTunnelUnauthorized
			case http.StatusNotFound:
				return ErrTunnelNotFound
			}
		}
		return fmt.Errorf("proxy: dial local tunnel: %w", err)
	}

	adapter := newWSAdapter(conn)
	config := yamux.DefaultConfig()
	config.LogOutput = io.Discard
	session, err := yamux.Server(adapter, config)
	if err != nil {
		_ = adapter.Close()
		return fmt.Errorf("proxy: yamux server: %w", err)
	}
	defer func() {
		_ = session.Close()
		_ = adapter.Close()
	}()

	streamCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		<-streamCtx.Done()
		_ = session.Close()
	}()

	if c.Attached != nil {
		c.Attached()
	}

	for {
		stream, err := session.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return fmt.Errorf("proxy: local tunnel closed: %w", err)
		}
		go c.serveStream(streamCtx, stream)
	}
}

// serveStream terminates SOCKS5 on one stream and relays it to the target.
func (c LocalTunnelClient) serveStream(ctx context.Context, stream net.Conn) {
	defer func() { _ = stream.Close() }()

	target, _, err := readConnectRequest(stream)
	if err != nil {
		return
	}

	refuse := func(err error) {
		_, _ = stream.Write(failureReply())
		if c.Refused != nil {
			c.Refused(target, err)
		}
	}

	if c.Allow != nil && !c.Allow(target) {
		refuse(ErrTargetNotAllowed)
		return
	}

	var dialer net.Dialer
	upstream, err := dialer.DialContext(ctx, "tcp", target.String())
	if err != nil {
		refuse(err)
		return
	}
	if _, err := stream.Write(SuccessReply()); err != nil {
		_ = upstream.Close()
		return
	}

	_ = Relay(ctx, stream, upstream)
}

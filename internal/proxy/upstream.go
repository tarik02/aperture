package proxy

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"golang.org/x/net/proxy"
)

const dialTimeout = 15 * time.Second

// Dialer dials upstream connections.
type Dialer interface {
	DialContext(ctx context.Context, network, address string) (net.Conn, error)
}

// DirectDialer dials the target address with TCP.
type DirectDialer struct{}

// DialContext implements Dialer.
func (DirectDialer) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	var d net.Dialer
	return d.DialContext(ctx, network, address)
}

// NewUpstreamDialer builds a client for a generic upstream proxy URL. Tunnel
// upstreams are owned by the manager and are not static dialers.
func NewUpstreamDialer(rawURL string) (Dialer, error) {
	u, err := ParseUpstreamProxyURL(rawURL)
	if err != nil {
		return nil, err
	}
	return dialerForUpstreamURL(u)
}

func dialerForUpstreamURL(u *url.URL) (Dialer, error) {
	switch strings.ToLower(u.Scheme) {
	case "http", "https":
		return &httpConnectDialer{proxyURL: u}, nil
	case "socks5", "socks5h", "socks":
		var auth *proxy.Auth
		if u.User != nil {
			password, _ := u.User.Password()
			auth = &proxy.Auth{User: u.User.Username(), Password: password}
		}
		d, err := proxy.SOCKS5("tcp", u.Host, auth, &net.Dialer{Timeout: dialTimeout})
		if err != nil {
			return nil, fmt.Errorf("proxy: socks5 dialer: %w", err)
		}
		if cd, ok := d.(Dialer); ok {
			return cd, nil
		}
		return &socksContextDialer{d: d}, nil
	default:
		return nil, fmt.Errorf("proxy: unsupported upstream scheme %q", u.Scheme)
	}
}

// socksContextDialer adapts a proxy.Dialer without context support.
type socksContextDialer struct {
	d proxy.Dialer
}

// DialContext implements Dialer with best-effort cancellation.
func (s *socksContextDialer) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	type result struct {
		conn net.Conn
		err  error
	}
	done := make(chan result, 1)
	go func() {
		conn, err := s.d.Dial(network, address)
		if ctx.Err() != nil && conn != nil {
			_ = conn.Close()
			done <- result{nil, ctx.Err()}
			return
		}
		done <- result{conn, err}
	}()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case res := <-done:
		return res.conn, res.err
	}
}

// httpConnectDialer tunnels through an HTTP(S) proxy with CONNECT.
type httpConnectDialer struct {
	proxyURL *url.URL
	// tlsConfig overrides the defaults used to reach an https proxy. Nil means
	// system roots; only tests set it.
	tlsConfig *tls.Config
}

// DialContext implements Dialer.
func (d *httpConnectDialer) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	if network != "tcp" {
		return nil, fmt.Errorf("proxy: http connect supports tcp only, got %q", network)
	}

	dialCtx, cancel := context.WithTimeout(ctx, dialTimeout)
	defer cancel()

	var conn net.Conn
	var err error
	if strings.ToLower(d.proxyURL.Scheme) == "https" {
		tlsDialer := tls.Dialer{NetDialer: &net.Dialer{}, Config: d.tlsConfig}
		conn, err = tlsDialer.DialContext(dialCtx, "tcp", d.proxyURL.Host)
	} else {
		var nd net.Dialer
		conn, err = nd.DialContext(dialCtx, "tcp", d.proxyURL.Host)
	}
	if err != nil {
		return nil, fmt.Errorf("proxy: dial upstream proxy: %w", err)
	}

	// dialCtx covers only the dial; the CONNECT exchange needs its own bound
	// or a proxy that accepts and then stalls blocks this goroutine forever.
	if err := conn.SetDeadline(time.Now().Add(dialTimeout)); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("proxy: set connect deadline: %w", err)
	}

	req := &http.Request{
		Method: http.MethodConnect,
		URL:    &url.URL{Opaque: address},
		Host:   address,
		Header: http.Header{},
	}
	if d.proxyURL.User != nil {
		password, _ := d.proxyURL.User.Password()
		cred := d.proxyURL.User.Username() + ":" + password
		req.Header.Set("Proxy-Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(cred)))
	}
	if err := req.Write(conn); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("proxy: write connect: %w", err)
	}

	reader := bufio.NewReader(conn)
	resp, err := http.ReadResponse(reader, req)
	if err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("proxy: read connect response: %w", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		_ = conn.Close()
		return nil, fmt.Errorf("proxy: upstream connect failed: %s", resp.Status)
	}

	if err := conn.SetDeadline(time.Time{}); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("proxy: clear connect deadline: %w", err)
	}
	// The response reader may have pulled the target's first bytes into its
	// buffer along with the CONNECT reply, so replay them before the socket.
	if buffered := reader.Buffered(); buffered > 0 {
		return &replayConn{Conn: conn, reader: io.MultiReader(io.LimitReader(reader, int64(buffered)), conn)}, nil
	}
	return conn, nil
}

// replayConn serves buffered bytes ahead of the live connection. It forwards
// CloseWrite so the relay keeps propagating half-close.
type replayConn struct {
	net.Conn
	reader io.Reader
}

func (c *replayConn) Read(p []byte) (int, error) {
	return c.reader.Read(p)
}

func (c *replayConn) CloseWrite() error {
	if closer, ok := c.Conn.(interface{ CloseWrite() error }); ok {
		return closer.CloseWrite()
	}
	return c.Close()
}

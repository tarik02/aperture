package proxy

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/base64"
	"fmt"
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

// NewUpstreamDialer builds the dialer for a validated proxy assignment.
// Direct mode returns a DirectDialer; proxy mode returns a client for the
// generic upstream URL; tunnel mode is owned by the tunnel manager and
// returns an error here.
func NewUpstreamDialer(a Assignment) (Dialer, error) {
	switch a.NormalizedUpstream() {
	case UpstreamDirect:
		return DirectDialer{}, nil
	case UpstreamProxy:
		u, err := ParseUpstreamProxyURL(a.URL)
		if err != nil {
			return nil, err
		}
		return dialerForUpstreamURL(u)
	default:
		return nil, fmt.Errorf("proxy: upstream %q is not a static dialer", string(a.Upstream))
	}
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
		tlsDialer := tls.Dialer{NetDialer: &net.Dialer{}}
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

	resp, err := http.ReadResponse(bufio.NewReader(conn), req)
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
	return conn, nil
}

package proxy

import (
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"

	"github.com/coder/websocket"
)

// LocalTunnelSubprotocol names the local tunnel wire protocol: yamux over
// binary WebSocket messages, one SOCKS5 session per stream, the same stack as
// the outbound tunnel upstream.
const LocalTunnelSubprotocol = "aperture-tunnel.v1"

// maxLocalTunnelRoutes bounds the rules one local tunnel may declare.
const maxLocalTunnelRoutes = 64

// ErrNoLocalTunnelRoutes is returned when a local tunnel declares no routes.
var ErrNoLocalTunnelRoutes = errors.New("proxy: local tunnel needs at least one route")

// LocalTunnelRoute selects the browser connections a local tunnel carries.
// Host is "*" for every host, "*.example.test" for subdomains of
// example.test, or an exact hostname or IP address. Port 0 matches any port.
// The browser bypasses the proxy for loopback IPs, so a dev server is reached
// as localhost, never as 127.0.0.1 or [::1].
type LocalTunnelRoute struct {
	Host string
	Port uint16
}

// ParseLocalTunnelRoute parses "host", "host:port" or "[ipv6]:port".
func ParseLocalTunnelRoute(raw string) (LocalTunnelRoute, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return LocalTunnelRoute{}, errors.New("proxy: empty local tunnel route")
	}
	host, port := raw, uint16(0)
	if strings.HasPrefix(raw, "[") || strings.Count(raw, ":") == 1 {
		h, p, err := net.SplitHostPort(raw)
		if err != nil {
			return LocalTunnelRoute{}, fmt.Errorf("proxy: invalid local tunnel route %q: %w", raw, err)
		}
		parsed, err := strconv.ParseUint(p, 10, 16)
		if err != nil || parsed == 0 {
			return LocalTunnelRoute{}, fmt.Errorf("proxy: invalid port in local tunnel route %q", raw)
		}
		host, port = h, uint16(parsed)
	}
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	if host == "" || (strings.Contains(host, "*") && host != "*" && !isSubdomainWildcard(host)) {
		return LocalTunnelRoute{}, fmt.Errorf("proxy: invalid host in local tunnel route %q", raw)
	}
	return LocalTunnelRoute{Host: host, Port: port}, nil
}

// ParseLocalTunnelRoutes parses the routes a client declares when attaching.
func ParseLocalTunnelRoutes(raw []string) ([]LocalTunnelRoute, error) {
	if len(raw) == 0 {
		return nil, ErrNoLocalTunnelRoutes
	}
	if len(raw) > maxLocalTunnelRoutes {
		return nil, fmt.Errorf("proxy: a local tunnel accepts at most %d routes", maxLocalTunnelRoutes)
	}
	routes := make([]LocalTunnelRoute, 0, len(raw))
	for _, value := range raw {
		route, err := ParseLocalTunnelRoute(value)
		if err != nil {
			return nil, err
		}
		routes = append(routes, route)
	}
	return routes, nil
}

// String returns the route in the form it was declared.
func (r LocalTunnelRoute) String() string {
	if r.Port == 0 {
		return r.Host
	}
	return net.JoinHostPort(r.Host, strconv.Itoa(int(r.Port)))
}

// Matches reports whether a connection to target belongs to this route.
func (r LocalTunnelRoute) Matches(target Target) bool {
	if r.Port != 0 && r.Port != target.Port {
		return false
	}
	host := strings.ToLower(strings.TrimSuffix(target.Host, "."))
	switch {
	case r.Host == "*":
		return true
	case isSubdomainWildcard(r.Host):
		return strings.HasSuffix(host, r.Host[1:])
	default:
		return host == r.Host
	}
}

func isSubdomainWildcard(host string) bool {
	return strings.HasPrefix(host, "*.") && len(host) > 2 && !strings.Contains(host[2:], "*")
}

// isLocalhostName reports whether host is localhost or one of its subdomains,
// which browsers resolve to loopback without asking DNS.
func isLocalhostName(host string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	return host == "localhost" || strings.HasSuffix(host, ".localhost")
}

// LocalTunnel is a client-attached tunnel: the client dialed Aperture, and
// the wrapper opens a stream for each browser connection one of its routes
// matches.
type LocalTunnel struct {
	*Tunnel
	routes []LocalTunnelRoute
}

// NewLocalTunnel starts the tunnel protocol over a WebSocket the client opened.
func NewLocalTunnel(conn *websocket.Conn, routes []LocalTunnelRoute) (*LocalTunnel, error) {
	tunnel, err := newTunnel(conn)
	if err != nil {
		return nil, err
	}
	return &LocalTunnel{Tunnel: tunnel, routes: routes}, nil
}

// Routes returns the declared routes in their string form.
func (t *LocalTunnel) Routes() []string {
	routes := make([]string, len(t.routes))
	for i, route := range t.routes {
		routes[i] = route.String()
	}
	return routes
}

func (t *LocalTunnel) matches(target Target) bool {
	for _, route := range t.routes {
		if route.Matches(target) {
			return true
		}
	}
	return false
}

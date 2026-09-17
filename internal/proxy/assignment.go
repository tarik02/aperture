// Package proxy implements the always-on per-session egress proxy.
//
// Every browser session gets a session-local SOCKS5 server owned by its
// browser-session-wrapper. Chromium always points at it; this package dials
// upstream per connection: direct TCP, a generic upstream proxy URL, or a
// multiplexed yamux-over-WebSocket tunnel carrying SOCKS sessions verbatim.
package proxy

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
)

// Upstream selects how the local proxy server dials upstream for new connections.
type Upstream string

const (
	// UpstreamDirect dials the target TCP address itself.
	UpstreamDirect Upstream = "direct"
	// UpstreamProxy dials through a generic upstream proxy URL.
	UpstreamProxy Upstream = "proxy"
	// UpstreamTunnel relays the SOCKS session over a yamux-over-WebSocket tunnel.
	UpstreamTunnel Upstream = "tunnel"
)

// Assignment is one session's proxy configuration. It selects the upstream
// strategy for new connections; existing connections keep running.
type Assignment struct {
	Upstream Upstream
	// URL is the generic upstream proxy URL. Required when Upstream is proxy.
	URL string
	// TunnelURL is the compound tunnel endpoint. Required when Upstream is tunnel.
	TunnelURL string
	// TunnelAuth is the per-assignment bearer secret for the tunnel handshake.
	// Required when Upstream is tunnel. Never logged.
	TunnelAuth string
	// Bypass holds extra --proxy-bypass-list entries. Loopback is always bypassed.
	Bypass string
}

// DefaultAssignment preserves historical behavior: direct egress.
func DefaultAssignment() Assignment {
	return Assignment{Upstream: UpstreamDirect}
}

// Validate checks the assignment shape without performing any I/O.
func (a Assignment) Validate() error {
	switch a.Upstream {
	case "", UpstreamDirect:
		if strings.TrimSpace(a.URL) != "" {
			return errors.New("proxy url is only valid with upstream=proxy")
		}
		if strings.TrimSpace(a.TunnelURL) != "" || strings.TrimSpace(a.TunnelAuth) != "" {
			return errors.New("tunnel settings are only valid with upstream=tunnel")
		}
	case UpstreamProxy:
		if strings.TrimSpace(a.URL) == "" {
			return errors.New("proxy url is required with upstream=proxy")
		}
		if _, err := ParseUpstreamProxyURL(a.URL); err != nil {
			return err
		}
		if strings.TrimSpace(a.TunnelURL) != "" || strings.TrimSpace(a.TunnelAuth) != "" {
			return errors.New("tunnel settings are only valid with upstream=tunnel")
		}
	case UpstreamTunnel:
		if strings.TrimSpace(a.URL) != "" {
			return errors.New("proxy url is only valid with upstream=proxy")
		}
		if strings.TrimSpace(a.TunnelURL) == "" {
			return errors.New("tunnel url is required with upstream=tunnel")
		}
		if _, err := ParseTunnelURL(a.TunnelURL); err != nil {
			return err
		}
		if strings.TrimSpace(a.TunnelAuth) == "" {
			return errors.New("tunnel auth is required with upstream=tunnel")
		}
	default:
		return fmt.Errorf("unknown proxy upstream %q", string(a.Upstream))
	}
	return nil
}

// NormalizedUpstream returns the effective upstream, mapping "" to direct.
func (a Assignment) NormalizedUpstream() Upstream {
	if a.Upstream == "" {
		return UpstreamDirect
	}
	return a.Upstream
}

// Same reports whether two assignments select identical upstream behavior.
// Tunnel secrets compare by value so rotation is always detected.
func (a Assignment) Same(other Assignment) bool {
	return a.NormalizedUpstream() == other.NormalizedUpstream() &&
		strings.TrimSpace(a.URL) == strings.TrimSpace(other.URL) &&
		strings.TrimSpace(a.TunnelURL) == strings.TrimSpace(other.TunnelURL) &&
		a.TunnelAuth == other.TunnelAuth &&
		strings.TrimSpace(a.Bypass) == strings.TrimSpace(other.Bypass)
}

// defaultUpstreamPorts is the port assumed when an upstream proxy URL omits one.
var defaultUpstreamPorts = map[string]string{
	"http":    "80",
	"https":   "443",
	"socks":   "1080",
	"socks5":  "1080",
	"socks5h": "1080",
}

// ParseUpstreamProxyURL validates a generic upstream proxy URL and fills in the
// scheme's default port when none is given. Supported schemes are http, https,
// socks5, socks5h, and socks (alias for socks5). Userinfo carries the upstream
// credentials: http and https send them as Basic `Proxy-Authorization`, the
// socks schemes as RFC 1929 username/password.
func ParseUpstreamProxyURL(raw string) (*url.URL, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return nil, fmt.Errorf("invalid proxy url: %w", err)
	}
	scheme := strings.ToLower(u.Scheme)
	defaultPort, supported := defaultUpstreamPorts[scheme]
	if !supported {
		return nil, fmt.Errorf("unsupported proxy url scheme %q", u.Scheme)
	}
	if u.Hostname() == "" {
		return nil, fmt.Errorf("invalid proxy url %q: missing host", raw)
	}
	if u.User != nil && u.User.Username() == "" {
		return nil, fmt.Errorf("invalid proxy url %q: credentials must include a username", RedactedURL(raw))
	}
	if u.Port() == "" {
		u.Host = net.JoinHostPort(u.Hostname(), defaultPort)
	}
	return u, nil
}

// RedactedURL masks the password in an upstream proxy URL so it is safe for
// API responses and logs. Upstream credentials are write-only, like tunnel
// secrets: the username stays visible, the password never comes back out.
func RedactedURL(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	u, err := url.Parse(trimmed)
	if err != nil {
		return "<invalid proxy url>"
	}
	return u.Redacted()
}

// TunnelSchemePrefix is the separator between stack layers in a tunnel URL scheme.
const tunnelSchemeSeparator = "+"

// ParseTunnelURL validates a compound tunnel URL of the form
// ws+yamux+socks5://host/path or wss+yamux+socks5://host/path and returns
// the plain ws(s) dial endpoint. The scheme tokens must match exactly;
// anything else fails closed so a new stack can never silently half-work.
// Userinfo, query, and fragment are rejected to keep URLs canonical and log-safe.
func ParseTunnelURL(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	u, err := url.Parse(trimmed)
	if err != nil {
		return "", fmt.Errorf("invalid tunnel url: %w", err)
	}
	layers := strings.Split(strings.ToLower(u.Scheme), tunnelSchemeSeparator)
	if len(layers) != 3 || (layers[0] != "ws" && layers[0] != "wss") || layers[1] != "yamux" || layers[2] != "socks5" {
		return "", fmt.Errorf("unsupported tunnel url scheme %q: want ws+yamux+socks5 or wss+yamux+socks5", u.Scheme)
	}
	if u.User != nil {
		return "", errors.New("tunnel url must not contain userinfo")
	}
	if u.Host == "" {
		return "", fmt.Errorf("invalid tunnel url %q: missing host", trimmed)
	}
	if u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("tunnel url must not contain query or fragment")
	}
	dialURL := *u
	dialURL.Scheme = layers[0]
	return dialURL.String(), nil
}

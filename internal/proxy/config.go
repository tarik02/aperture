// Package proxy implements the always-on per-session egress proxy.
//
// Every browser session gets a session-local SOCKS5 server owned by its
// browser-session-wrapper. Chromium always points at it, and this package
// routes each connection by the session's rules: direct TCP, a generic
// upstream proxy, a multiplexed yamux-over-WebSocket tunnel to an operator, a
// client-attached local tunnel, or a refusal.
package proxy

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"reflect"
	"regexp"
	"strings"
)

// Reserved via values. Anything else names an upstream or is an inline
// upstream proxy URL.
const (
	// ViaDirect dials the target from the session host.
	ViaDirect = "direct"
	// ViaRefuse fails the connection.
	ViaRefuse = "refuse"
	// ViaLocal uses the attached local tunnel, failing when none is attached.
	ViaLocal = "local"
)

const (
	maxUpstreams = 32
	maxRules     = 256
)

var upstreamNamePattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,62}$`)

// Config is one session's proxy configuration. Rules are checked in order and
// the first whose match covers a connection decides its route; a connection
// no rule matches goes direct. Changing the configuration affects new
// connections only.
type Config struct {
	// Upstreams names the upstreams rules can route through.
	Upstreams map[string]UpstreamConfig `json:"upstreams,omitempty"`
	// Rules route connections, first match wins.
	Rules []Rule `json:"rules,omitempty"`
}

// UpstreamConfig is a named upstream: a generic proxy URL, with credentials as
// userinfo, or a compound tunnel URL with its bearer secret.
type UpstreamConfig struct {
	URL string `json:"url"`
	// Auth is the tunnel handshake's bearer secret. Required for a tunnel URL
	// and invalid otherwise. Never logged.
	Auth string `json:"auth,omitempty"`
}

// Rule routes the connections its match covers. Via is direct, refuse, local,
// an upstream name, or an inline upstream proxy URL.
type Rule struct {
	Match string `json:"match"`
	Via   string `json:"via"`
}

// IsTunnel reports whether the upstream is an outbound tunnel.
func (u UpstreamConfig) IsTunnel() bool {
	scheme, _, _ := strings.Cut(strings.TrimSpace(u.URL), "://")
	return strings.Contains(scheme, tunnelSchemeSeparator)
}

// Validate checks the configuration without performing any I/O.
func (c Config) Validate() error {
	if len(c.Upstreams) > maxUpstreams {
		return fmt.Errorf("at most %d proxy upstreams are allowed", maxUpstreams)
	}
	for name, upstream := range c.Upstreams {
		if !upstreamNamePattern.MatchString(name) {
			return fmt.Errorf("invalid proxy upstream name %q: use lowercase letters, digits and dashes", name)
		}
		if name == ViaDirect || name == ViaRefuse || name == ViaLocal {
			return fmt.Errorf("proxy upstream name %q is reserved", name)
		}
		if err := upstream.validate(); err != nil {
			return fmt.Errorf("proxy upstream %q: %w", name, err)
		}
	}
	if len(c.Rules) > maxRules {
		return fmt.Errorf("at most %d proxy rules are allowed", maxRules)
	}
	for i, rule := range c.Rules {
		if _, err := ParseHostPattern(rule.Match); err != nil {
			return fmt.Errorf("proxy rule %d: %w", i+1, err)
		}
		if err := c.validateVia(strings.TrimSpace(rule.Via)); err != nil {
			return fmt.Errorf("proxy rule %d: %w", i+1, err)
		}
	}
	return nil
}

func (u UpstreamConfig) validate() error {
	if strings.TrimSpace(u.URL) == "" {
		return errors.New("url is required")
	}
	if u.IsTunnel() {
		if _, err := ParseTunnelURL(u.URL); err != nil {
			return err
		}
		if strings.TrimSpace(u.Auth) == "" {
			return errors.New("auth is required for a tunnel url")
		}
		return nil
	}
	if _, err := ParseUpstreamProxyURL(u.URL); err != nil {
		return err
	}
	if u.Auth != "" {
		return errors.New("auth is only valid for a tunnel url; put proxy credentials in the url")
	}
	return nil
}

func (c Config) validateVia(via string) error {
	switch via {
	case "":
		return errors.New("via is required")
	case ViaDirect, ViaRefuse, ViaLocal:
		return nil
	}
	if _, ok := c.Upstreams[via]; ok {
		return nil
	}
	if !strings.Contains(via, "://") {
		return fmt.Errorf("unknown proxy upstream %q", via)
	}
	inline := UpstreamConfig{URL: via}
	if inline.IsTunnel() {
		return errors.New("a tunnel url needs auth, so declare it as a named upstream")
	}
	return inline.validate()
}

// Same reports whether two configurations route identically. Secrets compare
// by value, so a rotation is always detected.
func (c Config) Same(other Config) bool {
	return reflect.DeepEqual(c.normalized(), other.normalized())
}

func (c Config) normalized() Config {
	normalized := Config{}
	if len(c.Upstreams) > 0 {
		normalized.Upstreams = make(map[string]UpstreamConfig, len(c.Upstreams))
		for name, upstream := range c.Upstreams {
			normalized.Upstreams[name] = UpstreamConfig{URL: strings.TrimSpace(upstream.URL), Auth: upstream.Auth}
		}
	}
	for _, rule := range c.Rules {
		normalized.Rules = append(normalized.Rules, Rule{Match: strings.TrimSpace(rule.Match), Via: strings.TrimSpace(rule.Via)})
	}
	return normalized
}

// Redacted returns a copy that is safe to return or log: tunnel secrets are
// dropped and proxy URL passwords masked.
func (c Config) Redacted() Config {
	redacted := c.normalized()
	for name, upstream := range redacted.Upstreams {
		redacted.Upstreams[name] = UpstreamConfig{URL: RedactedURL(upstream.URL)}
	}
	for i, rule := range redacted.Rules {
		if strings.Contains(rule.Via, "://") {
			redacted.Rules[i].Via = RedactedURL(rule.Via)
		}
	}
	return redacted
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

package proxy

import (
	"errors"
	"fmt"
	"net"
	"regexp"
	"strconv"
	"strings"
)

// HostPattern is a rule's match: "*" for every host, "*.example.test" for
// subdomains of example.test, or an exact hostname or IP address, each
// optionally with a port. Port 0 matches any port.
//
// "*" never matches localhost: sending it to a catch-all upstream would reach
// the wrong machine, so only a pattern that names localhost routes it. The
// browser bypasses the proxy for loopback IPs, so it reaches local services as
// localhost, never as 127.0.0.1 or [::1].
type HostPattern struct {
	Host string
	Port uint16
}

// ParseHostPattern parses "host", "host:port" or "[ipv6]:port".
func ParseHostPattern(raw string) (HostPattern, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return HostPattern{}, errors.New("match is required")
	}
	host, port := raw, uint16(0)
	if strings.HasPrefix(raw, "[") || strings.Count(raw, ":") == 1 {
		h, p, err := net.SplitHostPort(raw)
		if err != nil {
			return HostPattern{}, fmt.Errorf("invalid match %q: %w", raw, err)
		}
		parsed, err := strconv.ParseUint(p, 10, 16)
		if err != nil || parsed == 0 {
			return HostPattern{}, fmt.Errorf("invalid port in match %q", raw)
		}
		host, port = h, uint16(parsed)
	}
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	if host == "" || (strings.Contains(host, "*") && host != "*" && !isSubdomainWildcard(host)) {
		return HostPattern{}, fmt.Errorf("invalid host in match %q", raw)
	}
	// CIDR ranges, Chromium's <local> and URLs would otherwise be accepted as
	// hostnames that never match.
	name := strings.TrimPrefix(host, "*.")
	if host != "*" && net.ParseIP(name) == nil && !hostnamePattern.MatchString(name) {
		return HostPattern{}, fmt.Errorf("invalid host in match %q", raw)
	}
	return HostPattern{Host: host, Port: port}, nil
}

var hostnamePattern = regexp.MustCompile(`^[a-z0-9_-]+(\.[a-z0-9_-]+)*$`)

// Matches reports whether a connection to target is covered by the pattern.
func (p HostPattern) Matches(target Target) bool {
	if p.Port != 0 && p.Port != target.Port {
		return false
	}
	host := strings.ToLower(strings.TrimSuffix(target.Host, "."))
	switch {
	case p.Host == "*":
		return !isLocalhostName(host)
	case isSubdomainWildcard(p.Host):
		return strings.HasSuffix(host, p.Host[1:])
	default:
		return host == p.Host
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

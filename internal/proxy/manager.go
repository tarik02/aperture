package proxy

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// tunnelIdleTimeout bounds how long a superseded tunnel stays open while its
// streams drain after a configuration swap.
const tunnelIdleTimeout = 5 * time.Minute

// tunnelDialTimeout bounds one tunnel dial so an unreachable operator cannot
// stall connections indefinitely.
const tunnelDialTimeout = 15 * time.Second

// operatorHandshakeTimeout bounds the SOCKS exchange with the operator once a
// tunnel stream is open.
const operatorHandshakeTimeout = 30 * time.Second

// errUpstreamSuperseded reports that an upstream changed while its tunnel was
// being dialed, so the freshly dialed tunnel is no longer wanted.
var errUpstreamSuperseded = errors.New("proxy: upstream superseded while dialing tunnel")

// ErrRefused is returned for connections a rule refuses.
var ErrRefused = errors.New("proxy: connection refused by rule")

// ErrNoLocalTunnel is returned for connections routed via local while no
// client is attached.
var ErrNoLocalTunnel = errors.New("proxy: no local tunnel attached")

// Stats is a point-in-time snapshot of manager activity for /status reporting.
type Stats struct {
	// Addr is the loopback SOCKS address Chromium uses.
	Addr string
	// Rules counts the configured routing rules.
	Rules int
	// ActiveConns counts downstream connections currently served.
	ActiveConns int64
	// TotalConns counts downstream connections served since start.
	TotalConns uint64
	// FailedConns counts connections that failed before relaying.
	FailedConns uint64
	// LocalTunnelAttached reports whether a client is attached.
	LocalTunnelAttached bool
}

type dialFunc func(ctx context.Context, target Target) (net.Conn, error)

// compiledRule is a rule with its match parsed.
type compiledRule struct {
	pattern HostPattern
	via     string
}

// Manager owns the session-local SOCKS5 listener and the routing rules. A
// configuration swap affects new connections only; existing connections keep
// running on the route they started with.
type Manager struct {
	sessionID string

	mu     sync.RWMutex
	config Config
	rules  []compiledRule
	// static holds the dialers of proxy upstreams, keyed by upstream name or
	// inline URL.
	static map[string]dialFunc
	// tunnels holds the live outbound tunnels, keyed by upstream name.
	tunnels map[string]map[*Tunnel]struct{}
	local   *LocalTunnel

	listener net.Listener
	ctx      context.Context
	cancel   context.CancelFunc
	wg       sync.WaitGroup

	activeConns int64
	totalConns  uint64
	failedConns uint64
}

// NewManager binds the loopback SOCKS5 listener (port 0, OS-assigned) and
// starts serving with the given configuration.
func NewManager(sessionID string, c Config) (*Manager, error) {
	if err := c.Validate(); err != nil {
		return nil, err
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("proxy: listen: %w", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	m := &Manager{
		sessionID: sessionID,
		tunnels:   make(map[string]map[*Tunnel]struct{}),
		listener:  ln,
		ctx:       ctx,
		cancel:    cancel,
	}
	m.setConfigLocked(c)
	m.wg.Add(1)
	go m.acceptLoop()
	return m, nil
}

// Addr returns the loopback address Chromium must use, e.g. 127.0.0.1:54321.
func (m *Manager) Addr() string {
	return m.listener.Addr().String()
}

// Close stops the listener and all tunnels, failing active connections.
func (m *Manager) Close() error {
	m.cancel()
	_ = m.listener.Close()
	m.mu.Lock()
	for _, set := range m.tunnels {
		for t := range set {
			_ = t.Close()
		}
	}
	m.tunnels = make(map[string]map[*Tunnel]struct{})
	if m.local != nil {
		_ = m.local.Close()
		m.local = nil
	}
	m.mu.Unlock()
	m.wg.Wait()
	return nil
}

// Apply swaps the configuration for new connections. Tunnels to an upstream
// whose settings are unchanged keep serving; superseded ones stay open until
// their streams drain or the idle timeout fires. Drain instead closes every
// outbound tunnel immediately, resetting live tunneled connections
// (hard-rotate). Applying an identical configuration without drain is a no-op.
// Direct, proxy and local tunnel connections are unaffected either way.
func (m *Manager) Apply(c Config, drain bool) error {
	if err := c.Validate(); err != nil {
		return err
	}
	m.mu.Lock()
	if m.config.Same(c) && !drain {
		m.mu.Unlock()
		return nil
	}
	previous := m.config
	previousTunnels := m.tunnels
	m.tunnels = make(map[string]map[*Tunnel]struct{})
	m.setConfigLocked(c)
	var retired []*Tunnel
	for name, set := range previousTunnels {
		upstream, kept := c.Upstreams[name]
		if kept && !drain && upstream == previous.Upstreams[name] {
			m.tunnels[name] = set
			continue
		}
		for t := range set {
			retired = append(retired, t)
		}
	}
	m.mu.Unlock()

	for _, t := range retired {
		if drain {
			go func() { _ = t.Close() }()
			continue
		}
		go t.Drain(tunnelIdleTimeout)
	}
	return nil
}

// setConfigLocked installs a validated configuration. Callers hold m.mu or
// own m exclusively.
func (m *Manager) setConfigLocked(c Config) {
	m.config = c
	m.rules = make([]compiledRule, 0, len(c.Rules))
	m.static = make(map[string]dialFunc)
	for _, rule := range c.Rules {
		pattern, _ := ParseHostPattern(rule.Match)
		via := strings.TrimSpace(rule.Via)
		m.rules = append(m.rules, compiledRule{pattern: pattern, via: via})
		if strings.Contains(via, "://") {
			m.static[via] = staticDialer(via)
		}
	}
	for name, upstream := range c.Upstreams {
		if !upstream.IsTunnel() {
			m.static[name] = staticDialer(upstream.URL)
		}
	}
}

func staticDialer(rawURL string) dialFunc {
	d, err := NewUpstreamDialer(rawURL)
	if err != nil {
		return func(context.Context, Target) (net.Conn, error) { return nil, err }
	}
	return func(ctx context.Context, target Target) (net.Conn, error) {
		return d.DialContext(ctx, "tcp", target.String())
	}
}

// Stats returns current counters for status reporting.
func (m *Manager) Stats() Stats {
	m.mu.RLock()
	rules := len(m.config.Rules)
	attached := m.local != nil
	m.mu.RUnlock()
	return Stats{
		Addr:                m.Addr(),
		Rules:               rules,
		ActiveConns:         atomic.LoadInt64(&m.activeConns),
		TotalConns:          atomic.LoadUint64(&m.totalConns),
		FailedConns:         atomic.LoadUint64(&m.failedConns),
		LocalTunnelAttached: attached,
	}
}

func (m *Manager) acceptLoop() {
	defer m.wg.Done()
	server := &Server{Handle: m.serveConn}
	for {
		conn, err := m.listener.Accept()
		if err != nil {
			select {
			case <-m.ctx.Done():
				return
			default:
				if errors.Is(err, net.ErrClosed) {
					return
				}
				continue
			}
		}
		atomic.AddInt64(&m.activeConns, 1)
		atomic.AddUint64(&m.totalConns, 1)
		go func() {
			defer atomic.AddInt64(&m.activeConns, -1)
			_ = server.ServeConn(m.ctx, conn)
		}()
	}
}

func (m *Manager) serveConn(ctx context.Context, downstream net.Conn, target Target, request []byte) {
	upstream, err := m.route(target)(ctx, target)
	if err != nil {
		atomic.AddUint64(&m.failedConns, 1)
		_, _ = downstream.Write(failureReply())
		return
	}

	// The operator terminates SOCKS for tunnel streams, so its CONNECT reply
	// is what the client gets. Static upstreams terminate SOCKS locally.
	if tunneled, ok := upstream.(tunnelStream); ok && tunneled.isTunnel {
		if err := handOffToOperator(upstream, request); err != nil {
			atomic.AddUint64(&m.failedConns, 1)
			_, _ = downstream.Write(failureReply())
			_ = upstream.Close()
			return
		}
	} else {
		if _, err := downstream.Write(SuccessReply()); err != nil {
			_ = upstream.Close()
			return
		}
	}

	_ = Relay(ctx, downstream, upstream)
}

// route picks the dialer for one connection: the first matching rule's, or
// direct when none matches.
func (m *Manager) route(target Target) dialFunc {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, rule := range m.rules {
		if rule.pattern.Matches(target) {
			return m.dialVia(rule.via)
		}
	}
	return dialDirect
}

// dialVia resolves a rule's via to a dialer. Callers hold m.mu for reading.
func (m *Manager) dialVia(via string) dialFunc {
	switch via {
	case ViaDirect:
		return dialDirect
	case ViaRefuse:
		return func(context.Context, Target) (net.Conn, error) { return nil, ErrRefused }
	case ViaLocal:
		local := m.local
		if local == nil {
			return func(context.Context, Target) (net.Conn, error) { return nil, ErrNoLocalTunnel }
		}
		return func(ctx context.Context, _ Target) (net.Conn, error) {
			return m.openLocalTunnelStream(ctx, local)
		}
	}
	if dial, ok := m.static[via]; ok {
		return dial
	}
	upstream := m.config.Upstreams[via]
	return func(ctx context.Context, _ Target) (net.Conn, error) {
		return m.openTunnelStream(ctx, via, upstream)
	}
}

// dialDirect dials the target from this machine. Subdomains of localhost
// resolve like localhost itself, as they do in the browser.
func dialDirect(ctx context.Context, target Target) (net.Conn, error) {
	if isLocalhostName(target.Host) {
		target.Host = "localhost"
	}
	var d net.Dialer
	return d.DialContext(ctx, "tcp", target.String())
}

// openLocalTunnelStream opens a stream on an attached local tunnel. A routed
// connection fails with the tunnel rather than falling back, so a dropped
// client never sends its hosts to a different destination.
func (m *Manager) openLocalTunnelStream(ctx context.Context, local *LocalTunnel) (net.Conn, error) {
	stream, err := local.OpenStream(ctx)
	if err != nil {
		if !local.Healthy() {
			m.DetachLocalTunnel(local)
		}
		return nil, err
	}
	return tunnelStream{Conn: stream, isTunnel: true}, nil
}

// AttachLocalTunnel routes via-local connections through a client-attached
// tunnel. A session has at most one; attaching replaces and closes the
// previous one, so a reconnecting client takes over from its stale tunnel.
func (m *Manager) AttachLocalTunnel(local *LocalTunnel) {
	m.mu.Lock()
	previous := m.local
	m.local = local
	m.mu.Unlock()
	if previous != nil {
		_ = previous.Close()
	}
}

// DetachLocalTunnel stops routing through local if it is still the attached
// tunnel, and closes it.
func (m *Manager) DetachLocalTunnel(local *LocalTunnel) {
	m.mu.Lock()
	if m.local == local {
		m.local = nil
	}
	m.mu.Unlock()
	_ = local.Close()
}

// handOffToOperator negotiates SOCKS no-auth on the client's behalf, then
// forwards the CONNECT request. Only the operator's reply reaches the client:
// the greeting was already answered locally when the request was parsed.
func handOffToOperator(upstream net.Conn, request []byte) error {
	_ = upstream.SetDeadline(time.Now().Add(operatorHandshakeTimeout))
	defer func() { _ = upstream.SetDeadline(time.Time{}) }()
	if err := negotiateNoAuth(upstream); err != nil {
		return err
	}
	_, err := upstream.Write(request)
	return err
}

// openTunnelStream opens a stream on the upstream's tunnel, dialing it on
// demand. A tunnel that has died since it was registered is evicted and
// redialed once, so a dropped WebSocket does not strand session egress.
func (m *Manager) openTunnelStream(ctx context.Context, name string, upstream UpstreamConfig) (net.Conn, error) {
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		t, err := m.tunnelFor(ctx, name, upstream)
		if err != nil {
			return nil, err
		}
		stream, err := t.OpenStream(ctx)
		if err == nil {
			return tunnelStream{Conn: stream, isTunnel: true}, nil
		}
		lastErr = err
		if t.Healthy() || ctx.Err() != nil {
			return nil, err
		}
		m.evictTunnel(name, t)
	}
	return nil, lastErr
}

// tunnelFor returns a live tunnel for the upstream, dialing one if needed.
// The dial runs outside the manager lock and under its own timeout: holding
// the lock across it would block every other connection, Apply, Stats and
// Close behind an unreachable operator.
func (m *Manager) tunnelFor(ctx context.Context, name string, upstream UpstreamConfig) (*Tunnel, error) {
	if t := m.healthyTunnel(name); t != nil {
		return t, nil
	}

	dialCtx, cancel := context.WithTimeout(ctx, tunnelDialTimeout)
	defer cancel()
	dialed, err := DialTunnel(dialCtx, m.sessionID, upstream.URL, upstream.Auth)
	if err != nil {
		return nil, err
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if current, ok := m.config.Upstreams[name]; !ok || current != upstream {
		go func() { _ = dialed.Close() }()
		return nil, errUpstreamSuperseded
	}
	set := m.tunnels[name]
	if set == nil {
		set = make(map[*Tunnel]struct{})
		m.tunnels[name] = set
	}
	// Another connection may have dialed while this one was in flight.
	for existing := range set {
		if existing.Healthy() {
			go func() { _ = dialed.Close() }()
			return existing, nil
		}
		delete(set, existing)
		go func() { _ = existing.Close() }()
	}
	set[dialed] = struct{}{}
	return dialed, nil
}

func (m *Manager) healthyTunnel(name string) *Tunnel {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for t := range m.tunnels[name] {
		if t.Healthy() {
			return t
		}
	}
	return nil
}

func (m *Manager) evictTunnel(name string, t *Tunnel) {
	m.mu.Lock()
	delete(m.tunnels[name], t)
	m.mu.Unlock()
	_ = t.Close()
}

// tunnelStream marks a conn as operator-terminated so the manager relays the
// handshake instead of writing a local SOCKS reply.
type tunnelStream struct {
	net.Conn
	isTunnel bool
}

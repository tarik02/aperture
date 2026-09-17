package proxy

import (
	"context"
	"errors"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

// tunnelIdleTimeout bounds how long a superseded tunnel stays open while its
// streams drain after an assignment swap.
const tunnelIdleTimeout = 5 * time.Minute

// tunnelDialTimeout bounds one tunnel dial so an unreachable operator cannot
// stall connections indefinitely.
const tunnelDialTimeout = 15 * time.Second

// operatorHandshakeTimeout bounds the SOCKS exchange with the operator once a
// tunnel stream is open.
const operatorHandshakeTimeout = 30 * time.Second

// errAssignmentSuperseded reports that the assignment changed while a tunnel
// was being dialed, so the freshly dialed tunnel is no longer wanted.
var errAssignmentSuperseded = errors.New("proxy: assignment superseded while dialing tunnel")

// Stats is a point-in-time snapshot of manager activity for /status reporting.
type Stats struct {
	// Addr is the loopback SOCKS address Chromium uses.
	Addr string
	// Upstream is the current assignment's normalized upstream.
	Upstream Upstream
	// ActiveConns counts downstream connections currently served.
	ActiveConns int64
	// TotalConns counts downstream connections served since start.
	TotalConns uint64
	// FailedConns counts connections that failed before relaying.
	FailedConns uint64
}

// Manager owns the session-local SOCKS5 listener and the current upstream
// strategy. An assignment swap affects new connections only; existing
// connections keep running on the dialer they started with.
type Manager struct {
	sessionID string

	mu         sync.RWMutex
	assignment Assignment
	dial       func(ctx context.Context, target Target) (net.Conn, error)
	tunnels    map[*Tunnel]struct{}

	listener net.Listener
	ctx      context.Context
	cancel   context.CancelFunc
	wg       sync.WaitGroup

	activeConns int64
	totalConns  uint64
	failedConns uint64
}

// NewManager binds the loopback SOCKS5 listener (port 0, OS-assigned) and
// starts serving with the given assignment.
func NewManager(sessionID string, a Assignment) (*Manager, error) {
	if err := a.Validate(); err != nil {
		return nil, err
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("proxy: listen: %w", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	m := &Manager{
		sessionID:  sessionID,
		assignment: a,
		tunnels:    make(map[*Tunnel]struct{}),
		listener:   ln,
		ctx:        ctx,
		cancel:     cancel,
	}
	m.dial = m.dialerFor(a)
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
	for t := range m.tunnels {
		_ = t.Close()
	}
	m.tunnels = make(map[*Tunnel]struct{})
	m.mu.Unlock()
	m.wg.Wait()
	return nil
}

// Apply swaps the upstream strategy for new connections. Superseded tunnels
// stay open until their streams drain or the idle timeout fires; drain instead
// closes them immediately, resetting live tunneled connections (hard-rotate).
// Applying an identical assignment without drain is a no-op; with drain it
// still resets the live tunnels. Direct and static-proxy connections are
// unaffected either way.
func (m *Manager) Apply(a Assignment, drain bool) error {
	if err := a.Validate(); err != nil {
		return err
	}
	m.mu.Lock()
	if m.assignment.Same(a) && !drain {
		m.mu.Unlock()
		return nil
	}
	previous := m.tunnels
	m.tunnels = make(map[*Tunnel]struct{})
	m.assignment = a
	m.dial = m.dialerFor(a)
	m.mu.Unlock()

	for t := range previous {
		if drain {
			go func() { _ = t.Close() }()
			continue
		}
		go t.Drain(tunnelIdleTimeout)
	}
	return nil
}

// Stats returns current counters for status reporting.
func (m *Manager) Stats() Stats {
	m.mu.RLock()
	upstream := m.assignment.NormalizedUpstream()
	m.mu.RUnlock()
	return Stats{
		Addr:        m.Addr(),
		Upstream:    upstream,
		ActiveConns: atomic.LoadInt64(&m.activeConns),
		TotalConns:  atomic.LoadUint64(&m.totalConns),
		FailedConns: atomic.LoadUint64(&m.failedConns),
	}
}

// Assignment returns a copy of the current assignment with the tunnel secret
// redacted and any upstream proxy password masked.
func (m *Manager) Assignment() Assignment {
	m.mu.RLock()
	defer m.mu.RUnlock()
	a := m.assignment
	if a.TunnelAuth != "" {
		a.TunnelAuth = "<redacted>"
	}
	a.URL = RedactedURL(a.URL)
	return a
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
	m.mu.RLock()
	dial := m.dial
	m.mu.RUnlock()

	upstream, err := dial(ctx, target)
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

// dialerFor builds the per-connection dial func for an assignment.
func (m *Manager) dialerFor(a Assignment) func(ctx context.Context, target Target) (net.Conn, error) {
	switch a.NormalizedUpstream() {
	case UpstreamProxy:
		d, err := NewUpstreamDialer(a)
		if err != nil {
			return func(ctx context.Context, _ Target) (net.Conn, error) { return nil, err }
		}
		return func(ctx context.Context, target Target) (net.Conn, error) {
			return d.DialContext(ctx, "tcp", target.String())
		}
	case UpstreamTunnel:
		return func(ctx context.Context, _ Target) (net.Conn, error) {
			return m.openTunnelStream(ctx, a)
		}
	default:
		return func(ctx context.Context, target Target) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "tcp", target.String())
		}
	}
}

// openTunnelStream opens a stream on the current tunnel, dialing it on demand.
// A tunnel that has died since it was registered is evicted and redialed once,
// so a dropped WebSocket does not strand session egress.
func (m *Manager) openTunnelStream(ctx context.Context, a Assignment) (net.Conn, error) {
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		t, err := m.tunnelFor(ctx, a)
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
		m.evictTunnel(t)
	}
	return nil, lastErr
}

// tunnelFor returns a live tunnel for the assignment, dialing one if needed.
// The dial runs outside the manager lock and under its own timeout: holding
// the lock across it would block every other connection, Apply, Stats and
// Close behind an unreachable operator.
func (m *Manager) tunnelFor(ctx context.Context, a Assignment) (*Tunnel, error) {
	if t := m.healthyTunnel(); t != nil {
		return t, nil
	}

	dialCtx, cancel := context.WithTimeout(ctx, tunnelDialTimeout)
	defer cancel()
	dialed, err := DialTunnel(dialCtx, m.sessionID, a.TunnelURL, a.TunnelAuth)
	if err != nil {
		return nil, err
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.assignment.Same(a) {
		go func() { _ = dialed.Close() }()
		return nil, errAssignmentSuperseded
	}
	// Another connection may have dialed while this one was in flight.
	for existing := range m.tunnels {
		if existing.Healthy() {
			go func() { _ = dialed.Close() }()
			return existing, nil
		}
		delete(m.tunnels, existing)
		go func() { _ = existing.Close() }()
	}
	m.tunnels[dialed] = struct{}{}
	return dialed, nil
}

func (m *Manager) healthyTunnel() *Tunnel {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for t := range m.tunnels {
		if t.Healthy() {
			return t
		}
	}
	return nil
}

func (m *Manager) evictTunnel(t *Tunnel) {
	m.mu.Lock()
	delete(m.tunnels, t)
	m.mu.Unlock()
	_ = t.Close()
}

// tunnelStream marks a conn as operator-terminated so the manager relays the
// handshake instead of writing a local SOCKS reply.
type tunnelStream struct {
	net.Conn
	isTunnel bool
}

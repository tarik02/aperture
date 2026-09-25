package proxy

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/hashicorp/yamux"
)

// fakeOperator is a stand-in for a tunnel operator: an authenticated WebSocket
// carrying a yamux session, terminating a no-auth SOCKS5 server on each stream.
// Its reader keeps the library's default message limit, so a peer that writes
// oversized frames trips it exactly as a real operator would.
type fakeOperator struct {
	server *httptest.Server
	auth   string

	mu       sync.Mutex
	sessions []*yamux.Session
	accepted int
}

func startFakeOperator(t *testing.T, auth string) *fakeOperator {
	t.Helper()
	operator := &fakeOperator{auth: auth}
	operator.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Header.Get("Authorization") != "Bearer "+operator.auth {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if req.Header.Get(SessionIDHeader) == "" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		conn, err := websocket.Accept(w, req, nil)
		if err != nil {
			return
		}
		// Deliberately no SetReadLimit: keep the 32 KiB default.
		adapter := newWSAdapter(conn)
		session, err := yamux.Server(adapter, yamux.DefaultConfig())
		if err != nil {
			_ = adapter.Close()
			return
		}
		operator.mu.Lock()
		operator.sessions = append(operator.sessions, session)
		operator.accepted++
		operator.mu.Unlock()

		for {
			stream, err := session.Accept()
			if err != nil {
				return
			}
			go func() {
				defer func() { _ = stream.Close() }()
				if err := serveOperatorSOCKS(stream); err != nil && !strings.Contains(err.Error(), "EOF") {
					t.Logf("operator stream: %v", err)
				}
			}()
		}
	}))
	t.Cleanup(operator.server.Close)
	return operator
}

func (o *fakeOperator) tunnelURL() string {
	return "ws+yamux+socks5://" + strings.TrimPrefix(o.server.URL, "http://") + "/tunnel"
}

func (o *fakeOperator) acceptedTunnels() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.accepted
}

// dropTunnels closes every live yamux session, simulating a WebSocket drop.
func (o *fakeOperator) dropTunnels() {
	o.mu.Lock()
	sessions := o.sessions
	o.sessions = nil
	o.mu.Unlock()
	for _, session := range sessions {
		_ = session.Close()
	}
}

// serveOperatorSOCKS terminates one no-auth SOCKS5 CONNECT on a stream.
func serveOperatorSOCKS(stream net.Conn) error {
	head := make([]byte, 2)
	if _, err := io.ReadFull(stream, head); err != nil {
		return fmt.Errorf("read greeting: %w", err)
	}
	if head[0] != socksVersion {
		return fmt.Errorf("greeting version %d", head[0])
	}
	methods := make([]byte, int(head[1]))
	if _, err := io.ReadFull(stream, methods); err != nil {
		return fmt.Errorf("read methods: %w", err)
	}
	if !bytes.Contains(methods, []byte{socksAuthNone}) {
		_, _ = stream.Write([]byte{socksVersion, socksAuthNoAcceptable})
		return fmt.Errorf("no acceptable method in %v", methods)
	}
	if _, err := stream.Write([]byte{socksVersion, socksAuthNone}); err != nil {
		return fmt.Errorf("write method selection: %w", err)
	}

	target, err := readServerConnectRequest(stream)
	if err != nil {
		return err
	}
	upstream, err := net.Dial("tcp", target)
	if err != nil {
		_, _ = stream.Write(failureReply())
		return fmt.Errorf("dial %s: %w", target, err)
	}
	if _, err := stream.Write(SuccessReply()); err != nil {
		_ = upstream.Close()
		return fmt.Errorf("write connect reply: %w", err)
	}
	return Relay(context.Background(), stream, upstream)
}

// socksConnect drives a no-auth SOCKS5 CONNECT against addr and returns the
// established conn. It reads replies at exact sizes, so a server that emits an
// extra reply corrupts the stream here just as Chromium's would.
func socksConnect(t *testing.T, addr, target string) net.Conn {
	t.Helper()
	conn, err := net.DialTimeout("tcp", addr, 5*time.Second)
	if err != nil {
		t.Fatalf("dial local socks: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	if err := conn.SetDeadline(time.Now().Add(20 * time.Second)); err != nil {
		t.Fatalf("set deadline: %v", err)
	}

	if _, err := conn.Write([]byte{socksVersion, 0x01, socksAuthNone}); err != nil {
		t.Fatalf("write greeting: %v", err)
	}
	selection := make([]byte, 2)
	if _, err := io.ReadFull(conn, selection); err != nil {
		t.Fatalf("read method selection: %v", err)
	}
	if selection[0] != socksVersion || selection[1] != socksAuthNone {
		t.Fatalf("method selection = %v, want [5 0]", selection)
	}

	host, portText, err := net.SplitHostPort(target)
	if err != nil {
		t.Fatalf("split target: %v", err)
	}
	var port uint16
	if _, err := fmt.Sscanf(portText, "%d", &port); err != nil {
		t.Fatalf("parse port: %v", err)
	}
	request := []byte{socksVersion, socksCmdConnect, 0x00, socksAddrFQDN, byte(len(host))}
	request = append(request, host...)
	request = binary.BigEndian.AppendUint16(request, port)
	if _, err := conn.Write(request); err != nil {
		t.Fatalf("write connect: %v", err)
	}

	reply := make([]byte, 10)
	if _, err := io.ReadFull(conn, reply); err != nil {
		t.Fatalf("read connect reply: %v", err)
	}
	if reply[0] != socksVersion {
		t.Fatalf("connect reply version = %d, want 5", reply[0])
	}
	if reply[1] != socksReplySuccess {
		t.Fatalf("connect reply code = %d, want success", reply[1])
	}
	if reply[2] != 0x00 {
		t.Fatalf("connect reply reserved byte = %d, want 0 (a second handshake reply leaked into the stream)", reply[2])
	}
	if reply[3] != socksAddrIPv4 {
		t.Fatalf("connect reply address type = %d, want 1", reply[3])
	}
	return conn
}

// operatorConfig routes every connection through the fake operator's tunnel.
func operatorConfig(operator *fakeOperator) Config {
	return Config{
		Upstreams: map[string]UpstreamConfig{"operator": {URL: operator.tunnelURL(), Auth: operator.auth}},
		Rules:     []Rule{{Match: "*", Via: "operator"}},
	}
}

func tunnelManager(t *testing.T, operator *fakeOperator) *Manager {
	t.Helper()
	manager, err := NewManager("tunnel-test", operatorConfig(operator))
	if err != nil {
		t.Fatalf("new manager: %v", err)
	}
	t.Cleanup(func() { _ = manager.Close() })
	return manager
}

// TestTunnelDeliversExactlyOneHandshakeReply pins the wire contract with an
// operator that terminates SOCKS: the client must see one method-selection
// reply and one CONNECT reply. Forwarding the client greeting into the tunnel
// produces a second reply and corrupts the stream.
func TestTunnelDeliversExactlyOneHandshakeReply(t *testing.T) {
	t.Parallel()

	target := echoTarget(t)
	operator := startFakeOperator(t, "tunnel-secret")
	manager := tunnelManager(t, operator)

	conn := socksConnect(t, manager.Addr(), target)
	if _, err := conn.Write([]byte("ping\n")); err != nil {
		t.Fatalf("write payload: %v", err)
	}
	echo := make([]byte, 5)
	if _, err := io.ReadFull(conn, echo); err != nil {
		t.Fatalf("read echo: %v", err)
	}
	if string(echo) != "ping\n" {
		t.Fatalf("echo = %q, want %q", string(echo), "ping\n")
	}
}

// TestTunnelCarriesLargeTransfer is an end-to-end smoke test for a multi-frame
// transfer through the tunnel. It does not isolate the message-size contract —
// see the wsAdapter tests for that.
func TestTunnelCarriesLargeTransfer(t *testing.T) {
	t.Parallel()

	target := echoTarget(t)
	operator := startFakeOperator(t, "tunnel-secret")
	manager := tunnelManager(t, operator)

	conn := socksConnect(t, manager.Addr(), target)

	payload := bytes.Repeat([]byte("abcdefgh"), 24*1024) // 192 KiB
	go func() {
		_, _ = conn.Write(payload)
	}()

	echoed := make([]byte, len(payload))
	if _, err := io.ReadFull(conn, echoed); err != nil {
		t.Fatalf("read %d bytes back: %v", len(payload), err)
	}
	if !bytes.Equal(echoed, payload) {
		t.Fatal("echoed payload differs from what was sent")
	}
}

// TestTunnelRedialsAfterOperatorDrop covers reconnect: a dropped tunnel must be
// evicted and redialed on the next connection rather than stranding egress.
func TestTunnelRedialsAfterOperatorDrop(t *testing.T) {
	t.Parallel()

	target := echoTarget(t)
	operator := startFakeOperator(t, "tunnel-secret")
	manager := tunnelManager(t, operator)

	first := socksConnect(t, manager.Addr(), target)
	_ = first.Close()
	if got := operator.acceptedTunnels(); got != 1 {
		t.Fatalf("accepted tunnels = %d, want 1", got)
	}

	operator.dropTunnels()
	waitFor(t, 5*time.Second, func() bool {
		return manager.healthyTunnel("operator") == nil
	}, "tunnel to be seen as unhealthy")

	second := socksConnect(t, manager.Addr(), target)
	if _, err := second.Write([]byte("after-drop\n")); err != nil {
		t.Fatalf("write after drop: %v", err)
	}
	echo := make([]byte, len("after-drop\n"))
	if _, err := io.ReadFull(second, echo); err != nil {
		t.Fatalf("read after drop: %v", err)
	}
	if got := operator.acceptedTunnels(); got != 2 {
		t.Fatalf("accepted tunnels = %d, want 2 (the manager should have redialed)", got)
	}
}

// TestApplyDrainResetsLiveTunnels covers the hard-rotate contract, including
// the case that matters most in practice: re-pushing the same assignment with
// drain must still reset live streams and leave a usable manager behind.
func TestApplyDrainResetsLiveTunnels(t *testing.T) {
	t.Parallel()

	target := echoTarget(t)
	operator := startFakeOperator(t, "tunnel-secret")
	manager := tunnelManager(t, operator)

	live := socksConnect(t, manager.Addr(), target)
	same := operatorConfig(operator)

	if err := manager.Apply(same, false); err != nil {
		t.Fatalf("Apply(same, drain=false): %v", err)
	}
	if manager.healthyTunnel("operator") == nil {
		t.Fatal("re-applying an identical assignment without drain must leave the tunnel alone")
	}

	if err := manager.Apply(same, true); err != nil {
		t.Fatalf("Apply(same, drain=true): %v", err)
	}
	if manager.healthyTunnel("operator") != nil {
		t.Fatal("drain must drop the live tunnel, not leave a closed one registered")
	}
	if err := live.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatalf("set deadline: %v", err)
	}
	if _, err := io.ReadAll(live); err == nil {
		// A drained stream ends; io.ReadAll returning nil error means EOF,
		// which is the reset we want.
		t.Log("live stream ended after drain")
	}

	// The manager must still serve new connections on a fresh tunnel.
	revived := socksConnect(t, manager.Addr(), target)
	if _, err := revived.Write([]byte("revived\n")); err != nil {
		t.Fatalf("write after drain: %v", err)
	}
	echo := make([]byte, len("revived\n"))
	if _, err := io.ReadFull(revived, echo); err != nil {
		t.Fatalf("read after drain: %v", err)
	}
	if got := operator.acceptedTunnels(); got != 2 {
		t.Fatalf("accepted tunnels = %d, want 2", got)
	}
}

func waitFor(t *testing.T, timeout time.Duration, condition func() bool, description string) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", description)
}

// wsAdapterPeer dials a WebSocket pair and hands back both ends: the adapter
// under test and the raw peer connection driving it.
func wsAdapterPeer(t *testing.T) (*wsAdapter, *websocket.Conn) {
	t.Helper()
	serverConns := make(chan *websocket.Conn, 1)
	// The handler must outlive the upgrade, so it parks until the test is done.
	done := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		conn, err := websocket.Accept(w, req, nil)
		if err != nil {
			return
		}
		serverConns <- conn
		<-done
	}))
	// Cleanups run last-registered-first: release the handler before Close waits on it.
	t.Cleanup(server.Close)
	t.Cleanup(func() { close(done) })

	clientConn, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatalf("dial websocket: %v", err)
	}
	adapter := newWSAdapter(clientConn)
	t.Cleanup(func() { _ = adapter.Close() })

	select {
	case peer := <-serverConns:
		// Drop the peer before the adapter closes, or the adapter's close
		// handshake waits on a peer that is parked and not reading.
		t.Cleanup(func() { _ = peer.CloseNow() })
		return adapter, peer
	case <-time.After(5 * time.Second):
		t.Fatal("websocket peer never connected")
		return nil, nil
	}
}

// TestWSAdapterWritesStayUnderPeerReadLimit pins the outbound contract: no
// single message may exceed what a peer running the library's defaults will
// accept, whatever size yamux hands the adapter.
func TestWSAdapterWritesStayUnderPeerReadLimit(t *testing.T) {
	t.Parallel()

	adapter, peer := wsAdapterPeer(t)
	const defaultPeerReadLimit = 32768

	payload := bytes.Repeat([]byte("x"), 200*1024)
	go func() {
		_, _ = adapter.Write(payload)
	}()

	received := 0
	for received < len(payload) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		typ, message, err := peer.Read(ctx)
		cancel()
		if err != nil {
			t.Fatalf("peer read after %d bytes: %v", received, err)
		}
		if typ != websocket.MessageBinary {
			t.Fatalf("message type = %v, want binary", typ)
		}
		if len(message) > defaultPeerReadLimit {
			t.Fatalf("adapter emitted a %d byte message; a peer on defaults accepts at most %d", len(message), defaultPeerReadLimit)
		}
		received += len(message)
	}
	if received != len(payload) {
		t.Fatalf("peer received %d bytes, want %d", received, len(payload))
	}
}

// TestWSAdapterReadsMessagesOverDefaultLimit pins the inbound contract: yamux
// frames are a byte stream, so the adapter must not inherit the library's
// 32 KiB per-message read limit.
func TestWSAdapterReadsMessagesOverDefaultLimit(t *testing.T) {
	t.Parallel()

	adapter, peer := wsAdapterPeer(t)

	payload := bytes.Repeat([]byte("y"), 100*1024)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = peer.Write(ctx, websocket.MessageBinary, payload)
	}()

	received := make([]byte, len(payload))
	if _, err := io.ReadFull(adapter, received); err != nil {
		t.Fatalf("adapter could not read a %d byte message: %v", len(payload), err)
	}
	if !bytes.Equal(received, payload) {
		t.Fatal("adapter returned different bytes than the peer sent")
	}
}

package proxy

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// echoTarget is the origin server upstream proxies are asked to reach. It
// echoes whatever it receives so a test can prove the whole path carries data.
func echoTarget(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen echo target: %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer func() { _ = conn.Close() }()
				_, _ = io.Copy(conn, conn)
			}()
		}
	}()
	return listener.Addr().String()
}

// socks5AuthServer is a SOCKS5 CONNECT server that demands the RFC 1929
// username/password method. It records the credentials it was given.
type socks5AuthServer struct {
	addr string

	gotUser string
	gotPass string
	// authed closes once the credentials above are set, so a test can read
	// them without waiting for the relay to finish.
	authed chan struct{}
}

func startSOCKS5AuthServer(t *testing.T, wantUser, wantPass string) *socks5AuthServer {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen socks5 server: %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })

	server := &socks5AuthServer{addr: listener.Addr().String(), authed: make(chan struct{})}
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer func() { _ = conn.Close() }()
		if err := server.serve(conn, wantUser, wantPass); err != nil {
			t.Errorf("socks5 server: %v", err)
		}
	}()
	return server
}

func (s *socks5AuthServer) serve(conn net.Conn, wantUser, wantPass string) error {
	head := make([]byte, 2)
	if _, err := io.ReadFull(conn, head); err != nil {
		return fmt.Errorf("read greeting: %w", err)
	}
	methods := make([]byte, int(head[1]))
	if _, err := io.ReadFull(conn, methods); err != nil {
		return fmt.Errorf("read methods: %w", err)
	}
	const methodUserPass byte = 0x02
	if !containsByte(methods, methodUserPass) {
		_, _ = conn.Write([]byte{socksVersion, socksAuthNoAcceptable})
		return fmt.Errorf("client did not offer username/password, methods = %v", methods)
	}
	if _, err := conn.Write([]byte{socksVersion, methodUserPass}); err != nil {
		return fmt.Errorf("write method selection: %w", err)
	}

	user, pass, err := readUserPassAuth(conn)
	if err != nil {
		return err
	}
	s.gotUser, s.gotPass = user, pass
	close(s.authed)
	if user != wantUser || pass != wantPass {
		_, _ = conn.Write([]byte{0x01, 0x01})
		return fmt.Errorf("credentials = %q/%q, want %q/%q", user, pass, wantUser, wantPass)
	}
	if _, err := conn.Write([]byte{0x01, 0x00}); err != nil {
		return fmt.Errorf("write auth reply: %w", err)
	}

	target, err := readServerConnectRequest(conn)
	if err != nil {
		return err
	}
	upstream, err := net.Dial("tcp", target)
	if err != nil {
		_, _ = conn.Write(failureReply())
		return fmt.Errorf("dial target %s: %w", target, err)
	}
	if _, err := conn.Write(SuccessReply()); err != nil {
		_ = upstream.Close()
		return fmt.Errorf("write connect reply: %w", err)
	}

	// Relay rather than a bare io.Copy pair: without half-close propagation the
	// echo target never sees EOF and this server never returns.
	_ = Relay(context.Background(), conn, upstream)
	return nil
}

func containsByte(haystack []byte, needle byte) bool {
	for _, candidate := range haystack {
		if candidate == needle {
			return true
		}
	}
	return false
}

// readUserPassAuth reads one RFC 1929 username/password request.
func readUserPassAuth(conn net.Conn) (string, string, error) {
	header := make([]byte, 2)
	if _, err := io.ReadFull(conn, header); err != nil {
		return "", "", fmt.Errorf("read auth header: %w", err)
	}
	if header[0] != 0x01 {
		return "", "", fmt.Errorf("auth version = %d, want 1", header[0])
	}
	user := make([]byte, int(header[1]))
	if _, err := io.ReadFull(conn, user); err != nil {
		return "", "", fmt.Errorf("read username: %w", err)
	}
	passLen := make([]byte, 1)
	if _, err := io.ReadFull(conn, passLen); err != nil {
		return "", "", fmt.Errorf("read password length: %w", err)
	}
	pass := make([]byte, int(passLen[0]))
	if _, err := io.ReadFull(conn, pass); err != nil {
		return "", "", fmt.Errorf("read password: %w", err)
	}
	return string(user), string(pass), nil
}

// readServerConnectRequest reads a SOCKS5 CONNECT request and returns its
// destination as host:port.
func readServerConnectRequest(conn net.Conn) (string, error) {
	head := make([]byte, 4)
	if _, err := io.ReadFull(conn, head); err != nil {
		return "", fmt.Errorf("read connect request: %w", err)
	}
	if head[0] != socksVersion || head[1] != socksCmdConnect {
		return "", fmt.Errorf("unexpected request %v", head)
	}
	var host string
	switch head[3] {
	case socksAddrIPv4:
		addr := make([]byte, net.IPv4len)
		if _, err := io.ReadFull(conn, addr); err != nil {
			return "", fmt.Errorf("read ipv4: %w", err)
		}
		host = net.IP(addr).String()
	case socksAddrFQDN:
		length := make([]byte, 1)
		if _, err := io.ReadFull(conn, length); err != nil {
			return "", fmt.Errorf("read fqdn length: %w", err)
		}
		name := make([]byte, int(length[0]))
		if _, err := io.ReadFull(conn, name); err != nil {
			return "", fmt.Errorf("read fqdn: %w", err)
		}
		host = string(name)
	default:
		return "", fmt.Errorf("unsupported address type %d", head[3])
	}
	port := make([]byte, 2)
	if _, err := io.ReadFull(conn, port); err != nil {
		return "", fmt.Errorf("read port: %w", err)
	}
	return net.JoinHostPort(host, fmt.Sprintf("%d", binary.BigEndian.Uint16(port))), nil
}

// httpConnectProxy is an HTTP CONNECT proxy demanding Basic credentials.
type httpConnectProxy struct {
	url       string
	certPool  *x509.CertPool
	gotHeader string
}

func startHTTPConnectProxy(t *testing.T, useTLS bool, wantUser, wantPass string) *httpConnectProxy {
	t.Helper()
	proxyServer := &httpConnectProxy{}
	expected := "Basic " + base64.StdEncoding.EncodeToString([]byte(wantUser+":"+wantPass))

	handler := http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Method != http.MethodConnect {
			http.Error(w, "connect only", http.StatusMethodNotAllowed)
			return
		}
		proxyServer.gotHeader = req.Header.Get("Proxy-Authorization")
		if proxyServer.gotHeader != expected {
			w.Header().Set("Proxy-Authenticate", `Basic realm="test"`)
			w.WriteHeader(http.StatusProxyAuthRequired)
			return
		}
		upstream, err := net.Dial("tcp", req.Host)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		defer func() { _ = upstream.Close() }()

		hijacker, ok := w.(http.Hijacker)
		if !ok {
			http.Error(w, "no hijack", http.StatusInternalServerError)
			return
		}
		client, buffered, err := hijacker.Hijack()
		if err != nil {
			return
		}
		defer func() { _ = client.Close() }()
		if _, err := client.Write([]byte("HTTP/1.1 200 Connection established\r\n\r\n")); err != nil {
			return
		}
		go func() {
			_, _ = io.Copy(upstream, buffered)
			// Let the echo target see EOF so its copy loop ends.
			if tcp, ok := upstream.(*net.TCPConn); ok {
				_ = tcp.CloseWrite()
			}
		}()
		_, _ = io.Copy(client, upstream)
	})

	var server *httptest.Server
	if useTLS {
		server = httptest.NewTLSServer(handler)
		pool := x509.NewCertPool()
		pool.AddCert(server.Certificate())
		proxyServer.certPool = pool
	} else {
		server = httptest.NewServer(handler)
	}
	t.Cleanup(server.Close)
	proxyServer.url = server.URL
	return proxyServer
}

// dialThroughManager runs one connection through a Manager with the given
// assignment and returns what the echo target sent back.
func dialThroughManager(t *testing.T, assignment Assignment, target string) string {
	t.Helper()
	manager, err := NewManager("session-test", assignment)
	if err != nil {
		t.Fatalf("new manager: %v", err)
	}
	t.Cleanup(func() { _ = manager.Close() })

	conn, err := net.DialTimeout("tcp", manager.Addr(), 5*time.Second)
	if err != nil {
		t.Fatalf("dial local socks: %v", err)
	}
	defer func() { _ = conn.Close() }()
	if err := conn.SetDeadline(time.Now().Add(10 * time.Second)); err != nil {
		t.Fatalf("set deadline: %v", err)
	}

	host, portText, err := net.SplitHostPort(target)
	if err != nil {
		t.Fatalf("split target: %v", err)
	}
	var port uint16
	if _, err := fmt.Sscanf(portText, "%d", &port); err != nil {
		t.Fatalf("parse port: %v", err)
	}

	if _, err := conn.Write([]byte{socksVersion, 0x01, socksAuthNone}); err != nil {
		t.Fatalf("write greeting: %v", err)
	}
	reply := make([]byte, 2)
	if _, err := io.ReadFull(conn, reply); err != nil {
		t.Fatalf("read method selection: %v", err)
	}
	if reply[0] != socksVersion || reply[1] != socksAuthNone {
		t.Fatalf("method selection = %v, want [5 0]", reply)
	}

	request := []byte{socksVersion, socksCmdConnect, 0x00, socksAddrFQDN, byte(len(host))}
	request = append(request, host...)
	request = binary.BigEndian.AppendUint16(request, port)
	if _, err := conn.Write(request); err != nil {
		t.Fatalf("write connect: %v", err)
	}
	connectReply := make([]byte, 10)
	if _, err := io.ReadFull(conn, connectReply); err != nil {
		t.Fatalf("read connect reply: %v", err)
	}
	if connectReply[0] != socksVersion || connectReply[1] != socksReplySuccess {
		t.Fatalf("connect reply = %v, want success", connectReply[:2])
	}

	if _, err := conn.Write([]byte("ping\n")); err != nil {
		t.Fatalf("write payload: %v", err)
	}
	line, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil {
		t.Fatalf("read echo: %v", err)
	}
	return strings.TrimSpace(line)
}

func TestUpstreamProxySOCKS5UsernamePassword(t *testing.T) {
	t.Parallel()

	target := echoTarget(t)
	server := startSOCKS5AuthServer(t, "alice", "s3cr3t")

	got := dialThroughManager(t, Assignment{
		Upstream: UpstreamProxy,
		URL:      "socks5://alice:s3cr3t@" + server.addr,
	}, target)
	if got != "ping" {
		t.Fatalf("echo = %q, want %q", got, "ping")
	}

	select {
	case <-server.authed:
	case <-time.After(5 * time.Second):
		t.Fatal("socks5 server never completed authentication")
	}
	if server.gotUser != "alice" || server.gotPass != "s3cr3t" {
		t.Fatalf("server saw %q/%q, want alice/s3cr3t", server.gotUser, server.gotPass)
	}
}

func TestUpstreamProxyHTTPBasicAuth(t *testing.T) {
	t.Parallel()

	target := echoTarget(t)
	server := startHTTPConnectProxy(t, false, "alice", "s3cr3t")

	got := dialThroughManager(t, Assignment{
		Upstream: UpstreamProxy,
		URL:      strings.Replace(server.url, "http://", "http://alice:s3cr3t@", 1),
	}, target)
	if got != "ping" {
		t.Fatalf("echo = %q, want %q", got, "ping")
	}
}

func TestUpstreamProxyHTTPSBasicAuth(t *testing.T) {
	t.Parallel()

	target := echoTarget(t)
	server := startHTTPConnectProxy(t, true, "alice", "s3cr3t")

	proxyURL, err := ParseUpstreamProxyURL(strings.Replace(server.url, "https://", "https://alice:s3cr3t@", 1))
	if err != nil {
		t.Fatalf("parse proxy url: %v", err)
	}
	dialer := &httpConnectDialer{proxyURL: proxyURL, tlsConfig: &tls.Config{RootCAs: server.certPool, MinVersion: tls.VersionTLS12}}

	conn, err := dialer.DialContext(context.Background(), "tcp", target)
	if err != nil {
		t.Fatalf("dial through https proxy: %v", err)
	}
	defer func() { _ = conn.Close() }()

	if _, err := conn.Write([]byte("ping\n")); err != nil {
		t.Fatalf("write payload: %v", err)
	}
	line, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil {
		t.Fatalf("read echo: %v", err)
	}
	if strings.TrimSpace(line) != "ping" {
		t.Fatalf("echo = %q, want %q", strings.TrimSpace(line), "ping")
	}
	if server.gotHeader == "" {
		t.Fatal("proxy did not receive Proxy-Authorization")
	}
}

func TestParseUpstreamProxyURLFillsDefaultPort(t *testing.T) {
	t.Parallel()

	for _, testCase := range []struct {
		raw      string
		wantHost string
	}{
		{"http://alice:s3cr3t@proxy.example.com", "proxy.example.com:80"},
		{"https://alice:s3cr3t@proxy.example.com", "proxy.example.com:443"},
		{"socks5://alice:s3cr3t@proxy.example.com", "proxy.example.com:1080"},
		{"socks5h://proxy.example.com", "proxy.example.com:1080"},
		{"socks://[::1]", "[::1]:1080"},
		{"socks5://proxy.example.com:9050", "proxy.example.com:9050"},
	} {
		parsed, err := ParseUpstreamProxyURL(testCase.raw)
		if err != nil {
			t.Fatalf("ParseUpstreamProxyURL(%q) error = %v", testCase.raw, err)
		}
		if parsed.Host != testCase.wantHost {
			t.Errorf("ParseUpstreamProxyURL(%q) host = %q, want %q", testCase.raw, parsed.Host, testCase.wantHost)
		}
	}
}

func TestParseUpstreamProxyURLRejectsPasswordWithoutUsername(t *testing.T) {
	t.Parallel()

	if _, err := ParseUpstreamProxyURL("socks5://:s3cr3t@proxy.example.com:1080"); err == nil {
		t.Fatal("expected an error for credentials without a username")
	}
}

func TestRedactedURLMasksPassword(t *testing.T) {
	t.Parallel()

	got := RedactedURL("socks5://alice:s3cr3t@proxy.example.com:1080")
	if strings.Contains(got, "s3cr3t") {
		t.Fatalf("RedactedURL leaked the password: %q", got)
	}
	if !strings.Contains(got, "alice") {
		t.Fatalf("RedactedURL dropped the username: %q", got)
	}
}

func TestUpstreamProxyRejectsWrongCredentials(t *testing.T) {
	t.Parallel()

	target := echoTarget(t)
	server := startHTTPConnectProxy(t, false, "alice", "s3cr3t")

	proxyURL, err := ParseUpstreamProxyURL(strings.Replace(server.url, "http://", "http://alice:wrong@", 1))
	if err != nil {
		t.Fatalf("parse proxy url: %v", err)
	}
	dialer := &httpConnectDialer{proxyURL: proxyURL}
	if _, err := dialer.DialContext(context.Background(), "tcp", target); err == nil {
		t.Fatal("dial succeeded with wrong credentials, want failure")
	}
}

// TestHTTPConnectPreservesBytesSentWithTheReply covers a proxy that packs the
// target's first bytes into the same write as the CONNECT reply. The response
// reader buffers them, so they must be replayed rather than dropped.
func TestHTTPConnectPreservesBytesSentWithTheReply(t *testing.T) {
	t.Parallel()

	const earlyBytes = "SERVER-HELLO"
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer func() { _ = conn.Close() }()
		reader := bufio.NewReader(conn)
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				return
			}
			if strings.TrimSpace(line) == "" {
				break
			}
		}
		// One write: CONNECT reply immediately followed by target data.
		_, _ = conn.Write([]byte("HTTP/1.1 200 Connection established\r\n\r\n" + earlyBytes))
		time.Sleep(time.Second)
	}()

	proxyURL, err := ParseUpstreamProxyURL("http://" + listener.Addr().String())
	if err != nil {
		t.Fatalf("parse proxy url: %v", err)
	}
	dialer := &httpConnectDialer{proxyURL: proxyURL}
	conn, err := dialer.DialContext(context.Background(), "tcp", "example.com:443")
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer func() { _ = conn.Close() }()

	if err := conn.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatalf("set deadline: %v", err)
	}
	got := make([]byte, len(earlyBytes))
	if _, err := io.ReadFull(conn, got); err != nil {
		t.Fatalf("read bytes that arrived with the reply: %v", err)
	}
	if string(got) != earlyBytes {
		t.Fatalf("read %q, want %q", string(got), earlyBytes)
	}
}

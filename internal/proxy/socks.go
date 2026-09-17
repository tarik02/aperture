package proxy

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
)

const (
	socksVersion byte = 0x05

	socksCmdConnect byte = 0x01

	socksAddrIPv4 byte = 0x01
	socksAddrFQDN byte = 0x03
	socksAddrIPv6 byte = 0x04

	socksReplySuccess byte = 0x00
	socksReplyFailure byte = 0x01

	socksAuthNone         byte = 0x00
	socksAuthNoAcceptable byte = 0xFF

	// maxSocksRequest bounds the CONNECT request bytes retained for relay.
	maxSocksRequest = 512
)

// Target is the destination of a SOCKS CONNECT request.
type Target struct {
	Host string
	Port uint16
}

// String returns the host:port form of the target.
func (t Target) String() string {
	return net.JoinHostPort(t.Host, fmt.Sprintf("%d", t.Port))
}

// ValidateTarget approves or rejects a connection target before dialing.
// A nil hook approves everything; allowing or rejecting a destination is
// otherwise the upstream's decision. Reserved for future local policy.
type ValidateTarget func(ctx context.Context, target Target) error

// ConnHandler receives an accepted downstream connection after method
// negotiation. Request holds the exact CONNECT request bytes consumed from
// downstream — the greeting is excluded, having already been answered locally
// — so a handler can forward the request to a peer that terminates SOCKS
// itself and let its reply flow back to the client.
type ConnHandler func(ctx context.Context, downstream net.Conn, target Target, request []byte)

// Server is a no-auth SOCKS5 server for the session-local listener.
// It implements CONNECT only; there is no UDP relay.
type Server struct {
	Validate ValidateTarget
	Handle   ConnHandler
}

// ServeConn serves one accepted downstream connection to completion.
func (s *Server) ServeConn(ctx context.Context, conn net.Conn) error {
	defer func() {
		_ = conn.Close()
	}()

	target, request, err := readConnectRequest(conn)
	if err != nil {
		return err
	}

	if s.Validate != nil {
		if err := s.Validate(ctx, target); err != nil {
			_, _ = conn.Write(failureReply())
			return err
		}
	}

	if s.Handle == nil {
		_, _ = conn.Write(failureReply())
		return errors.New("proxy: no connection handler")
	}

	s.Handle(ctx, conn, target, request)
	return nil
}

// readConnectRequest answers the client greeting locally, then parses the
// CONNECT request and returns its exact bytes for forwarding.
func readConnectRequest(conn net.Conn) (Target, []byte, error) {
	head := make([]byte, 2)
	if _, err := io.ReadFull(conn, head); err != nil {
		return Target{}, nil, err
	}
	if head[0] != socksVersion {
		return Target{}, nil, fmt.Errorf("proxy: unsupported socks version %d", head[0])
	}
	methods := make([]byte, int(head[1]))
	if _, err := io.ReadFull(conn, methods); err != nil {
		return Target{}, nil, err
	}
	if !bytes.Contains(methods, []byte{socksAuthNone}) {
		_, _ = conn.Write([]byte{socksVersion, socksAuthNoAcceptable})
		return Target{}, nil, errors.New("proxy: client offers no acceptable socks auth method")
	}
	if _, err := conn.Write([]byte{socksVersion, socksAuthNone}); err != nil {
		return Target{}, nil, err
	}

	// Only the CONNECT request is retained: the greeting has been answered
	// here, so forwarding it to a peer that also terminates SOCKS would make
	// the client see two method-selection replies.
	raw := make([]byte, 0, maxSocksRequest)

	read := func(n int) ([]byte, error) {
		buf := make([]byte, n)
		if _, err := io.ReadFull(conn, buf); err != nil {
			return nil, err
		}
		raw = append(raw, buf...)
		return buf, nil
	}

	req, err := read(4)
	if err != nil {
		return Target{}, nil, err
	}
	if req[0] != socksVersion {
		return Target{}, nil, fmt.Errorf("proxy: unsupported socks version %d", req[0])
	}
	if req[1] != socksCmdConnect {
		_, _ = conn.Write(failureReply())
		return Target{}, nil, fmt.Errorf("proxy: unsupported socks command %d", req[1])
	}

	var host string
	switch req[3] {
	case socksAddrIPv4:
		addr, err := read(net.IPv4len)
		if err != nil {
			return Target{}, nil, err
		}
		host = net.IP(addr).String()
	case socksAddrFQDN:
		lenBuf, err := read(1)
		if err != nil {
			return Target{}, nil, err
		}
		name, err := read(int(lenBuf[0]))
		if err != nil {
			return Target{}, nil, err
		}
		host = string(name)
	case socksAddrIPv6:
		addr, err := read(net.IPv6len)
		if err != nil {
			return Target{}, nil, err
		}
		host = net.IP(addr).String()
	default:
		_, _ = conn.Write(failureReply())
		return Target{}, nil, fmt.Errorf("proxy: unsupported socks address type %d", req[3])
	}

	portBuf, err := read(2)
	if err != nil {
		return Target{}, nil, err
	}

	return Target{Host: host, Port: binary.BigEndian.Uint16(portBuf)}, raw, nil
}

// negotiateNoAuth performs the client half of SOCKS5 method negotiation
// against a peer that terminates SOCKS, i.e. the tunnel operator.
func negotiateNoAuth(conn net.Conn) error {
	if _, err := conn.Write([]byte{socksVersion, 0x01, socksAuthNone}); err != nil {
		return fmt.Errorf("proxy: write socks greeting: %w", err)
	}
	reply := make([]byte, 2)
	if _, err := io.ReadFull(conn, reply); err != nil {
		return fmt.Errorf("proxy: read socks method selection: %w", err)
	}
	if reply[0] != socksVersion || reply[1] != socksAuthNone {
		return fmt.Errorf("proxy: peer selected socks version %d method %d", reply[0], reply[1])
	}
	return nil
}

// SuccessReply is the SOCKS success response written by whoever terminates
// SOCKS (the wrapper for direct/proxy upstreams; the operator for tunnels).
func SuccessReply() []byte {
	return []byte{socksVersion, socksReplySuccess, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00}
}

func failureReply() []byte {
	return []byte{socksVersion, socksReplyFailure, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00}
}

package session

import (
	"fmt"
	"net"
)

const (
	cdpPortMin = 19200
	cdpPortMax = 19999
)

// AllocateCDPPort finds an available loopback TCP port in the supervisor range.
func AllocateCDPPort() (int, error) {
	for port := cdpPortMin; port <= cdpPortMax; port++ {
		addr := fmt.Sprintf("127.0.0.1:%d", port)
		ln, err := net.Listen("tcp", addr)
		if err != nil {
			continue
		}
		_ = ln.Close()
		return port, nil
	}
	return 0, fmt.Errorf("no available cdp port in range %d-%d", cdpPortMin, cdpPortMax)
}

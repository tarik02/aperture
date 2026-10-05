package session

import (
	"context"
	"fmt"
	"net"
	"os"
	"sync"
	"time"

	"github.com/aperture/aperture/internal/browser"
	"github.com/aperture/aperture/internal/db"
)

const (
	cdpPortMin = 19200
	cdpPortMax = 19999
	// portClaimTTL covers a session from the moment its ports are handed out until its row keeps
	// them and its wrapper listens on them.
	portClaimTTL = 2 * time.Minute
)

// portAllocator hands out the loopback ports of session CDP and wrapper endpoints. A port is taken
// when something listens on it, when a session keeps it to wake on, or when it was handed out
// moments ago to a session whose wrapper is not listening yet: a bind check alone would give a
// suspended session's ports, or a starting session's, to another session.
type portAllocator struct {
	mu      sync.Mutex
	claimed map[int]time.Time
	now     func() time.Time
}

func newPortAllocator() *portAllocator {
	return &portAllocator{claimed: make(map[int]time.Time), now: time.Now}
}

// allocate returns count free ports and claims them.
func (a *portAllocator) allocate(reserved map[int]bool, count int) ([]int, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := a.now()
	for port, at := range a.claimed {
		if now.Sub(at) > portClaimTTL {
			delete(a.claimed, port)
		}
	}
	ports := make([]int, 0, count)
	for port := cdpPortMin; port <= cdpPortMax && len(ports) < count; port++ {
		if reserved[port] {
			continue
		}
		if _, claimed := a.claimed[port]; claimed {
			continue
		}
		ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			continue
		}
		_ = ln.Close()
		ports = append(ports, port)
	}
	if len(ports) < count {
		return nil, fmt.Errorf("no available port in range %d-%d", cdpPortMin, cdpPortMax)
	}
	for _, port := range ports {
		a.claimed[port] = now
	}
	return ports, nil
}

// free reports whether a port is neither listened on nor claimed by another start.
func (a *portAllocator) free(port int) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if at, claimed := a.claimed[port]; claimed && a.now().Sub(at) <= portClaimTTL {
		return false
	}
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return false
	}
	_ = ln.Close()
	return true
}

// allocatePorts hands out a CDP and a wrapper port that no other session keeps.
func (s *Service) allocatePorts(ctx context.Context, sessionID string) (int, int, error) {
	reserved, err := s.reservedPorts(ctx, sessionID)
	if err != nil {
		return 0, 0, err
	}
	ports, err := s.ports.allocate(reserved, 2)
	if err != nil {
		return 0, 0, err
	}
	return ports[0], ports[1], nil
}

// reservedPorts are the CDP and wrapper ports of every other session that keeps them.
func (s *Service) reservedPorts(ctx context.Context, exceptSessionID string) (map[int]bool, error) {
	sessions, err := s.repo.ListSessionsHoldingPorts(ctx)
	if err != nil {
		return nil, err
	}
	reserved := make(map[int]bool, 2*len(sessions))
	for _, other := range sessions {
		if other.ID == exceptSessionID || other.CurrentCDPPort == nil {
			continue
		}
		reserved[*other.CurrentCDPPort] = true
		if port := runtimeEnvWrapperPort(&other); port > 0 {
			reserved[port] = true
		}
	}
	return reserved, nil
}

// runtimeEnvWrapperPort reads the wrapper port a session's runtime env names; the database keeps
// only the CDP port.
func runtimeEnvWrapperPort(sessionRow *db.Session) int {
	if sessionRow.RuntimeEnvPath == nil {
		return 0
	}
	body, err := os.ReadFile(*sessionRow.RuntimeEnvPath)
	if err != nil {
		return 0
	}
	values, err := browser.ParseRuntimeEnv(body)
	if err != nil {
		return 0
	}
	return values.WrapperPort
}

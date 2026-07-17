package agentbrowser

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"go.uber.org/zap"
)

type Manager struct {
	idleTimeout time.Duration
	logger      *zap.Logger
	mu          sync.Mutex
	backends    map[string]*backend
	starting    map[string]*startup
}

type backend struct {
	session *mcp.ClientSession
	timer   *time.Timer
	active  int
}

type startup struct {
	done    chan struct{}
	cancel  context.CancelFunc
	backend *backend
	err     error
}

func NewManager(idleTimeout time.Duration, logger *zap.Logger) *Manager {
	if logger == nil {
		logger = zap.NewNop()
	}
	return &Manager{idleTimeout: idleTimeout, logger: logger, backends: make(map[string]*backend), starting: make(map[string]*startup)}
}

func (m *Manager) Call(ctx context.Context, sessionID, cdpURL, toolName string, arguments map[string]any) (*mcp.CallToolResult, error) {
	backend, err := m.backend(ctx, sessionID, cdpURL)
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	if m.backends[sessionID] != backend {
		m.mu.Unlock()
		return nil, fmt.Errorf("agent-browser backend is unavailable")
	}
	backend.active++
	if backend.timer != nil {
		backend.timer.Stop()
	}
	m.mu.Unlock()

	started := time.Now()
	result, err := backend.session.CallTool(ctx, &mcp.CallToolParams{Name: toolName, Arguments: arguments})
	status := "ok"
	if err != nil || (result != nil && result.IsError) {
		status = "error"
	}
	m.logger.Debug("agent-browser MCP call", zap.String("sessionID", sessionID), zap.String("tool", toolName), zap.Duration("duration", time.Since(started)), zap.String("status", status))

	m.mu.Lock()
	if current := m.backends[sessionID]; current == backend {
		backend.active--
		if backend.active == 0 {
			m.resetTimerLocked(sessionID, backend)
		}
	}
	m.mu.Unlock()
	if err != nil {
		m.evict(sessionID, backend)
	}
	return result, err
}

func (m *Manager) backend(ctx context.Context, sessionID, cdpURL string) (*backend, error) {
	m.mu.Lock()
	if existing := m.backends[sessionID]; existing != nil {
		m.mu.Unlock()
		return existing, nil
	}
	if pending := m.starting[sessionID]; pending != nil {
		m.mu.Unlock()
		select {
		case <-pending.done:
			return pending.backend, pending.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	startupCtx, cancel := context.WithCancel(ctx)
	pending := &startup{done: make(chan struct{}), cancel: cancel}
	m.starting[sessionID] = pending
	m.mu.Unlock()

	command := exec.Command("agent-browser", "mcp", "--tools", "all")
	command.Env = append(os.Environ(), "AGENT_BROWSER_SESSION=aperture-"+sessionID, "AGENT_BROWSER_CDP="+cdpURL)
	client := mcp.NewClient(&mcp.Implementation{Name: "aperture-agent-browser", Version: "1.0.0"}, nil)
	session, err := client.Connect(startupCtx, &mcp.CommandTransport{Command: command}, nil)
	if err != nil {
		err = fmt.Errorf("agent-browser backend startup failed: %w", err)
	}

	m.mu.Lock()
	stillStarting := m.starting[sessionID] == pending
	if stillStarting {
		delete(m.starting, sessionID)
	}
	if err == nil && stillStarting {
		if current := m.backends[sessionID]; current == nil {
			pending.backend = &backend{session: session}
			m.backends[sessionID] = pending.backend
			m.resetTimerLocked(sessionID, pending.backend)
		} else {
			pending.backend = current
		}
	} else if err != nil {
		pending.err = err
	} else {
		pending.err = fmt.Errorf("agent-browser backend is unavailable")
	}
	close(pending.done)
	m.mu.Unlock()
	cancel()
	if err != nil {
		return nil, err
	}
	if pending.backend == nil {
		_ = session.Close()
		return nil, pending.err
	}
	return pending.backend, nil
}

func (m *Manager) resetTimerLocked(sessionID string, backend *backend) {
	if backend.timer != nil {
		backend.timer.Stop()
	}
	backend.timer = time.AfterFunc(m.idleTimeout, func() {
		m.expire(sessionID, backend)
	})
}

func (m *Manager) expire(sessionID string, expected *backend) {
	m.mu.Lock()
	if current := m.backends[sessionID]; current != expected {
		m.mu.Unlock()
		return
	}
	if expected.active > 0 {
		m.resetTimerLocked(sessionID, expected)
		m.mu.Unlock()
		return
	}
	delete(m.backends, sessionID)
	if expected.timer != nil {
		expected.timer.Stop()
		expected.timer = nil
	}
	m.mu.Unlock()
	_ = expected.session.Close()
	m.logger.Debug("agent-browser MCP backend stopped", zap.String("sessionID", sessionID))
}

func (m *Manager) evict(sessionID string, expected *backend) {
	m.mu.Lock()
	if current := m.backends[sessionID]; current != expected {
		m.mu.Unlock()
		return
	}
	delete(m.backends, sessionID)
	if expected.timer != nil {
		expected.timer.Stop()
		expected.timer = nil
	}
	m.mu.Unlock()
	_ = expected.session.Close()
	m.logger.Debug("agent-browser MCP backend stopped", zap.String("sessionID", sessionID))
}

func (m *Manager) StopSession(sessionID string) {
	m.mu.Lock()
	backend := m.backends[sessionID]
	if backend != nil {
		delete(m.backends, sessionID)
		if backend.timer != nil {
			backend.timer.Stop()
			backend.timer = nil
		}
	}
	pending := m.starting[sessionID]
	if pending != nil {
		delete(m.starting, sessionID)
		pending.cancel()
	}
	m.mu.Unlock()
	if backend != nil {
		_ = backend.session.Close()
		m.logger.Debug("agent-browser MCP backend stopped", zap.String("sessionID", sessionID))
	}
}

func (m *Manager) CloseSessionMedia(sessionID string) {
	m.StopSession(sessionID)
}

func (m *Manager) Close() {
	m.mu.Lock()
	backends := m.backends
	m.backends = make(map[string]*backend)
	for _, backend := range backends {
		if backend.timer != nil {
			backend.timer.Stop()
			backend.timer = nil
		}
	}
	startups := m.starting
	m.starting = make(map[string]*startup)
	for _, pending := range startups {
		pending.cancel()
	}
	m.mu.Unlock()
	for sessionID, backend := range backends {
		_ = backend.session.Close()
		m.logger.Debug("agent-browser MCP backend stopped", zap.String("sessionID", sessionID))
	}
}

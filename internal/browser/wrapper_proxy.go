package browser

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/aperture/aperture/internal/proxy"
)

// proxyAssignmentRequest is the daemon-to-wrapper assignment push body.
type proxyAssignmentRequest struct {
	Upstream string `json:"upstream"`
	URL      string `json:"url"`
	Tunnel   struct {
		URL  string `json:"url"`
		Auth string `json:"auth"`
	} `json:"tunnel"`
	Bypass string `json:"bypass"`
	Drain  bool   `json:"drain"`
}

func (req proxyAssignmentRequest) assignment() proxy.Assignment {
	return proxy.Assignment{
		Upstream:   proxy.Upstream(strings.TrimSpace(req.Upstream)),
		URL:        strings.TrimSpace(req.URL),
		TunnelURL:  strings.TrimSpace(req.Tunnel.URL),
		TunnelAuth: req.Tunnel.Auth,
		Bypass:     strings.TrimSpace(req.Bypass),
	}
}

// proxyAssignmentFromValues builds the initial assignment from runtime env.
func proxyAssignmentFromValues(values RuntimeEnvValues) proxy.Assignment {
	return proxy.Assignment{
		Upstream:   proxy.Upstream(strings.TrimSpace(values.ProxyUpstream)),
		URL:        strings.TrimSpace(values.ProxyURL),
		TunnelURL:  strings.TrimSpace(values.ProxyTunnelURL),
		TunnelAuth: values.ProxyTunnelAuth,
		Bypass:     strings.TrimSpace(values.ProxyBypass),
	}
}

// startSessionProxy starts the always-on session-local SOCKS5 proxy.
func startSessionProxy(values RuntimeEnvValues) (*proxy.Manager, error) {
	assignment := proxyAssignmentFromValues(values)
	manager, err := proxy.NewManager(values.SessionID, assignment)
	if err != nil {
		return nil, fmt.Errorf("start session proxy: %w", err)
	}
	return manager, nil
}

// currentProxyManager returns the session proxy manager, if running.
func (r *wrapperRuntime) currentProxyManager() *proxy.Manager {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.proxyManager
}

// handleProxyAssignment applies a pushed proxy assignment for new connections.
func (r *wrapperRuntime) handleProxyAssignment(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if !r.wrapperControlAuthorized(req) {
		writeWrapperError(w, http.StatusUnauthorized, "wrapper control token required")
		return
	}
	manager := r.currentProxyManager()
	if manager == nil {
		writeWrapperError(w, http.StatusServiceUnavailable, "session proxy is not running")
		return
	}

	body, err := io.ReadAll(io.LimitReader(req.Body, 64*1024))
	if err != nil {
		writeWrapperError(w, http.StatusBadRequest, "read proxy assignment")
		return
	}
	var push proxyAssignmentRequest
	if err := json.Unmarshal(body, &push); err != nil {
		writeWrapperError(w, http.StatusBadRequest, "invalid proxy assignment")
		return
	}
	assignment := push.assignment()
	if err := assignment.Validate(); err != nil {
		writeWrapperError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := manager.Apply(assignment, push.Drain); err != nil {
		writeWrapperError(w, http.StatusBadRequest, err.Error())
		return
	}
	stats := manager.Stats()
	writeWrapperJSON(w, http.StatusOK, map[string]any{
		"address":     stats.Addr,
		"upstream":    string(stats.Upstream),
		"activeConns": stats.ActiveConns,
		"totalConns":  stats.TotalConns,
		"failedConns": stats.FailedConns,
	})
}

// proxyStatusFragmentLocked reports proxy counters for /status. Callers hold
// r.mu. It never includes secrets.
func (r *wrapperRuntime) proxyStatusFragmentLocked() map[string]any {
	manager := r.proxyManager
	if manager == nil {
		return map[string]any{"running": false}
	}
	stats := manager.Stats()
	return map[string]any{
		"running":     true,
		"address":     stats.Addr,
		"upstream":    string(stats.Upstream),
		"activeConns": stats.ActiveConns,
		"totalConns":  stats.TotalConns,
		"failedConns": stats.FailedConns,
	}
}

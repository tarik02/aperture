package browser

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/aperture/aperture/internal/proxy"
)

// ProxyConfigPush is the daemon-to-wrapper proxy configuration push body.
type ProxyConfigPush struct {
	Config proxy.Config `json:"config"`
	Drain  bool         `json:"drain"`
}

// startSessionProxy starts the always-on session-local SOCKS5 proxy.
func startSessionProxy(values RuntimeEnvValues) (*proxy.Manager, error) {
	manager, err := proxy.NewManager(values.SessionID, values.ProxyConfig)
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

// handleProxyConfig applies a pushed proxy configuration for new connections.
func (r *wrapperRuntime) handleProxyConfig(w http.ResponseWriter, req *http.Request) {
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

	body, err := io.ReadAll(io.LimitReader(req.Body, 256*1024))
	if err != nil {
		writeWrapperError(w, http.StatusBadRequest, "read proxy config")
		return
	}
	var push ProxyConfigPush
	if err := json.Unmarshal(body, &push); err != nil {
		writeWrapperError(w, http.StatusBadRequest, "invalid proxy config")
		return
	}
	if err := manager.Apply(push.Config, push.Drain); err != nil {
		writeWrapperError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeWrapperJSON(w, http.StatusOK, proxyStatus(manager.Stats()))
}

// proxyStatusFragmentLocked reports proxy counters for /status. Callers hold
// r.mu. It never includes secrets.
func (r *wrapperRuntime) proxyStatusFragmentLocked() map[string]any {
	manager := r.proxyManager
	if manager == nil {
		return map[string]any{"running": false}
	}
	status := proxyStatus(manager.Stats())
	status["running"] = true
	return status
}

func proxyStatus(stats proxy.Stats) map[string]any {
	return map[string]any{
		"address":             stats.Addr,
		"rules":               stats.Rules,
		"activeConns":         stats.ActiveConns,
		"totalConns":          stats.TotalConns,
		"failedConns":         stats.FailedConns,
		"localTunnelAttached": stats.LocalTunnelAttached,
	}
}

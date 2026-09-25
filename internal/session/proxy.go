package session

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/aperture/aperture/internal/browser"
	"github.com/aperture/aperture/internal/db"
	"github.com/aperture/aperture/internal/proxy"
)

// ProxyUpdateResult describes an applied proxy configuration change.
type ProxyUpdateResult struct {
	// Address is the session-local SOCKS address reported by the wrapper.
	Address string
	// Pushed is true when a running wrapper acknowledged the new configuration.
	// A persisted-but-unpushed update applies on next wake/start.
	Pushed bool
}

// ProxyConfigFromRow reads the stored proxy configuration from a session row.
// Tunnel secrets are included; callers must redact before responding.
func ProxyConfigFromRow(sessionRow *db.Session) proxy.Config {
	if sessionRow.ProxyConfig == nil {
		return proxy.Config{}
	}
	return *sessionRow.ProxyConfig
}

// applyProxyConfigToRow writes a configuration into a session row. The
// default configuration is stored as NULL.
func applyProxyConfigToRow(sessionRow *db.Session, config proxy.Config) {
	if len(config.Upstreams) == 0 && len(config.Rules) == 0 {
		sessionRow.ProxyConfig = nil
		return
	}
	sessionRow.ProxyConfig = &config
}

// UpdateProxy replaces a session's proxy configuration. The change is
// persisted and rewritten into the runtime env, then pushed to the running
// wrapper when the session is running. New connections use the new rules;
// existing connections finish on their route unless drain resets live tunnel
// streams.
func (s *Service) UpdateProxy(ctx context.Context, tenantID, sessionID string, config proxy.Config, drain bool) (ProxyUpdateResult, error) {
	if err := config.Validate(); err != nil {
		return ProxyUpdateResult{}, err
	}
	unlock := s.repo.LockSession(sessionID)
	defer unlock()

	sessionRow, err := s.requireTenantSession(ctx, tenantID, sessionID)
	if err != nil {
		return ProxyUpdateResult{}, err
	}
	switch sessionRow.Status {
	case db.SessionStatusCreating, db.SessionStatusRunning, db.SessionStatusSuspended:
	default:
		return ProxyUpdateResult{}, fmt.Errorf("%w: proxy update not allowed in status %q", ErrInvalidState, sessionRow.Status)
	}

	applyProxyConfigToRow(sessionRow, config)
	if err := s.repo.UpdateSession(ctx, sessionRow); err != nil {
		return ProxyUpdateResult{}, err
	}

	runtimeEnv, runtimePath, err := s.runtimeEnvForSession(ctx, sessionRow)
	if err != nil {
		return ProxyUpdateResult{}, err
	}
	if err := browser.WriteRuntimeEnv(runtimePath, runtimeEnv); err != nil {
		return ProxyUpdateResult{}, fmt.Errorf("write proxy runtime env: %w", err)
	}

	result := ProxyUpdateResult{}
	if sessionRow.Status != db.SessionStatusRunning {
		return result, nil
	}

	address, err := s.pushProxyConfig(ctx, sessionRow, config, drain)
	if err != nil {
		// The configuration is already persisted and written to the runtime
		// env, so failing the call would leave the caller believing nothing
		// changed while the next start uses the new rules. Record the
		// divergence instead and report the update as unpushed.
		if eventErr := s.appendEvent(ctx, sessionRow, "session.proxy_push_failed", "proxy configuration saved but not pushed to the running session", err); eventErr != nil {
			return result, eventErr
		}
		return result, nil
	}
	result.Address = address
	result.Pushed = true
	return result, nil
}

// pushProxyConfig delivers a configuration to the running wrapper's loopback
// API. The update is already persisted, so a push failure never loses it; the
// caller records the divergence and reports it as unpushed.
func (s *Service) pushProxyConfig(ctx context.Context, sessionRow *db.Session, config proxy.Config, drain bool) (string, error) {
	port, controlToken, err := wrapperControl(sessionRow)
	if err != nil {
		return "", fmt.Errorf("push proxy config: %w", err)
	}

	payload, err := json.Marshal(browser.ProxyConfigPush{Config: config, Drain: drain})
	if err != nil {
		return "", fmt.Errorf("push proxy config: %w", err)
	}

	pushCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(
		pushCtx,
		http.MethodPost,
		fmt.Sprintf("http://127.0.0.1:%d/proxy/config", port),
		bytes.NewReader(payload),
	)
	if err != nil {
		return "", fmt.Errorf("push proxy config: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+controlToken)

	response, err := (&http.Client{}).Do(request)
	if err != nil {
		return "", fmt.Errorf("push proxy config: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, 64*1024))
	if err != nil {
		return "", fmt.Errorf("push proxy config: %w", err)
	}
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("push proxy config: unexpected wrapper status %s", response.Status)
	}

	var summary struct {
		Address string `json:"address"`
	}
	if err := json.Unmarshal(responseBody, &summary); err != nil {
		return "", fmt.Errorf("push proxy config: %w", err)
	}
	return summary.Address, nil
}

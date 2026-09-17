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

// ProxyUpdateResult describes an applied proxy assignment change.
type ProxyUpdateResult struct {
	// Upstream is the normalized upstream in effect for new connections.
	Upstream string
	// Address is the session-local SOCKS address reported by the wrapper.
	Address string
	// Pushed is true when a running wrapper acknowledged the new assignment.
	// A persisted-but-unpushed update applies on next wake/start.
	Pushed bool
}

// proxyAssignmentFromRow reads the stored proxy assignment from a session row.
// Tunnel secrets are included; callers must redact before responding.
func proxyAssignmentFromRow(sessionRow *db.Session) proxy.Assignment {
	a := proxy.Assignment{Upstream: proxy.Upstream(sessionRow.ProxyUpstream)}
	if sessionRow.ProxyURL != nil {
		a.URL = *sessionRow.ProxyURL
	}
	if sessionRow.ProxyTunnelURL != nil {
		a.TunnelURL = *sessionRow.ProxyTunnelURL
	}
	if sessionRow.ProxyTunnelAuth != nil {
		a.TunnelAuth = *sessionRow.ProxyTunnelAuth
	}
	if sessionRow.ProxyBypass != nil {
		a.Bypass = *sessionRow.ProxyBypass
	}
	return a
}

// applyProxyAssignmentToRow writes an assignment into a session row.
func applyProxyAssignmentToRow(sessionRow *db.Session, a proxy.Assignment) {
	upstream := string(a.NormalizedUpstream())
	sessionRow.ProxyUpstream = upstream
	sessionRow.ProxyURL = optionalProxyString(a.URL)
	sessionRow.ProxyTunnelURL = optionalProxyString(a.TunnelURL)
	sessionRow.ProxyTunnelAuth = optionalProxySecret(a.TunnelAuth)
	sessionRow.ProxyBypass = optionalProxyString(a.Bypass)
}

func optionalProxyString(value string) *string {
	if value == "" {
		return nil
	}
	trimmed := value
	return &trimmed
}

func optionalProxySecret(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

// derefProxyString reads an optional proxy column back into runtime env form.
func derefProxyString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

// UpdateProxy replaces a session's proxy assignment. The change is persisted
// and rewritten into the runtime env, then pushed to the running wrapper when
// the session is running. New connections use the new assignment; existing
// connections finish on the old one unless drain resets live tunnel streams.
func (s *Service) UpdateProxy(ctx context.Context, tenantID, sessionID string, assignment proxy.Assignment, drain bool) (ProxyUpdateResult, error) {
	if err := assignment.Validate(); err != nil {
		return ProxyUpdateResult{}, err
	}

	sessionRow, err := s.requireTenantSession(ctx, tenantID, sessionID)
	if err != nil {
		return ProxyUpdateResult{}, err
	}
	switch sessionRow.Status {
	case db.SessionStatusCreating, db.SessionStatusRunning, db.SessionStatusSuspended:
	default:
		return ProxyUpdateResult{}, fmt.Errorf("%w: proxy update not allowed in status %q", ErrInvalidState, sessionRow.Status)
	}

	applyProxyAssignmentToRow(sessionRow, assignment)
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

	result := ProxyUpdateResult{Upstream: string(assignment.NormalizedUpstream())}
	if sessionRow.Status != db.SessionStatusRunning {
		return result, nil
	}

	address, err := s.pushProxyAssignment(ctx, sessionRow, assignment, drain)
	if err != nil {
		// The assignment is already persisted and written to the runtime env,
		// so failing the call would leave the caller believing nothing changed
		// while the next start uses the new assignment. Record the divergence
		// instead and report the update as unpushed.
		if eventErr := s.appendEvent(ctx, sessionRow, "session.proxy_push_failed", "proxy assignment saved but not pushed to the running session", err); eventErr != nil {
			return result, eventErr
		}
		return result, nil
	}
	result.Address = address
	result.Pushed = true
	return result, nil
}

type proxyPushTunnel struct {
	URL  string `json:"url"`
	Auth string `json:"auth"`
}

type proxyPushBody struct {
	Upstream string          `json:"upstream"`
	URL      string          `json:"url"`
	Tunnel   proxyPushTunnel `json:"tunnel"`
	Bypass   string          `json:"bypass"`
	Drain    bool            `json:"drain"`
}

// pushProxyAssignment delivers an assignment to the running wrapper's
// loopback API. The update is already persisted, so a push failure never
// loses it; the caller records the divergence and reports it as unpushed.
func (s *Service) pushProxyAssignment(ctx context.Context, sessionRow *db.Session, assignment proxy.Assignment, drain bool) (string, error) {
	port, controlToken, err := wrapperControl(sessionRow)
	if err != nil {
		return "", fmt.Errorf("push proxy assignment: %w", err)
	}

	body := proxyPushBody{
		Upstream: string(assignment.NormalizedUpstream()),
		URL:      assignment.URL,
		Tunnel:   proxyPushTunnel{URL: assignment.TunnelURL, Auth: assignment.TunnelAuth},
		Bypass:   assignment.Bypass,
		Drain:    drain,
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return "", fmt.Errorf("push proxy assignment: %w", err)
	}

	pushCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(
		pushCtx,
		http.MethodPost,
		fmt.Sprintf("http://127.0.0.1:%d/proxy/assignment", port),
		bytes.NewReader(payload),
	)
	if err != nil {
		return "", fmt.Errorf("push proxy assignment: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+controlToken)

	response, err := (&http.Client{}).Do(request)
	if err != nil {
		return "", fmt.Errorf("push proxy assignment: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, 64*1024))
	if err != nil {
		return "", fmt.Errorf("push proxy assignment: %w", err)
	}
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("push proxy assignment: unexpected wrapper status %s", response.Status)
	}

	var summary struct {
		Address string `json:"address"`
	}
	if err := json.Unmarshal(responseBody, &summary); err != nil {
		return "", fmt.Errorf("push proxy assignment: %w", err)
	}
	return summary.Address, nil
}

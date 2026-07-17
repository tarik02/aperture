package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aperture/aperture/internal/auth"
	"github.com/aperture/aperture/internal/db"
)

func (env *testEnv) doRaw(t *testing.T, method, path string, headers map[string]string, body any) *httptest.ResponseRecorder {
	t.Helper()

	var payload []byte
	if body != nil {
		var err error
		payload, err = json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal body: %v", err)
		}
	}

	req := httptest.NewRequest(method, path, bytes.NewReader(payload))
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	rec := httptest.NewRecorder()
	env.router.ServeHTTP(rec, req)
	return rec
}

func TestCDPForwardAuthRejectsMissingToken(t *testing.T) {
	t.Parallel()

	env := newSessionTestEnv(t)
	rec := env.doRaw(t, http.MethodGet, "/internal/forward-auth/cdp/session-1", nil, nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestCDPForwardAuthRejectsAuthorizationHeaderToken(t *testing.T) {
	t.Parallel()

	env := newSessionTestEnv(t)
	created := createRunningSessionForForwardAuth(t, env)

	rec := env.doRaw(t, http.MethodGet, "/internal/forward-auth/cdp/"+created.Session.ID, map[string]string{
		"Authorization": "Bearer " + created.SessionToken,
	}, nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestCDPForwardAuthAllowsPathToken(t *testing.T) {
	t.Parallel()

	env := newSessionTestEnv(t)
	created := createRunningSessionForForwardAuth(t, env)

	rec := env.doRaw(t, http.MethodGet, "/internal/forward-auth/cdp/"+created.Session.ID, map[string]string{
		"X-Forwarded-Uri": "/sessions/" + created.Session.ID + "/cdp/" + created.SessionToken + "/devtools/browser/test",
	}, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d, body = %s", rec.Code, http.StatusOK, rec.Body.String())
	}
}

func TestCDPForwardAuthRejectsQueryToken(t *testing.T) {
	t.Parallel()

	env := newSessionTestEnv(t)
	created := createRunningSessionForForwardAuth(t, env)

	rec := env.doRaw(t, http.MethodGet, "/internal/forward-auth/cdp/"+created.Session.ID, map[string]string{
		"X-Forwarded-Uri": "/sessions/" + created.Session.ID + "/cdp/devtools/browser/test?token=" + created.SessionToken,
	}, nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestCDPForwardAuthRejectsMismatchedSessionID(t *testing.T) {
	t.Parallel()

	env := newSessionTestEnv(t)
	created := createRunningSessionForForwardAuth(t, env)

	rec := env.doRaw(t, http.MethodGet, "/internal/forward-auth/cdp/other-session", map[string]string{
		"X-Forwarded-Uri": "/sessions/" + created.Session.ID + "/cdp/" + created.SessionToken + "/devtools/browser/test",
	}, nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestLiveSessionForwardAuthAllowsWebSocketProtocolToken(t *testing.T) {
	t.Parallel()

	env := newSessionTestEnv(t)
	created := createRunningSessionForForwardAuth(t, env)
	token, err := env.service.CreateToken(context.Background(), auth.CreateTokenInput{
		AuthorityType: auth.AuthorityTenant,
		TenantID:      &env.tenantID,
		Name:          "signal-forward-auth",
		Scopes:        []string{auth.ScopeSessionsWrite},
	})
	if err != nil {
		t.Fatalf("create token: %v", err)
	}

	rec := env.doRaw(t, http.MethodGet, "/internal/forward-auth/live-session/"+created.Session.ID+"/write", map[string]string{
		"Sec-WebSocket-Protocol": "aperture-webrtc.v1, authorization.bearer." + token.Raw,
	}, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d, body = %s", rec.Code, http.StatusOK, rec.Body.String())
	}
}

func TestCDPForwardAuthRejectsNonRunningSession(t *testing.T) {
	t.Parallel()

	env := newSessionTestEnv(t)
	created := createRunningSessionForForwardAuth(t, env)

	sessionRow, err := env.repo.GetSessionByID(context.Background(), created.Session.ID)
	if err != nil || sessionRow == nil {
		t.Fatalf("load session: %v", err)
	}
	sessionRow.Status = db.SessionStatusDeleted
	if err := env.repo.UpdateSession(context.Background(), sessionRow); err != nil {
		t.Fatalf("update session: %v", err)
	}

	rec := env.doRaw(t, http.MethodGet, "/internal/forward-auth/cdp/"+created.Session.ID, map[string]string{
		"X-Forwarded-Uri": "/sessions/" + created.Session.ID + "/cdp/" + created.SessionToken + "/devtools/browser/test",
	}, nil)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusConflict)
	}
}

func createRunningSessionForForwardAuth(t *testing.T, env *testEnv) createSessionResponse {
	t.Helper()

	token, err := env.service.CreateToken(context.Background(), auth.CreateTokenInput{
		AuthorityType: auth.AuthorityTenant,
		TenantID:      &env.tenantID,
		Name:          "sessions-forward-auth",
		Scopes:        []string{auth.ScopeSessionsWrite},
	})
	if err != nil {
		t.Fatalf("create token: %v", err)
	}

	rec := env.do(t, http.MethodPost, "/api/sessions", token.Raw, "", map[string]any{
		"browser": map[string]any{
			"channel": "chromium",
			"args":    []string{},
		},
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create session status = %d, body = %s", rec.Code, rec.Body.String())
	}

	var created createSessionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode create response: %v", err)
	}
	return created
}

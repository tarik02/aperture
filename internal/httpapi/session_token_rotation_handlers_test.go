package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/aperture/aperture/internal/auth"
)

func TestRotateSessionTokenHandler(t *testing.T) {
	t.Parallel()

	env := newSessionTestEnv(t)
	created := createRunningSessionForForwardAuth(t, env)

	token, err := env.service.CreateToken(context.Background(), auth.CreateTokenInput{
		AuthorityType: auth.AuthorityTenant,
		TenantID:      &env.tenantID,
		Name:          "sessions-rotate",
		Scopes:        []string{auth.ScopeSessionsWrite},
	})
	if err != nil {
		t.Fatalf("create token: %v", err)
	}

	rec := env.do(t, http.MethodPost, "/api/sessions/"+created.Session.ID+"/session-token/rotate", token.Raw, "", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("rotate status = %d, body = %s", rec.Code, rec.Body.String())
	}

	var rotated sessionMutationResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &rotated); err != nil {
		t.Fatalf("decode rotate response: %v", err)
	}
	if rotated.Session.Connection.SessionToken == "" || rotated.Session.Connection.SessionToken == created.Session.Connection.SessionToken {
		t.Fatalf("expected replacement token in response")
	}
	if rotated.Session.Connection.CDPURL != created.Session.Connection.CDPURL {
		t.Fatalf("cdp url changed: %q -> %q", created.Session.Connection.CDPURL, rotated.Session.Connection.CDPURL)
	}
}

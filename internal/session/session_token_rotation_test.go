package session

import (
	"context"
	"testing"
	"time"
)

func TestParseSessionToken(t *testing.T) {
	t.Parallel()

	sessionID := "018f1234-0000-7000-8000-000000000001"
	raw, _, err := GenerateSessionToken(sessionID)
	if err != nil {
		t.Fatalf("GenerateSessionToken() error = %v", err)
	}

	gotSessionID, secret, err := ParseSessionToken(raw)
	if err != nil {
		t.Fatalf("ParseSessionToken() error = %v", err)
	}
	if gotSessionID != sessionID {
		t.Fatalf("session id = %q, want %q", gotSessionID, sessionID)
	}
	if secret == "" {
		t.Fatal("expected secret material")
	}
}

func TestRotateSessionTokenReplacesTokenAndExtendsLease(t *testing.T) {
	t.Parallel()

	service, _, repo, _, _ := newTestService(t)
	tenantID := createTenant(t, repo)
	ctx := context.Background()

	created, err := service.Create(ctx, CreateInput{
		TenantID:       tenantID,
		BrowserChannel: "chromium",
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	originalToken := created.SessionToken
	originalExpiresAt := created.Session.ExpiresAt

	service.now = func() time.Time {
		return time.Date(2026, 7, 4, 12, 0, 0, 0, time.UTC)
	}

	rotated, err := service.RotateSessionToken(ctx, tenantID, created.Session.ID)
	if err != nil {
		t.Fatalf("RotateSessionToken() error = %v", err)
	}
	if rotated.SessionToken == "" || rotated.SessionToken == originalToken {
		t.Fatalf("expected replacement token, got %q", rotated.SessionToken)
	}
	if rotated.CDPURL != created.CDPURL {
		t.Fatalf("cdp url changed: %q -> %q", created.CDPURL, rotated.CDPURL)
	}
	if rotated.Session.Status != created.Session.Status {
		t.Fatalf("status = %q, want %q", rotated.Session.Status, created.Session.Status)
	}
	if rotated.Session.ExpiresAt == originalExpiresAt {
		t.Fatal("expected lease refresh on rotation")
	}

	tokenRow, err := repo.GetSessionToken(ctx, created.Session.ID)
	if err != nil {
		t.Fatalf("load session token: %v", err)
	}
	if tokenRow == nil || tokenRow.RawToken == nil || *tokenRow.RawToken != rotated.SessionToken {
		t.Fatalf("stored token mismatch")
	}

	if err := service.ValidateSessionTokenForwardAuth(ctx, created.Session.ID, "Bearer "+rotated.SessionToken); err != nil {
		t.Fatalf("ValidateSessionTokenForwardAuth(new token) error = %v", err)
	}
	if err := service.ValidateSessionTokenForwardAuth(ctx, created.Session.ID, "Bearer "+originalToken); err == nil {
		t.Fatal("expected old token to be rejected after rotation")
	}
}

func TestRotateSessionTokenRejectsExpiredSession(t *testing.T) {
	t.Parallel()

	service, _, repo, _, _ := newTestService(t)
	tenantID := createTenant(t, repo)
	ctx := context.Background()

	created, err := service.Create(ctx, CreateInput{
		TenantID:       tenantID,
		BrowserChannel: "chromium",
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	service.now = func() time.Time {
		return time.Date(2026, 7, 20, 12, 0, 0, 0, time.UTC)
	}
	if _, err := service.RotateSessionToken(ctx, tenantID, created.Session.ID); err == nil {
		t.Fatal("expected expired session rotation to fail")
	}
}

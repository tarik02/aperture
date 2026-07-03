package session

import (
	"context"
	"testing"
	"time"
)

func TestParseCDPToken(t *testing.T) {
	t.Parallel()

	sessionID := "018f1234-0000-7000-8000-000000000001"
	raw, _, err := GenerateCDPToken(sessionID)
	if err != nil {
		t.Fatalf("GenerateCDPToken() error = %v", err)
	}

	gotSessionID, secret, err := ParseCDPToken(raw)
	if err != nil {
		t.Fatalf("ParseCDPToken() error = %v", err)
	}
	if gotSessionID != sessionID {
		t.Fatalf("session id = %q, want %q", gotSessionID, sessionID)
	}
	if secret == "" {
		t.Fatal("expected secret material")
	}
}

func TestRotateCDPTokenReplacesTokenAndExtendsLease(t *testing.T) {
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
	originalToken := created.CDPToken
	originalExpiresAt := created.Session.ExpiresAt

	service.now = func() time.Time {
		return time.Date(2026, 7, 4, 12, 0, 0, 0, time.UTC)
	}

	rotated, err := service.RotateCDPToken(ctx, tenantID, created.Session.ID)
	if err != nil {
		t.Fatalf("RotateCDPToken() error = %v", err)
	}
	if rotated.CDPToken == "" || rotated.CDPToken == originalToken {
		t.Fatalf("expected replacement token, got %q", rotated.CDPToken)
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

	sealed, err := LoadCDPTokenSeal(service.cfg, created.Session.ID)
	if err != nil {
		t.Fatalf("LoadCDPTokenSeal() error = %v", err)
	}
	if sealed != rotated.CDPToken {
		t.Fatalf("sealed token mismatch")
	}

	if err := service.ValidateCDPForwardAuth(ctx, created.Session.ID, "Bearer "+rotated.CDPToken); err != nil {
		t.Fatalf("ValidateCDPForwardAuth(new token) error = %v", err)
	}
	if err := service.ValidateCDPForwardAuth(ctx, created.Session.ID, "Bearer "+originalToken); err == nil {
		t.Fatal("expected old token to be rejected after rotation")
	}
}

func TestRotateCDPTokenRejectsExpiredSession(t *testing.T) {
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
	if _, err := service.RotateCDPToken(ctx, tenantID, created.Session.ID); err == nil {
		t.Fatal("expected expired session rotation to fail")
	}
}

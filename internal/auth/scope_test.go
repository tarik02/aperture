package auth

import (
	"testing"
	"time"
)

func TestValidateScopesSystemAdmin(t *testing.T) {
	t.Parallel()

	if err := ValidateScopes(AuthoritySystemAdmin, []string{ScopeSystemAdmin}); err != nil {
		t.Fatalf("ValidateScopes() error = %v", err)
	}

	if err := ValidateScopes(AuthoritySystemAdmin, []string{ScopeSessionsRead}); err == nil {
		t.Fatal("expected system admin without system:admin scope to fail")
	}
}

func TestValidateScopesTenant(t *testing.T) {
	t.Parallel()

	if err := ValidateScopes(AuthorityTenant, []string{ScopeTenantWrite}); err != nil {
		t.Fatalf("ValidateScopes() error = %v", err)
	}

	if err := ValidateScopes(AuthorityTenant, []string{ScopeSystemAdmin}); err == nil {
		t.Fatal("expected tenant token with system:admin to fail")
	}

	if err := ValidateScopes(AuthorityTenant, []string{ScopeTenantsWrite}); err == nil {
		t.Fatal("expected tenant token with tenants:write to fail")
	}
}

func TestHasScope(t *testing.T) {
	t.Parallel()

	if !HasScope([]string{ScopeSystemAdmin}, ScopeSessionsWrite) {
		t.Fatal("system:admin should imply sessions:write")
	}
	if HasScope([]string{ScopeSessionsRead}, ScopeSessionsWrite) {
		t.Fatal("sessions:read should not imply sessions:write")
	}
}

func TestResolveTenantID(t *testing.T) {
	t.Parallel()

	tenantID := "018f1234-0000-7000-8000-000000000010"

	tenantPrincipal := Principal{
		AuthorityType: AuthorityTenant,
		TenantID:      &tenantID,
	}

	got, err := ResolveTenantID(tenantPrincipal, "")
	if err != nil {
		t.Fatalf("ResolveTenantID() error = %v", err)
	}
	if got != tenantID {
		t.Fatalf("tenant id = %q, want %q", got, tenantID)
	}

	if _, err := ResolveTenantID(tenantPrincipal, "other-tenant"); err == nil {
		t.Fatal("expected tenant override to be forbidden")
	}

	adminPrincipal := Principal{AuthorityType: AuthoritySystemAdmin}
	if _, err := ResolveTenantID(adminPrincipal, ""); err == nil {
		t.Fatal("expected system admin without header to require tenant")
	}

	got, err = ResolveTenantID(adminPrincipal, tenantID)
	if err != nil {
		t.Fatalf("ResolveTenantID() for admin error = %v", err)
	}
	if got != tenantID {
		t.Fatalf("tenant id = %q, want %q", got, tenantID)
	}
}

func TestIsExpiredAndRevoked(t *testing.T) {
	t.Parallel()

	past := "2020-01-01T00:00:00.000000000Z"
	future := "2099-01-01T00:00:00.000000000Z"

	if !IsExpired(&past, mustParseTime(t, "2025-01-01T00:00:00Z")) {
		t.Fatal("expected past timestamp to be expired")
	}
	if IsExpired(&future, mustParseTime(t, "2025-01-01T00:00:00Z")) {
		t.Fatal("expected future timestamp to be active")
	}
	if IsExpired(nil, mustParseTime(t, "2025-01-01T00:00:00Z")) {
		t.Fatal("nil expiresAt should not expire")
	}
	if !IsRevoked(&past) {
		t.Fatal("expected revoked token")
	}
	if IsRevoked(nil) {
		t.Fatal("nil revokedAt should not be revoked")
	}
}

func mustParseTime(t *testing.T, raw string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		t.Fatalf("parse time: %v", err)
	}
	return parsed
}

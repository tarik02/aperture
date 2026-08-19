package auth

import (
	"context"
	"encoding/json"
	"time"
)

type contextKey int

const principalContextKey contextKey = iota

const (
	PrincipalTypeAPIToken = "api_token"
	PrincipalTypeUser     = "user"
	PrincipalTypeSystem   = "system"
	AuthMethodAPIToken    = "api_token"
)

// Principal holds authenticated API token state for a request.
type Principal struct {
	Type          string
	ID            string
	AuthMethod    string
	TokenID       string
	UserID        *string
	AuthorityType string
	TenantID      *string
	Name          string
	Scopes        []string
	ExpiresAt     *string
}

// WithPrincipal stores principal on ctx.
func WithPrincipal(ctx context.Context, principal Principal) context.Context {
	return context.WithValue(ctx, principalContextKey, principal)
}

// PrincipalFromContext returns the authenticated principal.
func PrincipalFromContext(ctx context.Context) (Principal, bool) {
	principal, ok := ctx.Value(principalContextKey).(Principal)
	return principal, ok
}

// TenantHeader is the HTTP header used for explicit tenant selection.
const TenantHeader = "X-Aperture-Tenant-Id"

// ResolveTenantID returns the effective tenant id for a tenant-scoped operation.
func ResolveTenantID(principal Principal, selectedTenantID string) (string, error) {
	switch principal.AuthorityType {
	case AuthorityTenant:
		if principal.TenantID == nil {
			return "", ErrTenantNotFound
		}
		if selectedTenantID != "" && selectedTenantID != *principal.TenantID {
			return "", ErrTenantForbidden
		}
		return *principal.TenantID, nil
	case AuthoritySystemAdmin:
		if selectedTenantID == "" {
			return "", ErrTenantRequired
		}
		return selectedTenantID, nil
	default:
		return "", ErrInvalidAuthority
	}
}

// MarshalScopesJSON encodes scopes for storage.
func MarshalScopesJSON(scopes []string) (string, error) {
	data, err := json.Marshal(scopes)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// ParseScopesJSON decodes stored scopes.
func ParseScopesJSON(raw string) ([]string, error) {
	var scopes []string
	if err := json.Unmarshal([]byte(raw), &scopes); err != nil {
		return nil, err
	}
	return scopes, nil
}

// FormatExpiresAt converts optional duration to RFC3339Nano or nil.
func FormatExpiresAt(expiresAt *time.Time) *string {
	if expiresAt == nil {
		return nil
	}
	formatted := expiresAt.UTC().Format(time.RFC3339Nano)
	return &formatted
}

// IsExpired reports whether expiresAt is in the past.
func IsExpired(expiresAt *string, now time.Time) bool {
	if expiresAt == nil {
		return false
	}
	parsed, err := time.Parse(time.RFC3339Nano, *expiresAt)
	if err != nil {
		return true
	}
	return now.After(parsed)
}

// IsRevoked reports whether revokedAt is set.
func IsRevoked(revokedAt *string) bool {
	return revokedAt != nil
}

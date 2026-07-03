package auth

import "slices"

const (
	ScopeSystemAdmin    = "system:admin"
	ScopeSessionsRead   = "sessions:read"
	ScopeSessionsWrite  = "sessions:write"
	ScopeSnapshotsRead  = "snapshots:read"
	ScopeSnapshotsWrite = "snapshots:write"
	ScopeTenantWrite    = "tenant:write"
	ScopeTenantsWrite   = "tenants:write"
)

var allScopes = []string{
	ScopeSystemAdmin,
	ScopeSessionsRead,
	ScopeSessionsWrite,
	ScopeSnapshotsRead,
	ScopeSnapshotsWrite,
	ScopeTenantWrite,
	ScopeTenantsWrite,
}

// ValidateScopes ensures every scope is known and authority constraints hold.
func ValidateScopes(authorityType string, scopes []string) error {
	if len(scopes) == 0 {
		return ErrInvalidScopes
	}

	seen := make(map[string]struct{}, len(scopes))
	for _, scope := range scopes {
		if !slices.Contains(allScopes, scope) {
			return ErrInvalidScopes
		}
		if _, dup := seen[scope]; dup {
			return ErrInvalidScopes
		}
		seen[scope] = struct{}{}
	}

	switch authorityType {
	case AuthoritySystemAdmin:
		if !slices.Contains(scopes, ScopeSystemAdmin) {
			return ErrInvalidScopes
		}
	case AuthorityTenant:
		if slices.Contains(scopes, ScopeSystemAdmin) || slices.Contains(scopes, ScopeTenantsWrite) {
			return ErrTenantTokenCrossScope
		}
	default:
		return ErrInvalidAuthority
	}

	return nil
}

// HasScope reports whether principalScopes includes required.
func HasScope(principalScopes []string, required string) bool {
	if slices.Contains(principalScopes, ScopeSystemAdmin) {
		return true
	}
	return slices.Contains(principalScopes, required)
}

// HasAllScopes reports whether principalScopes includes every required scope.
func HasAllScopes(principalScopes []string, required ...string) bool {
	for _, scope := range required {
		if !HasScope(principalScopes, scope) {
			return false
		}
	}
	return true
}

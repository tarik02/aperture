package auth

import (
	"context"
	"encoding/json"
	"slices"
	"time"
)

type contextKey int

const principalContextKey contextKey = iota

const (
	PrincipalTypeAPIToken = "api_token"
	PrincipalTypeUser     = "user"
	PrincipalTypeSystem   = "system"
	AuthMethodAPIToken    = "api_token"
	ResourceModeAll       = "all"
	ResourceModeAllowlist = "allowlist"
	ResourceTypeSession   = "session"
	ResourceTypeSnapshot  = "snapshot"
)

// ResourceGrant allows access to one tenant resource.
type ResourceGrant struct {
	ResourceType string `json:"resourceType"`
	ResourceID   string `json:"resourceId"`
}

// TenantGrant holds a principal's effective scopes in one tenant.
type TenantGrant struct {
	TenantID string
	Scopes   []string
}

// Principal holds authenticated identity and authority state for a request.
type Principal struct {
	Type           string
	ID             string
	AuthMethod     string
	TokenID        string
	OAuthGrantID   string
	UserID         *string
	AuthorityType  string
	TenantID       *string
	Name           string
	Scopes         []string
	ResourceMode   string
	ResourceGrants []ResourceGrant
	ExpiresAt      *string
	// TenantGrants lists every tenant a multi-tenant principal may select.
	// Until SelectTenant picks one, TenantID is nil and Scopes is empty.
	TenantGrants []TenantGrant
}

// SelectTenant narrows a multi-tenant principal to one of its tenants. An
// empty tenantID selects the only tenant when there is exactly one.
// Principals without tenant grants are returned unchanged.
func SelectTenant(principal Principal, tenantID string) (Principal, error) {
	if len(principal.TenantGrants) == 0 {
		return principal, nil
	}
	if tenantID == "" {
		if len(principal.TenantGrants) != 1 {
			return principal, ErrTenantRequired
		}
		tenantID = principal.TenantGrants[0].TenantID
	}
	for _, grant := range principal.TenantGrants {
		if grant.TenantID == tenantID {
			principal.TenantID = &grant.TenantID
			principal.Scopes = slices.Clone(grant.Scopes)
			return principal, nil
		}
	}
	return principal, ErrTenantForbidden
}

// HasScopeInAnyTenant reports whether a principal holds scope directly or in any selectable tenant.
func HasScopeInAnyTenant(principal Principal, scope string) bool {
	if HasScope(principal.Scopes, scope) {
		return true
	}
	for _, grant := range principal.TenantGrants {
		if HasScope(grant.Scopes, scope) {
			return true
		}
	}
	return false
}

// IsResourceRestricted reports whether a principal uses an explicit allowlist.
func IsResourceRestricted(principal Principal) bool {
	return principal.ResourceMode == ResourceModeAllowlist
}

// HasResourceAccess reports whether a principal may access a resource id.
func HasResourceAccess(principal Principal, resourceType, resourceID string) bool {
	if !IsResourceRestricted(principal) {
		return true
	}
	for _, grant := range principal.ResourceGrants {
		if grant.ResourceType == resourceType && grant.ResourceID == resourceID {
			return true
		}
	}
	return false
}

// ResourceIDs returns allowed ids for a resource type and whether filtering is required.
func ResourceIDs(principal Principal, resourceType string) ([]string, bool) {
	if !IsResourceRestricted(principal) {
		return nil, false
	}
	ids := make([]string, 0)
	for _, grant := range principal.ResourceGrants {
		if grant.ResourceType == resourceType {
			ids = append(ids, grant.ResourceID)
		}
	}
	return ids, true
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
			if principal.Type == PrincipalTypeUser {
				return "", ErrTenantRequired
			}
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

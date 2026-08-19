package auth

import "errors"

// Sentinel errors for authentication and authorization.
var (
	ErrTokenMissing           = errors.New("auth token missing")
	ErrTokenInvalid           = errors.New("auth token invalid")
	ErrTokenExpired           = errors.New("auth token expired")
	ErrTokenRevoked           = errors.New("auth token revoked")
	ErrScopeDenied            = errors.New("scope denied")
	ErrTenantRequired         = errors.New("tenant selection required")
	ErrTenantForbidden        = errors.New("tenant selection forbidden")
	ErrTenantNotFound         = errors.New("tenant not found")
	ErrTenantDeleted          = errors.New("tenant deleted")
	ErrTokenNotFound          = errors.New("api token not found")
	ErrTokenNameConflict      = errors.New("api token name conflict")
	ErrBootstrapNotEmpty      = errors.New("bootstrap refused: api tokens already exist")
	ErrInvalidAuthority       = errors.New("invalid token authority")
	ErrInvalidScopes          = errors.New("invalid scopes")
	ErrTenantTokenCrossScope  = errors.New("tenant tokens cannot be system admin")
	ErrUserNotFound           = errors.New("user not found")
	ErrUserDisabled           = errors.New("user disabled")
	ErrUserEmailConflict      = errors.New("user email conflict")
	ErrMembershipNotFound     = errors.New("tenant membership not found")
	ErrOIDCProviderNotFound   = errors.New("oidc provider not found")
	ErrOIDCFlowInvalid        = errors.New("oidc flow invalid")
	ErrOIDCAuthentication     = errors.New("oidc authentication failed")
	ErrIdentityNotProvisioned = errors.New("user is not provisioned")
)

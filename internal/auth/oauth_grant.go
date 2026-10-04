package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/aperture/aperture/internal/db"
)

const (
	AuthMethodOAuth = "oauth"

	oauthAccessTokenPrefix  = "apo_"
	oauthRefreshTokenPrefix = "apr_"
	oauthCodePrefix         = "apc_"
	oauthClientSecretPrefix = "apcs_"

	oauthTokenKindAccess  = "access"
	oauthTokenKindRefresh = "refresh"

	// oauthGrantTouchInterval bounds how often authentication writes last_used_at.
	oauthGrantTouchInterval = time.Minute
)

// ErrOAuthGrantInvalid indicates a grant no longer authorizes anything, for
// example because the user lost every granted tenant.
var ErrOAuthGrantInvalid = errors.New("oauth grant no longer valid")

// ErrUserAccountRequired indicates a browser session without a user, such as
// an API-token login, tried to authorize or manage apps.
var ErrUserAccountRequired = errors.New("user account required")

// ErrOAuthGrantNotFound indicates the grant does not exist for the user.
var ErrOAuthGrantNotFound = errors.New("oauth grant not found")

// TenantAccess is one tenant a user can grant and the scopes they hold there.
type TenantAccess struct {
	Tenant db.Tenant
	Scopes []string
}

// UserOAuthGrant is an active grant with its client for display.
type UserOAuthGrant struct {
	Grant  db.OAuthGrant
	Client db.OAuthClient
	Scopes []string
}

var tenantScopes = []string{
	ScopeSessionsRead,
	ScopeSessionsWrite,
	ScopeSnapshotsRead,
	ScopeSnapshotsWrite,
	ScopeTenantWrite,
}

// TenantScopes returns every scope a tenant authority may hold.
func TenantScopes() []string {
	return slices.Clone(tenantScopes)
}

// AccessibleTenants returns the active tenants a user can act in, with the
// scopes they hold there. System administrators hold every tenant scope in
// every active tenant.
func (s *Service) AccessibleTenants(ctx context.Context, user *db.User) ([]TenantAccess, error) {
	if user.IsSystemAdmin {
		tenants, err := s.repo.ListTenants(ctx, db.TenantFilter{})
		if err != nil {
			return nil, err
		}
		result := make([]TenantAccess, 0, len(tenants))
		for _, tenant := range tenants {
			result = append(result, TenantAccess{Tenant: tenant, Scopes: TenantScopes()})
		}
		return result, nil
	}

	memberships, err := s.repo.ListUserMemberships(ctx, user.ID)
	if err != nil {
		return nil, err
	}
	scopesByTenant := make(map[string][]string, len(memberships))
	for _, membership := range memberships {
		scopes, err := ParseScopesJSON(membership.ScopesJSON)
		if err != nil {
			return nil, fmt.Errorf("parse membership scopes: %w", err)
		}
		scopesByTenant[membership.TenantID] = scopes
	}
	tenants, err := s.repo.ListUserTenants(ctx, user.ID)
	if err != nil {
		return nil, err
	}
	result := make([]TenantAccess, 0, len(tenants))
	for _, tenant := range tenants {
		result = append(result, TenantAccess{Tenant: tenant, Scopes: scopesByTenant[tenant.ID]})
	}
	return result, nil
}

// findOAuthToken returns the access or refresh token raw names, or nil when
// it is malformed, unknown, or its secret does not match.
func (s *Service) findOAuthToken(ctx context.Context, raw string) (*db.OAuthToken, error) {
	prefix, kind := oauthAccessTokenPrefix, oauthTokenKindAccess
	if strings.HasPrefix(raw, oauthRefreshTokenPrefix) {
		prefix, kind = oauthRefreshTokenPrefix, oauthTokenKindRefresh
	}
	tokenID, secret, ok := parseOAuthSecret(raw, prefix)
	if !ok {
		return nil, nil
	}
	token, err := s.repo.GetOAuthToken(ctx, tokenID)
	if err != nil {
		return nil, err
	}
	if token == nil || token.Kind != kind || !ConstantTimeEqual(token.TokenHash, hashOAuthSecret(secret)) {
		return nil, nil
	}
	return token, nil
}

func (s *Service) authenticateOAuthAccessToken(ctx context.Context, raw string) (Principal, error) {
	token, err := s.findOAuthToken(ctx, raw)
	if err != nil {
		return Principal{}, err
	}
	if token == nil || token.Kind != oauthTokenKindAccess {
		return Principal{}, ErrTokenInvalid
	}
	if IsRevoked(token.RevokedAt) {
		return Principal{}, ErrTokenRevoked
	}
	now := s.now().UTC()
	if IsExpired(&token.ExpiresAt, now) {
		return Principal{}, ErrTokenExpired
	}

	grant, err := s.repo.GetOAuthGrant(ctx, token.GrantID)
	if err != nil {
		return Principal{}, err
	}
	if grant == nil || IsRevoked(grant.RevokedAt) {
		return Principal{}, ErrTokenRevoked
	}
	principal, err := s.oauthGrantPrincipal(ctx, grant)
	if err != nil {
		return Principal{}, err
	}
	principal.ExpiresAt = &token.ExpiresAt

	if grantTouchDue(grant.LastUsedAt, now) {
		if err := s.repo.TouchOAuthGrant(ctx, grant.ID, now.Format(time.RFC3339Nano)); err != nil {
			return Principal{}, err
		}
	}
	return principal, nil
}

func grantTouchDue(lastUsedAt *string, now time.Time) bool {
	if lastUsedAt == nil {
		return true
	}
	parsed, err := time.Parse(time.RFC3339Nano, *lastUsedAt)
	return err != nil || now.Sub(parsed) >= oauthGrantTouchInterval
}

// oauthGrantPrincipal resolves a grant against the user's current authority,
// so disabling the user or removing a membership takes effect immediately.
func (s *Service) oauthGrantPrincipal(ctx context.Context, grant *db.OAuthGrant) (Principal, error) {
	user, err := s.GetUser(ctx, grant.UserID)
	if err != nil {
		if errors.Is(err, ErrUserNotFound) {
			return Principal{}, ErrOAuthGrantInvalid
		}
		return Principal{}, err
	}
	if user.DisabledAt != nil {
		return Principal{}, ErrUserDisabled
	}
	client, err := s.repo.GetOAuthClient(ctx, grant.ClientID)
	if err != nil {
		return Principal{}, err
	}
	if client == nil {
		return Principal{}, ErrOAuthGrantInvalid
	}
	scopes, err := ParseScopesJSON(grant.ScopesJSON)
	if err != nil {
		return Principal{}, fmt.Errorf("parse oauth grant scopes: %w", err)
	}

	principal := Principal{
		Type:         PrincipalTypeUser,
		ID:           user.ID,
		AuthMethod:   AuthMethodOAuth,
		OAuthGrantID: grant.ID,
		UserID:       &user.ID,
		Name:         client.ClientName,
		ResourceMode: grant.ResourceMode,
	}
	for _, resource := range grant.ResourceGrants {
		principal.ResourceGrants = append(principal.ResourceGrants, ResourceGrant{ResourceType: resource.ResourceType, ResourceID: resource.ResourceID})
	}

	switch grant.AuthorityType {
	case AuthoritySystemAdmin:
		if !user.IsSystemAdmin {
			return Principal{}, ErrOAuthGrantInvalid
		}
		principal.AuthorityType = AuthoritySystemAdmin
		principal.Scopes = []string{ScopeSystemAdmin}
		return principal, nil
	case AuthorityTenant:
		accessible, err := s.AccessibleTenants(ctx, user)
		if err != nil {
			return Principal{}, err
		}
		for _, access := range accessible {
			if !slices.Contains(grant.TenantIDs, access.Tenant.ID) {
				continue
			}
			effective := make([]string, 0, len(scopes))
			for _, scope := range scopes {
				if slices.Contains(access.Scopes, scope) {
					effective = append(effective, scope)
				}
			}
			if len(effective) > 0 {
				principal.TenantGrants = append(principal.TenantGrants, TenantGrant{TenantID: access.Tenant.ID, Scopes: effective})
			}
		}
		if len(principal.TenantGrants) == 0 {
			return Principal{}, ErrOAuthGrantInvalid
		}
		principal.AuthorityType = AuthorityTenant
		principal.Scopes = []string{}
		if len(principal.TenantGrants) == 1 {
			return SelectTenant(principal, "")
		}
		return principal, nil
	default:
		return Principal{}, ErrInvalidAuthority
	}
}

// ListUserOAuthGrants returns a user's active grants with their clients.
func (s *Service) ListUserOAuthGrants(ctx context.Context, userID string) ([]UserOAuthGrant, error) {
	grants, err := s.repo.ListActiveOAuthGrantsByUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	clientIDs := make([]string, 0, len(grants))
	for _, grant := range grants {
		clientIDs = append(clientIDs, grant.ClientID)
	}
	clients, err := s.repo.ListOAuthClients(ctx, clientIDs)
	if err != nil {
		return nil, err
	}
	result := make([]UserOAuthGrant, 0, len(grants))
	for _, grant := range grants {
		scopes, err := ParseScopesJSON(grant.ScopesJSON)
		if err != nil {
			return nil, fmt.Errorf("parse oauth grant scopes: %w", err)
		}
		result = append(result, UserOAuthGrant{Grant: grant, Client: clients[grant.ClientID], Scopes: scopes})
	}
	return result, nil
}

// RevokeUserOAuthGrant revokes one of the user's grants and all its tokens.
func (s *Service) RevokeUserOAuthGrant(ctx context.Context, userID, grantID string) error {
	grant, err := s.repo.GetOAuthGrant(ctx, grantID)
	if err != nil {
		return err
	}
	if grant == nil || grant.UserID != userID {
		return ErrOAuthGrantNotFound
	}
	return s.revokeOAuthGrant(ctx, Principal{Type: PrincipalTypeUser, ID: userID, UserID: &userID}, grant, "user")
}

func (s *Service) revokeOAuthGrant(ctx context.Context, actor Principal, grant *db.OAuthGrant, reason string) error {
	if IsRevoked(grant.RevokedAt) {
		return nil
	}
	audit, err := s.newAuditEvent(actor, AuditInput{
		Action:       "oauth_grant.revoked",
		ResourceType: "oauth_grant",
		ResourceID:   &grant.ID,
		Data:         map[string]any{"clientId": grant.ClientID, "userId": grant.UserID, "reason": reason},
	})
	if err != nil {
		return err
	}
	err = s.repo.RevokeOAuthGrant(ctx, grant.ID, db.NowUTC(), audit)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	return nil
}

func oauthUserActor(userID string) Principal {
	return Principal{Type: PrincipalTypeUser, ID: userID, UserID: &userID, AuthMethod: AuthMethodOAuth}
}

// generateOAuthSecret creates <prefix><id>_<secret> and the SHA-256 hash of
// the secret. The secret has 256 bits of entropy, so a fast hash suffices.
func generateOAuthSecret(prefix, id string) (raw string, hash string, err error) {
	secretBytes := make([]byte, tokenSecretBytes)
	if _, err := rand.Read(secretBytes); err != nil {
		return "", "", fmt.Errorf("generate oauth secret: %w", err)
	}
	secret := base64.RawURLEncoding.EncodeToString(secretBytes)
	return prefix + id + "_" + secret, hashOAuthSecret(secret), nil
}

func parseOAuthSecret(raw, prefix string) (id string, secret string, ok bool) {
	rest, found := strings.CutPrefix(strings.TrimSpace(raw), prefix)
	if !found {
		return "", "", false
	}
	id, secret, found = strings.Cut(rest, "_")
	if !found || id == "" || secret == "" {
		return "", "", false
	}
	return id, secret, true
}

func hashOAuthSecret(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}

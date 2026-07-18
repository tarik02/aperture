package auth

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/aperture/aperture/internal/db"
	"github.com/aperture/aperture/internal/ids"
)

// Service provides authentication and tenant/token administration.
type Service struct {
	repo *db.Repository
	now  func() time.Time
}

// NewService constructs an auth service.
func NewService(repo *db.Repository) *Service {
	return &Service{
		repo: repo,
		now:  time.Now,
	}
}

// CreatedToken is returned once when a token is created.
type CreatedToken struct {
	Raw   string
	Token db.APIToken
}

// BootstrapInput configures initial system-admin bootstrap.
type BootstrapInput struct {
	Name      string
	ExpiresAt *time.Time
}

// CreateTokenInput configures API token creation.
type CreateTokenInput struct {
	AuthorityType string
	TenantID      *string
	Name          string
	Scopes        []string
	ExpiresAt     *time.Time
}

// CreateTenantInput configures tenant creation.
type CreateTenantInput struct {
	DisplayName string
}

// UpdateTenantInput configures tenant metadata updates.
type UpdateTenantInput struct {
	DisplayName string
}

// Authenticate validates a raw apt_ token and returns the principal.
func (s *Service) Authenticate(ctx context.Context, rawToken string) (Principal, error) {
	rawToken = strings.TrimSpace(rawToken)
	if rawToken == "" {
		return Principal{}, ErrTokenMissing
	}

	tokenID, secret, err := ParseRawToken(rawToken)
	if err != nil {
		return Principal{}, ErrTokenInvalid
	}

	row, err := s.repo.GetAPITokenByID(ctx, tokenID)
	if err != nil {
		return Principal{}, fmt.Errorf("load api token: %w", err)
	}
	if row == nil {
		return Principal{}, ErrTokenInvalid
	}

	if !VerifySecret(row.TokenHash, secret) {
		return Principal{}, ErrTokenInvalid
	}

	now := s.now().UTC()
	if IsRevoked(row.RevokedAt) {
		return Principal{}, ErrTokenRevoked
	}
	if IsExpired(row.ExpiresAt, now) {
		return Principal{}, ErrTokenExpired
	}

	scopes, err := ParseScopesJSON(row.ScopesJSON)
	if err != nil {
		return Principal{}, fmt.Errorf("parse token scopes: %w", err)
	}

	return Principal{
		Type:          PrincipalTypeAPIToken,
		ID:            row.ID,
		AuthMethod:    AuthMethodAPIToken,
		TokenID:       row.ID,
		AuthorityType: row.AuthorityType,
		TenantID:      row.TenantID,
		Name:          row.Name,
		Scopes:        scopes,
		ExpiresAt:     row.ExpiresAt,
	}, nil
}

// Bootstrap creates the first system-admin token when the database has none.
func (s *Service) Bootstrap(ctx context.Context, input BootstrapInput) (CreatedToken, error) {
	name := strings.TrimSpace(input.Name)
	if name == "" {
		name = "bootstrap"
	}

	if err := ValidateScopes(AuthoritySystemAdmin, []string{ScopeSystemAdmin}); err != nil {
		return CreatedToken{}, err
	}

	tokenID, err := ids.NewUUIDv7()
	if err != nil {
		return CreatedToken{}, err
	}

	raw, hash, err := GenerateRawToken(tokenID)
	if err != nil {
		return CreatedToken{}, err
	}

	scopesJSON, err := MarshalScopesJSON([]string{ScopeSystemAdmin})
	if err != nil {
		return CreatedToken{}, err
	}

	row := &db.APIToken{
		ID:            tokenID,
		AuthorityType: AuthoritySystemAdmin,
		Name:          name,
		TokenHash:     hash,
		ScopesJSON:    scopesJSON,
		CreatedAt:     db.NowUTC(),
		CreatedByType: PrincipalTypeSystem,
		ExpiresAt:     FormatExpiresAt(input.ExpiresAt),
	}

	audit, err := s.newAuditEvent(Principal{Type: PrincipalTypeSystem}, AuditInput{
		Action:       "token.created",
		ResourceType: "api_token",
		ResourceID:   &row.ID,
		Data:         map[string]any{"authorityType": row.AuthorityType, "parentTokenId": nil},
	})
	if err != nil {
		return CreatedToken{}, err
	}
	if err := s.repo.CreateBootstrapAPIToken(ctx, row, audit); err != nil {
		if errors.Is(err, db.ErrBootstrapNotEmpty) {
			return CreatedToken{}, ErrBootstrapNotEmpty
		}
		if isUniqueViolation(err) {
			return CreatedToken{}, ErrTokenNameConflict
		}
		return CreatedToken{}, err
	}

	return CreatedToken{Raw: raw, Token: *row}, nil
}

// CreateTenant creates a new tenant.
func (s *Service) CreateTenant(ctx context.Context, input CreateTenantInput) (*db.Tenant, error) {
	displayName := strings.TrimSpace(input.DisplayName)
	if displayName == "" {
		return nil, fmt.Errorf("display name is required")
	}

	tenantID, err := ids.NewUUIDv7()
	if err != nil {
		return nil, err
	}

	tenant := &db.Tenant{
		ID:          tenantID,
		DisplayName: displayName,
		CreatedAt:   db.NowUTC(),
	}

	if err := s.repo.CreateTenant(ctx, tenant); err != nil {
		return nil, err
	}
	return tenant, nil
}

// ListTenants returns tenants for administration.
func (s *Service) ListTenants(ctx context.Context, includeDeleted bool) ([]db.Tenant, error) {
	return s.repo.ListTenants(ctx, db.TenantFilter{IncludeDeleted: includeDeleted})
}

// ListTenantsPage returns tenants with cursor pagination.
func (s *Service) ListTenantsPage(ctx context.Context, filter db.TenantFilter, params db.PageParams) (db.PageResult[db.Tenant], error) {
	return s.repo.ListTenantsPage(ctx, filter, params)
}

// UpdateTenant updates tenant metadata for active tenants.
func (s *Service) UpdateTenant(ctx context.Context, tenantID string, input UpdateTenantInput) (*db.Tenant, error) {
	displayName := strings.TrimSpace(input.DisplayName)
	if displayName == "" {
		return nil, fmt.Errorf("display name is required")
	}

	tenant, err := s.requireActiveTenant(ctx, tenantID)
	if err != nil {
		return nil, err
	}

	if err := s.repo.UpdateTenantDisplayName(ctx, tenantID, displayName); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrTenantNotFound
		}
		return nil, err
	}

	tenant.DisplayName = displayName
	return tenant, nil
}

// DeleteTenant deactivates a tenant and revokes tenant-scoped tokens.
func (s *Service) DeleteTenant(ctx context.Context, tenantID string) (*db.Tenant, error) {
	tenant, err := s.repo.GetTenantByID(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	if tenant == nil {
		return nil, ErrTenantNotFound
	}
	if tenant.DeletedAt != nil {
		return tenant, nil
	}

	deletedAt := db.NowUTC()
	if err := s.repo.DeactivateTenant(ctx, tenantID, deletedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrTenantNotFound
		}
		return nil, err
	}

	tenant.DeletedAt = &deletedAt
	return tenant, nil
}

// RestoreTenant clears tenant deactivation.
func (s *Service) RestoreTenant(ctx context.Context, tenantID string) (*db.Tenant, error) {
	if err := s.repo.RestoreTenant(ctx, tenantID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrTenantNotFound
		}
		return nil, err
	}

	tenant, err := s.repo.GetTenantByID(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	if tenant == nil {
		return nil, ErrTenantNotFound
	}
	return tenant, nil
}

// CreateToken creates a token as the trusted local system actor.
func (s *Service) CreateToken(ctx context.Context, input CreateTokenInput) (CreatedToken, error) {
	validated, err := s.validateCreateTokenInput(ctx, input)
	if err != nil {
		return CreatedToken{}, err
	}
	return s.createToken(ctx, Principal{Type: PrincipalTypeSystem}, validated)
}

// DelegateToken creates a token within the authenticated principal's authority.
func (s *Service) DelegateToken(ctx context.Context, principal Principal, input CreateTokenInput) (CreatedToken, error) {
	validated, err := s.validateCreateTokenInput(ctx, input)
	if err != nil {
		return CreatedToken{}, err
	}
	if err := validateTokenDelegation(principal, validated); err != nil {
		return CreatedToken{}, err
	}
	return s.createToken(ctx, principal, validated)
}

func (s *Service) validateCreateTokenInput(ctx context.Context, input CreateTokenInput) (CreateTokenInput, error) {
	if err := ValidateScopes(input.AuthorityType, input.Scopes); err != nil {
		return CreateTokenInput{}, err
	}

	input.Name = strings.TrimSpace(input.Name)
	if input.Name == "" {
		return CreateTokenInput{}, fmt.Errorf("token name is required")
	}

	switch input.AuthorityType {
	case AuthoritySystemAdmin:
		if input.TenantID != nil {
			return CreateTokenInput{}, ErrInvalidAuthority
		}
	case AuthorityTenant:
		if input.TenantID == nil || strings.TrimSpace(*input.TenantID) == "" {
			return CreateTokenInput{}, ErrTenantRequired
		}
		tenantID := strings.TrimSpace(*input.TenantID)
		if _, err := s.requireActiveTenant(ctx, tenantID); err != nil {
			return CreateTokenInput{}, err
		}
		input.TenantID = &tenantID
	default:
		return CreateTokenInput{}, ErrInvalidAuthority
	}

	return input, nil
}

// RevokeToken revokes a token as the trusted local system actor.
func (s *Service) RevokeToken(ctx context.Context, tokenID string, tenantID *string) error {
	return s.revokeToken(ctx, Principal{Type: PrincipalTypeSystem}, tokenID, tenantID)
}

// RevokeTokenAs revokes a token and records the authenticated actor.
func (s *Service) RevokeTokenAs(ctx context.Context, principal Principal, tokenID string, tenantID *string) error {
	return s.revokeToken(ctx, principal, tokenID, tenantID)
}

func (s *Service) revokeToken(ctx context.Context, principal Principal, tokenID string, tenantID *string) error {
	row, err := s.repo.GetAPITokenByID(ctx, tokenID)
	if err != nil {
		return err
	}
	if row == nil {
		return ErrTokenNotFound
	}

	if tenantID != nil {
		if row.TenantID == nil || *row.TenantID != *tenantID {
			return ErrTokenNotFound
		}
	}

	if row.RevokedAt != nil {
		return nil
	}

	audit, err := s.newAuditEvent(principal, AuditInput{
		TenantID:     row.TenantID,
		Action:       "token.revoked",
		ResourceType: "api_token",
		ResourceID:   &row.ID,
	})
	if err != nil {
		return err
	}
	if err := s.repo.RevokeAPIToken(ctx, tokenID, db.NowUTC(), audit); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrTokenNotFound
		}
		return err
	}
	return nil
}

// ListTokens returns API tokens, optionally scoped to a tenant.
func (s *Service) ListTokens(ctx context.Context, tenantID *string) ([]db.APIToken, error) {
	return s.repo.ListAPITokens(ctx, tenantID)
}

// ListTokensPage returns API tokens with cursor pagination.
func (s *Service) ListTokensPage(ctx context.Context, filter db.APITokenFilter, params db.PageParams) (db.PageResult[db.APIToken], error) {
	return s.repo.ListAPITokensPage(ctx, filter, params)
}

// GetTenant returns a tenant by id, including deactivated tenants.
func (s *Service) GetTenant(ctx context.Context, tenantID string) (*db.Tenant, error) {
	tenant, err := s.repo.GetTenantByID(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	if tenant == nil {
		return nil, ErrTenantNotFound
	}
	return tenant, nil
}

// RequireActiveTenant loads a tenant and rejects deleted tenants.
func (s *Service) RequireActiveTenant(ctx context.Context, tenantID string) (*db.Tenant, error) {
	return s.requireActiveTenant(ctx, tenantID)
}

func (s *Service) requireActiveTenant(ctx context.Context, tenantID string) (*db.Tenant, error) {
	tenant, err := s.repo.GetTenantByID(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	if tenant == nil {
		return nil, ErrTenantNotFound
	}
	if tenant.DeletedAt != nil {
		return nil, ErrTenantDeleted
	}
	return tenant, nil
}

func (s *Service) createToken(ctx context.Context, principal Principal, input CreateTokenInput) (CreatedToken, error) {
	tokenID, err := ids.NewUUIDv7()
	if err != nil {
		return CreatedToken{}, err
	}

	raw, hash, err := GenerateRawToken(tokenID)
	if err != nil {
		return CreatedToken{}, err
	}

	scopesJSON, err := MarshalScopesJSON(input.Scopes)
	if err != nil {
		return CreatedToken{}, err
	}

	var createdByID *string
	if principal.ID != "" {
		value := principal.ID
		createdByID = &value
	}
	var parentTokenID *string
	if principal.TokenID != "" {
		value := principal.TokenID
		parentTokenID = &value
	}
	row := &db.APIToken{
		ID:            tokenID,
		AuthorityType: input.AuthorityType,
		TenantID:      input.TenantID,
		Name:          input.Name,
		TokenHash:     hash,
		ScopesJSON:    scopesJSON,
		CreatedAt:     db.NowUTC(),
		CreatedByType: principal.Type,
		CreatedByID:   createdByID,
		ParentTokenID: parentTokenID,
		ExpiresAt:     FormatExpiresAt(input.ExpiresAt),
	}

	audit, err := s.newAuditEvent(principal, AuditInput{
		TenantID:     row.TenantID,
		Action:       "token.created",
		ResourceType: "api_token",
		ResourceID:   &row.ID,
		Data:         map[string]any{"authorityType": row.AuthorityType, "parentTokenId": row.ParentTokenID},
	})
	if err != nil {
		return CreatedToken{}, err
	}
	if err := s.repo.CreateAPIToken(ctx, row, audit); err != nil {
		if isUniqueViolation(err) {
			return CreatedToken{}, ErrTokenNameConflict
		}
		return CreatedToken{}, err
	}

	return CreatedToken{Raw: raw, Token: *row}, nil
}

func validateTokenDelegation(principal Principal, input CreateTokenInput) error {
	switch principal.AuthorityType {
	case AuthoritySystemAdmin:
		if !HasScope(principal.Scopes, ScopeSystemAdmin) {
			return ErrTokenDelegation
		}
	case AuthorityTenant:
		if input.AuthorityType != AuthorityTenant || principal.TenantID == nil || input.TenantID == nil || *principal.TenantID != *input.TenantID {
			return ErrTokenDelegation
		}
		if !HasScope(principal.Scopes, ScopeTenantWrite) {
			return ErrScopeDenied
		}
	default:
		return ErrTokenDelegation
	}

	if !HasScope(principal.Scopes, ScopeSystemAdmin) {
		for _, scope := range input.Scopes {
			if !slices.Contains(principal.Scopes, scope) {
				return ErrTokenDelegation
			}
		}
	}
	if principal.Type == PrincipalTypeAPIToken && principal.ExpiresAt != nil {
		parentExpiry, err := time.Parse(time.RFC3339Nano, *principal.ExpiresAt)
		if err != nil || input.ExpiresAt == nil || input.ExpiresAt.UTC().After(parentExpiry) {
			return ErrTokenDelegation
		}
	}
	return nil
}

func isUniqueViolation(err error) bool {
	return err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed")
}

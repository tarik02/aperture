package auth

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
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
		TokenID:       row.ID,
		AuthorityType: row.AuthorityType,
		TenantID:      row.TenantID,
		Name:          row.Name,
		Scopes:        scopes,
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
		ExpiresAt:     FormatExpiresAt(input.ExpiresAt),
	}

	if err := s.repo.CreateBootstrapAPIToken(ctx, row); err != nil {
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

// CreateToken creates an API token and returns the raw value once.
func (s *Service) CreateToken(ctx context.Context, input CreateTokenInput) (CreatedToken, error) {
	if err := ValidateScopes(input.AuthorityType, input.Scopes); err != nil {
		return CreatedToken{}, err
	}

	name := strings.TrimSpace(input.Name)
	if name == "" {
		return CreatedToken{}, fmt.Errorf("token name is required")
	}

	switch input.AuthorityType {
	case AuthoritySystemAdmin:
		if input.TenantID != nil {
			return CreatedToken{}, ErrInvalidAuthority
		}
	case AuthorityTenant:
		if input.TenantID == nil || strings.TrimSpace(*input.TenantID) == "" {
			return CreatedToken{}, ErrTenantRequired
		}
		if _, err := s.requireActiveTenant(ctx, *input.TenantID); err != nil {
			return CreatedToken{}, err
		}
	default:
		return CreatedToken{}, ErrInvalidAuthority
	}

	return s.createToken(ctx, input)
}

// RevokeToken revokes an API token, optionally enforcing tenant ownership.
func (s *Service) RevokeToken(ctx context.Context, tokenID string, tenantID *string) error {
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

	if err := s.repo.RevokeAPIToken(ctx, tokenID, db.NowUTC()); err != nil {
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

func (s *Service) createToken(ctx context.Context, input CreateTokenInput) (CreatedToken, error) {
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

	row := &db.APIToken{
		ID:            tokenID,
		AuthorityType: input.AuthorityType,
		TenantID:      input.TenantID,
		Name:          strings.TrimSpace(input.Name),
		TokenHash:     hash,
		ScopesJSON:    scopesJSON,
		CreatedAt:     db.NowUTC(),
		ExpiresAt:     FormatExpiresAt(input.ExpiresAt),
	}

	if err := s.repo.CreateAPIToken(ctx, row); err != nil {
		if isUniqueViolation(err) {
			return CreatedToken{}, ErrTokenNameConflict
		}
		return CreatedToken{}, err
	}

	return CreatedToken{Raw: raw, Token: *row}, nil
}

func isUniqueViolation(err error) bool {
	return err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed")
}

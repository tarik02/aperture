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
	AuthorityType  string
	TenantID       *string
	Name           string
	Scopes         []string
	ResourceMode   string
	ResourceGrants []ResourceGrant
	ExpiresAt      *time.Time
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
	storedGrants, err := s.repo.ListAPITokenResourceGrants(ctx, []string{row.ID})
	if err != nil {
		return Principal{}, err
	}
	resourceGrants := make([]ResourceGrant, 0, len(storedGrants[row.ID]))
	for _, grant := range storedGrants[row.ID] {
		resourceGrants = append(resourceGrants, ResourceGrant{ResourceType: grant.ResourceType, ResourceID: grant.ResourceID})
	}

	return Principal{
		Type:           PrincipalTypeAPIToken,
		ID:             row.ID,
		AuthMethod:     AuthMethodAPIToken,
		TokenID:        row.ID,
		AuthorityType:  row.AuthorityType,
		TenantID:       row.TenantID,
		Name:           row.Name,
		Scopes:         scopes,
		ResourceMode:   row.ResourceMode,
		ResourceGrants: resourceGrants,
		ExpiresAt:      row.ExpiresAt,
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
		ResourceMode:  ResourceModeAll,
		ExpiresAt:     FormatExpiresAt(input.ExpiresAt),
	}

	audit, err := s.newAuditEvent(Principal{Type: PrincipalTypeSystem}, AuditInput{
		Action:       "token.created",
		ResourceType: "api_token",
		ResourceID:   &row.ID,
		Data:         map[string]any{"authorityType": row.AuthorityType, "parentTokenId": nil, "resourceMode": row.ResourceMode, "resourceGrantCount": 0},
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

	if input.ResourceMode == "" {
		input.ResourceMode = ResourceModeAll
	}
	switch input.ResourceMode {
	case ResourceModeAll:
		if len(input.ResourceGrants) != 0 {
			return CreateTokenInput{}, ErrInvalidResourceScope
		}
	case ResourceModeAllowlist:
		if input.AuthorityType != AuthorityTenant || input.TenantID == nil {
			return CreateTokenInput{}, ErrInvalidResourceScope
		}
		seen := make(map[string]struct{}, len(input.ResourceGrants))
		grants := make([]ResourceGrant, 0, len(input.ResourceGrants))
		for _, grant := range input.ResourceGrants {
			if grant.ResourceType != ResourceTypeSession && grant.ResourceType != ResourceTypeSnapshot {
				return CreateTokenInput{}, ErrInvalidResourceScope
			}
			if err := ids.ValidateUUIDv7(grant.ResourceID); err != nil {
				return CreateTokenInput{}, ErrInvalidResourceScope
			}
			key := grant.ResourceType + "\x00" + grant.ResourceID
			if _, ok := seen[key]; ok {
				return CreateTokenInput{}, ErrInvalidResourceScope
			}
			seen[key] = struct{}{}

			switch grant.ResourceType {
			case ResourceTypeSession:
				row, err := s.repo.GetSessionByTenantAndID(ctx, *input.TenantID, grant.ResourceID)
				if err != nil {
					return CreateTokenInput{}, err
				}
				if row == nil {
					return CreateTokenInput{}, ErrInvalidResourceScope
				}
			case ResourceTypeSnapshot:
				row, err := s.repo.GetSnapshotByID(ctx, grant.ResourceID)
				if err != nil {
					return CreateTokenInput{}, err
				}
				if row == nil || row.TenantID != *input.TenantID {
					return CreateTokenInput{}, ErrInvalidResourceScope
				}
			}
			grants = append(grants, grant)
		}
		slices.SortFunc(grants, func(a, b ResourceGrant) int {
			if order := strings.Compare(a.ResourceType, b.ResourceType); order != 0 {
				return order
			}
			return strings.Compare(a.ResourceID, b.ResourceID)
		})
		input.ResourceGrants = grants
	default:
		return CreateTokenInput{}, ErrInvalidResourceScope
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
	tokens, err := s.repo.ListAPITokens(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	if err := s.populateTokenResourceGrants(ctx, tokens); err != nil {
		return nil, err
	}
	return tokens, nil
}

// ListTokensPage returns API tokens with cursor pagination.
func (s *Service) ListTokensPage(ctx context.Context, filter db.APITokenFilter, params db.PageParams) (db.PageResult[db.APIToken], error) {
	page, err := s.repo.ListAPITokensPage(ctx, filter, params)
	if err != nil {
		return db.PageResult[db.APIToken]{}, err
	}
	if err := s.populateTokenResourceGrants(ctx, page.Items); err != nil {
		return db.PageResult[db.APIToken]{}, err
	}
	return page, nil
}

func (s *Service) populateTokenResourceGrants(ctx context.Context, tokens []db.APIToken) error {
	tokenIDs := make([]string, 0, len(tokens))
	for _, token := range tokens {
		tokenIDs = append(tokenIDs, token.ID)
	}
	grants, err := s.repo.ListAPITokenResourceGrants(ctx, tokenIDs)
	if err != nil {
		return err
	}
	for i := range tokens {
		tokens[i].ResourceGrants = grants[tokens[i].ID]
	}
	return nil
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

// AuthorizeSnapshotName checks a restricted principal's grant for a tenant snapshot name.
func (s *Service) AuthorizeSnapshotName(ctx context.Context, principal Principal, tenantID, name string) error {
	if !IsResourceRestricted(principal) {
		return nil
	}
	row, err := s.repo.GetSnapshotByTenantAndName(ctx, tenantID, name)
	if err != nil {
		return err
	}
	if row == nil || !HasResourceAccess(principal, ResourceTypeSnapshot, row.ID) {
		return ErrResourceAccessDenied
	}
	return nil
}

// AuthorizeSnapshotNameIfExists checks a restricted principal's grant when a tenant snapshot name is already in use.
func (s *Service) AuthorizeSnapshotNameIfExists(ctx context.Context, principal Principal, tenantID, name string) error {
	if !IsResourceRestricted(principal) {
		return nil
	}
	row, err := s.repo.GetSnapshotByTenantAndName(ctx, tenantID, name)
	if err != nil {
		return err
	}
	if row != nil && !HasResourceAccess(principal, ResourceTypeSnapshot, row.ID) {
		return ErrResourceAccessDenied
	}
	return nil
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
		ID:             tokenID,
		AuthorityType:  input.AuthorityType,
		TenantID:       input.TenantID,
		Name:           input.Name,
		TokenHash:      hash,
		ScopesJSON:     scopesJSON,
		CreatedAt:      db.NowUTC(),
		CreatedByType:  principal.Type,
		CreatedByID:    createdByID,
		ParentTokenID:  parentTokenID,
		ResourceMode:   input.ResourceMode,
		ExpiresAt:      FormatExpiresAt(input.ExpiresAt),
		ResourceGrants: make([]db.APITokenResourceGrant, 0, len(input.ResourceGrants)),
	}
	for _, grant := range input.ResourceGrants {
		row.ResourceGrants = append(row.ResourceGrants, db.APITokenResourceGrant{
			TokenID:      tokenID,
			ResourceType: grant.ResourceType,
			ResourceID:   grant.ResourceID,
		})
	}

	audit, err := s.newAuditEvent(principal, AuditInput{
		TenantID:     row.TenantID,
		Action:       "token.created",
		ResourceType: "api_token",
		ResourceID:   &row.ID,
		Data:         map[string]any{"authorityType": row.AuthorityType, "parentTokenId": row.ParentTokenID, "resourceMode": row.ResourceMode, "resourceGrantCount": len(row.ResourceGrants)},
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
	if IsResourceRestricted(principal) {
		if input.ResourceMode != ResourceModeAllowlist {
			return ErrTokenDelegation
		}
		for _, grant := range input.ResourceGrants {
			if !HasResourceAccess(principal, grant.ResourceType, grant.ResourceID) {
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

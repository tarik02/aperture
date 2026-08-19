package auth

import (
	"context"

	"github.com/aperture/aperture/internal/db"
)

const AuthMethodOIDC = "oidc"

// AuthenticateUser resolves an active user's authority for an optional tenant selection.
func (s *Service) AuthenticateUser(ctx context.Context, userID, selectedTenantID, authMethod string) (Principal, error) {
	user, err := s.GetUser(ctx, userID)
	if err != nil {
		return Principal{}, err
	}
	if user.DisabledAt != nil {
		return Principal{}, ErrUserDisabled
	}

	principal := Principal{
		Type:       PrincipalTypeUser,
		ID:         user.ID,
		AuthMethod: authMethod,
		UserID:     &user.ID,
		Name:       user.DisplayName,
	}
	if user.IsSystemAdmin {
		principal.AuthorityType = AuthoritySystemAdmin
		principal.Scopes = []string{ScopeSystemAdmin}
		return principal, nil
	}

	memberships, err := s.repo.ListUserMemberships(ctx, user.ID)
	if err != nil {
		return Principal{}, err
	}
	if selectedTenantID == "" && len(memberships) == 1 {
		selectedTenantID = memberships[0].TenantID
	}
	principal.AuthorityType = AuthorityTenant
	if selectedTenantID == "" {
		principal.Scopes = []string{}
		return principal, nil
	}

	for _, membership := range memberships {
		if membership.TenantID != selectedTenantID {
			continue
		}
		if _, err := s.requireActiveTenant(ctx, selectedTenantID); err != nil {
			return Principal{}, err
		}
		scopes, err := ParseScopesJSON(membership.ScopesJSON)
		if err != nil {
			return Principal{}, err
		}
		principal.TenantID = &membership.TenantID
		principal.Scopes = scopes
		return principal, nil
	}
	return Principal{}, ErrTenantForbidden
}

// UserTenants returns active tenants visible to a user.
func (s *Service) UserTenants(ctx context.Context, userID string) ([]db.Tenant, error) {
	user, err := s.GetUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	if user.IsSystemAdmin {
		return nil, nil
	}
	return s.repo.ListUserTenants(ctx, userID)
}

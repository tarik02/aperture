package auth

import (
	"context"

	"github.com/aperture/aperture/internal/db"
)

// CanSeeTenant reports whether a principal may see or act in a tenant. A
// shared tenant is open to whatever authority the principal holds; a personal
// tenant only to its owner, to credentials bound to it, and to the local
// system. System administration grants no access to other users' personal
// tenants.
func CanSeeTenant(principal Principal, tenant db.Tenant) bool {
	if tenant.OwnerUserID == nil {
		return true
	}
	switch {
	case principal.Type == PrincipalTypeSystem:
		return true
	case principal.UserID != nil && *principal.UserID == *tenant.OwnerUserID:
		return true
	case principal.AuthorityType == AuthorityTenant && principal.TenantID != nil && *principal.TenantID == tenant.ID:
		return true
	default:
		return false
	}
}

// personalTenantScopeFor limits a listing to the tenants CanSeeTenant allows.
// A tenant-bound principal is confined to its tenant by the caller already.
func personalTenantScopeFor(principal Principal) db.PersonalTenantScope {
	if principal.Type == PrincipalTypeSystem || principal.AuthorityType == AuthorityTenant {
		return db.PersonalTenantScope{}
	}
	return db.PersonalTenantScope{Restricted: true, OwnerUserID: principal.UserID}
}

// authorizeTenant rejects a tenant the principal may not see with
// ErrTenantNotFound, so its existence stays hidden. A tenant that does not
// exist passes; the operation reports it in its own terms.
func (s *Service) authorizeTenant(ctx context.Context, principal Principal, tenantID string) error {
	tenant, err := s.repo.GetTenantByID(ctx, tenantID)
	if err != nil {
		return err
	}
	if tenant != nil && !CanSeeTenant(principal, *tenant) {
		return ErrTenantNotFound
	}
	return nil
}

// ResolveTenantID returns the effective tenant id for a tenant-scoped
// operation, like resolveTenantID, and rejects a selected
// tenant the principal may not see.
func (s *Service) ResolveTenantID(ctx context.Context, principal Principal, selectedTenantID string) (string, error) {
	tenantID, err := resolveTenantID(principal, selectedTenantID)
	if err != nil {
		return "", err
	}
	if principal.AuthorityType == AuthoritySystemAdmin {
		if err := s.authorizeTenant(ctx, principal, tenantID); err != nil {
			return "", err
		}
	}
	return tenantID, nil
}

// HasPersonalTenant reports whether a user owns an active personal tenant.
func (s *Service) HasPersonalTenant(ctx context.Context, userID string) (bool, error) {
	tenant, err := s.repo.GetPersonalTenant(ctx, userID)
	if err != nil {
		return false, err
	}
	return tenant != nil, nil
}

// DeletePersonalTenant deactivates a user's active personal tenant.
func (s *Service) DeletePersonalTenant(ctx context.Context, userID string) (*db.Tenant, error) {
	if _, err := s.GetUser(ctx, userID); err != nil {
		return nil, err
	}
	tenant, err := s.repo.GetPersonalTenant(ctx, userID)
	if err != nil {
		return nil, err
	}
	if tenant == nil {
		return nil, ErrPersonalTenantNotFound
	}
	return s.DeleteTenant(ctx, SystemPrincipal(), tenant.ID)
}

// PersonalTenantAudit describes a change to a user's personal tenant. It names
// the user, not the tenant, so administrators see that it happened and
// nothing about the tenant itself.
func PersonalTenantAudit(userID string, action string) AuditInput {
	return AuditInput{
		Action:       "user.personal_tenant_" + action,
		ResourceType: "user",
		ResourceID:   &userID,
	}
}
